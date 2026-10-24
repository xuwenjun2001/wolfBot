import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { attributeResearchTask, renderResearchAttributionMarkdown, summarizeResearchAttribution, type ResearchTaskAttribution } from '../../src/lib/eval/research-failure-attribution';

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const records = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(object) : [];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const portable = (file: string) => file.split(path.sep).join('/');
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
const repo = process.cwd(), sourceRoot = path.resolve(repo, 'data/research-agent-upgrade/evidence/S19'), outputRoot = path.resolve(repo, 'data/research-agent-upgrade/evidence/U01');
const inputs = new Map<string, { sha256: string; byteLength: number }>();

function options(args: string[]) {
  const campaigns: string[] = []; let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index], separator = arg.indexOf('='), name = separator < 0 ? arg : arg.slice(0, separator);
    if (!['--campaign', '--output'].includes(name)) throw new Error('Only --campaign=<S19 directory> and --output=<new U01 directory> are accepted.');
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
    if (!value || value.startsWith('--')) throw new Error('Every option requires a nonempty directory.');
    if (name === '--campaign') campaigns.push(path.resolve(repo, value));
    else { if (output) throw new Error('Only one --output is allowed.'); output = path.resolve(repo, value); }
  }
  if (!campaigns.length) throw new Error('At least one explicit --campaign is required. No external holdout files are read.');
  return { campaigns: [...new Set(campaigns)].sort(), output: output ?? path.join(outputRoot, new Date().toISOString().replace(/[:.]/gu, '-')) };
}

async function source(file: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(file);
    if (!inside(await realpath(sourceRoot), resolved)) throw new Error('Input resolves outside the S19 evidence root.');
    const bytes = await readFile(file);
    inputs.set(portable(path.relative(repo, file)), { sha256: hash(bytes), byteLength: bytes.length });
    return bytes.toString('utf8').replace(/^\uFEFF/u, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function json(text: string | undefined, file: string): JsonRecord | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return object(parsed);
  } catch { throw new Error(`Malformed JSON metadata in ${path.basename(file)}; source content withheld.`); }
}

/** Visit only historical phase/case directories. Never follow artifact stores, symlinks, or external roots. */
async function inventory(campaign: string) {
  const cases: string[] = [], summaries: string[] = [], phaseDirectories: string[] = [];
  async function visit(directory: string, depth: number) {
    if (depth > 5) throw new Error('Unexpected S19 campaign nesting depth.');
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && ['task.json', 'result.json', 'tools.jsonl', 'observations.jsonl'].includes(entry.name))) { cases.push(directory); return; }
    if (entries.some(entry => entry.isFile() && entry.name === 'results.json')) summaries.push(path.join(directory, 'results.json'));
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^(?:baseline|candidate|holdout|holdout-continuation-\d+|dev-[A-Za-z0-9_-]+|holdout-\d+)$/u.test(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (['baseline', 'candidate', 'holdout'].includes(entry.name)) phaseDirectories.push(child);
      await visit(child, depth + 1);
    }
  }
  await visit(campaign, 0);
  return { cases: cases.sort(), summaries: summaries.sort(), phaseDirectories: phaseDirectories.sort() };
}

async function main() {
  const args = options(process.argv.slice(2)), canonicalSourceRoot = await realpath(sourceRoot);
  for (const campaign of args.campaigns) {
    if (!inside(sourceRoot, campaign) || !inside(canonicalSourceRoot, await realpath(campaign)) || !(await stat(campaign)).isDirectory()) throw new Error('Campaigns must be directories inside the S19 evidence root.');
  }
  // Validate output before creating any directory, including against symlinked existing ancestors.
  if (!inside(outputRoot, args.output) || args.output === outputRoot) throw new Error('Output must be a new child directory under evidence/U01.');
  let ancestor = args.output;
  for (;;) {
    try { await stat(ancestor); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  const canonicalRepo = await realpath(repo), canonicalAncestor = await realpath(ancestor);
  const expectedAncestor = path.resolve(canonicalRepo, path.relative(repo, ancestor));
  if (!inside(canonicalRepo, canonicalAncestor) || path.relative(expectedAncestor, canonicalAncestor) !== '') throw new Error('Output ancestor must not redirect through a symlink.');
  const allCases = new Set<string>(), summaryRows: { file: string; phase: string; value: JsonRecord }[] = [], inventories = [];
  for (const campaign of args.campaigns) {
    const found = await inventory(campaign);
    found.cases.forEach(file => allCases.add(file));
    let summaryEntries = 0;
    for (const file of found.summaries) {
      const data = json(await source(file), file)!;
      for (const value of records(data.results)) { summaryRows.push({ file, phase: path.basename(path.dirname(file)), value }); summaryEntries++; }
    }
    inventories.push({ campaign: portable(path.relative(sourceRoot, campaign)) || '.', caseDirectories: found.cases.length, summaryEntries,
      phaseDirectories: found.phaseDirectories.map(file => portable(path.relative(sourceRoot, file))), noTaskRecords: found.cases.length === 0 && summaryEntries === 0 });
  }
  const tasksById = new Map<string, ResearchTaskAttribution>(), locations = new Map<string, string[]>();
  function add(task: ResearchTaskAttribution, location: string) {
    locations.set(task.taskId, [...(locations.get(task.taskId) ?? []), location]);
    const existing = tasksById.get(task.taskId);
    if (existing && (existing.status !== task.status || existing.reportedToolCalls !== task.reportedToolCalls)) throw new Error('Conflicting materialized snapshots for one task ID.');
    if (!existing || task.observedToolCalls > existing.observedToolCalls) tasksById.set(task.taskId, task);
  }
  for (const directory of [...allCases].sort()) {
    const [taskText, resultText, toolsText, observationsText] = await Promise.all(['task.json', 'result.json', 'tools.jsonl', 'observations.jsonl'].map(file => source(path.join(directory, file))));
    const task = json(taskText, 'task.json'), result = json(resultText, 'result.json'), relative = path.relative(sourceRoot, directory).split(path.sep);
    const caseId = path.basename(directory), phase = path.basename(path.dirname(directory)), campaign = portable(path.relative(sourceRoot, path.dirname(path.dirname(directory))));
    const missingInputs = [['task.json', taskText], ['result.json', resultText], ['tools.jsonl', toolsText], ['observations.jsonl', observationsText]].filter(([, text]) => text === undefined).map(([file]) => file!);
    if (task === null && result === null && toolsText === undefined) continue;
    add(attributeResearchTask({ campaign, phase, caseId, visibility: phase === 'holdout' || relative.some(part => /^holdout-\d+$/u.test(part)) ? 'consumed_holdout' : 'development', task, result, toolsText, observationsText, missingInputs }), portable(path.relative(sourceRoot, directory)));
  }
  let duplicateSummaryEntries = 0;
  for (const row of summaryRows) {
    if (typeof row.value.taskId !== 'string' || !row.value.taskId) throw new Error('Summary task record lacks a task ID.');
    const existing = tasksById.get(row.value.taskId);
    if (existing) { duplicateSummaryEntries++; continue; }
    const parent = path.dirname(row.file), caseId = typeof row.value.label === 'string' && /^[A-Za-z0-9_-]+$/u.test(row.value.label) ? row.value.label : 'unlocated';
    add(attributeResearchTask({ campaign: portable(path.relative(sourceRoot, path.dirname(parent))), phase: row.phase, caseId,
      visibility: row.phase === 'holdout' ? 'consumed_holdout' : 'development', task: null, result: row.value,
      missingInputs: ['task.json', 'tools.jsonl', 'observations.jsonl'] }), `${portable(path.relative(sourceRoot, row.file))}#taskId`);
  }
  const tasks = [...tasksById.values()].sort((a, b) => a.campaign.localeCompare(b.campaign) || a.phase.localeCompare(b.phase) || a.caseId.localeCompare(b.caseId)), summary = summarizeResearchAttribution(tasks);
  const queries = tasks.flatMap(task => task.queries), queryPayload = { schemaVersion: 1, scope: 'Historical consumed S19 traces only. Controlled output; contains model queries, not source/answer text.', queries };
  // Verify read-only input identities before writing the report. Summaries copied between continuation runs do not count as new runs.
  for (const [file, identity] of inputs) if (hash(await readFile(path.join(repo, file))) !== identity.sha256) throw new Error('An S19 input changed during attribution; rerun against stable evidence.');
  await mkdir(path.dirname(args.output), { recursive: true });
  const canonicalOutputRoot = await realpath(outputRoot), expectedOutputRoot = path.join(await realpath(repo), 'data/research-agent-upgrade/evidence/U01');
  if (path.relative(expectedOutputRoot, canonicalOutputRoot) !== '' || !inside(canonicalOutputRoot, await realpath(path.dirname(args.output)))) throw new Error('Output parent resolves outside evidence/U01.');
  await mkdir(args.output, { recursive: false });
  const payloads: Record<string, string> = {
    'attribution.json': JSON.stringify({ schemaVersion: 1, summary, inventory: { campaigns: inventories, materializedCases: allCases.size,
      uniqueTasks: tasks.length, summaryEntries: summaryRows.length, summaryReferencesToKnownTasks: duplicateSummaryEntries,
      copiedSummaryEntriesBeyondUniqueTasks: summaryRows.length - new Set(summaryRows.map(row => row.value.taskId)).size,
      taskLocations: Object.fromEntries(locations) }, tasks }, null, 2) + '\n',
    'failure-attribution.md': renderResearchAttributionMarkdown(tasks, summary),
    'real-queries.json': JSON.stringify(queryPayload, null, 2) + '\n',
    'development-real-queries.json': JSON.stringify({ ...queryPayload, queries: queries.filter(query => query.visibility === 'development') }, null, 2) + '\n',
  };
  for (const [file, content] of Object.entries(payloads)) await writeFile(path.join(args.output, file), content, { flag: 'wx' });
  const sourceFiles = ['src/lib/eval/research-failure-attribution.ts', 'scripts/research/attribute-failures.ts'];
  const codeHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(repo, file)))])));
  await writeFile(path.join(args.output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
    command: ['node', '--import', 'tsx', 'scripts/research/attribute-failures.ts', ...process.argv.slice(2)], sourceFiles: Object.fromEntries(inputs), inputsUnchanged: true,
    outputFiles: Object.fromEntries(Object.entries(payloads).map(([file, content]) => [file, { sha256: hash(content), byteLength: Buffer.byteLength(content) }])),
    codeHashes, newModelCalls: 0, externalHoldoutFilesRead: 0, cost: 'unknown', limitations: ['No hidden reasoning is read or reconstructed.', 'Historical report state and frozen v1 scores are diagnostic evidence, not a new quality evaluation.'] }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: portable(path.relative(repo, args.output)), tasks: summary.tasks, failedOrPartialTasks: summary.failedOrPartialTasks,
    failedQuestions: summary.failedQuestions, incompleteTraces: summary.incompleteTraces, toolCalls: summary.toolCalls,
    developmentQueries: queries.filter(query => query.visibility === 'development').length, contextContentionSupported: summary.contextContention.supported }));
  if (tasks.some(task => task.trace.issues.length)) process.exitCode = 1;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(?:Only |Every option|At least |Input resolves|Malformed JSON metadata|Unexpected S19|Campaigns must|Output must|Output ancestor|Output parent|Conflicting materialized|Summary task record|An S19 input)/u.test(message);
  console.error(safe ? `U01 attribution failed: ${message}` : 'U01 attribution failed: check input access and use a new output directory under evidence/U01. Private source text is withheld.');
  process.exitCode = 1;
});
