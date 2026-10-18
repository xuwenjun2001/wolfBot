import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { installFixtureTransport } from './baseline-fixture-adapter';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
async function main() {
  const database = process.env.RESEARCH_TEST_DATABASE_URL;
  if (!database) throw new Error('RESEARCH_TEST_DATABASE_URL is required; never use the application DB');
  const db = new URL(database);
  if (!['127.0.0.1', 'localhost'].includes(db.hostname) || !/^\/research_test(?:_[a-z0-9_]+)?$/.test(db.pathname)) throw new Error('Only an explicitly supplied disposable localhost research_test database is accepted');
  process.env.DATABASE_URL = database;
  dotenv.config({ path: ['.env.local', '.env'], quiet: true });
  process.env.QUANTPILOT_MARKET_API_URL = 'http://research-fixture.invalid';
  const rubricBytes = await readFile('fixtures/company-research/rubric.json');
  const rubric = JSON.parse(rubricBytes.toString());
  const calibration = process.argv.includes('--calibrate');
  process.env.COMPANY_RESEARCH_MAX_CALLS = String(calibration ? 4 : rubric.baselineBudget.maxToolCalls);
  process.env.COMPANY_RESEARCH_TIMEOUT_MS = String(rubric.baselineBudget.timeoutMs);
  const { researchConfig, safeError } = await import('../../src/lib/company-research/config');
  const config = researchConfig();
  if (config.model !== rubric.baselineBudget.model) throw new Error('Configured model differs from frozen rubric');
  const { prisma } = await import('../../src/lib/db/client');
  const { createRun, getRun, publicRun, claimRun } = await import('../../src/lib/company-research/store');
  const { executeResearch } = await import('../../src/lib/company-research/runtime');
  const datasetBytes = await readFile('fixtures/company-research/development.json');
  const dataset = JSON.parse(datasetBytes.toString());
  const documents = JSON.parse(await readFile('fixtures/company-research/documents.json', 'utf8')).documents;
  const identity = `research-baseline-${randomUUID()}`;
  const directory = `data/research-agent-upgrade/evidence/S03/${calibration ? 'calibration' : 'development'}-${Date.now()}`;
  await mkdir(directory, { recursive: true });
  const manifest: any = { schemaVersion: 1, startedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    workingChanges: execFileSync('git', ['status', '--short']).toString().trim().split('\n').filter(Boolean), identity, storage: 'exclusive disposable PostgreSQL',
    mode: 'real model gateway + fixed public document/market/search transport; not live search E2E', calibration,
    model: config.model, gateway: new URL(config.baseUrl).origin, reasoning: config.reasoning, maxToolCalls: config.maxCalls, timeoutMs: config.timeoutMs,
    datasetSha256: sha(datasetBytes), rubricSha256: sha(rubricBytes), prices: 'unknown', runs: [] };
  const save = () => writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  const sourceFiles = ['contracts.ts','runtime.ts','tools.ts','connectors.ts','provider.ts','store.ts','ledger.ts','evidence.ts','discovery.ts'];
  manifest.sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async f => [f, sha(await readFile(`src/lib/company-research/${f}`))])));
  manifest.runnerHashes = Object.fromEntries(await Promise.all(['run-baseline.ts', 'baseline-fixture-adapter.ts'].map(async f => [f, sha(await readFile(`scripts/research/${f}`))])));
  await save();
  try {
    const count = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM company_research_runs`;
    if (count[0].n !== 0n) throw new Error('Baseline requires an empty disposable research database; refuse to consume existing tasks');
    const cases = calibration ? dataset.cases.slice(0, 1) : dataset.cases;
    for (const c of cases) {
      const docs = documents.filter((d: any) => c.documentIds.includes(d.id));
      for (const doc of docs) if (sha(await readFile(doc.path)) !== doc.bytesSha256) throw new Error('Frozen original changed');
      const requests: any[] = [], pending: Promise<void>[] = [];
      const restore = await installFixtureTransport(c, docs, (url, init, response) => {
        const body = JSON.parse(String(init?.body));
        const entry: any = { url, status: response.status, requestedAt: new Date().toISOString(), model: body.model, inputSha256: sha(String(init?.body)), toolChoice: body.tool_choice, stream: body.stream, usage: null, publicChunks: [] };
        requests.push(entry);
        pending.push(response.clone().text().then(raw => {
          // Persist only observable output and usage. Never save reasoning/thinking fields.
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') continue;
            try {
              const value = JSON.parse(line.slice(6));
              if (value.usage) entry.usage = value.usage;
              for (const choice of value.choices || []) {
                const delta = choice.delta || choice.message || {};
                const visible = { content: delta.content, tool_calls: delta.tool_calls, finish_reason: choice.finish_reason };
                if (Object.values(visible).some(v => v != null)) entry.publicChunks.push(visible);
              }
              if (value.error) entry.error = safeError(new Error(JSON.stringify(value.error)));
            } catch { /* Non-SSE error bodies are classified by HTTP status. */ }
          }
          if (!response.ok && !entry.error) entry.error = `HTTP ${response.status}; raw body omitted`;
        }).catch(e => { entry.captureError = safeError(e); }));
      });
      const started = Date.now();
      let id: string | undefined;
      let result: any;
      try {
        const created = await createRun(identity, c.company, `${identity}-${c.id}`); id = created.id;
        // Replay-only injection: legacy API cannot accept asOf/periods/questions.
        await prisma.$executeRaw`UPDATE company_research_runs SET state=jsonb_set(state,'{asOf}',${JSON.stringify(c.asOf)}::jsonb) WHERE id=${id} AND actor_id=${identity}`;
        const run = await claimRun(`${identity}-worker`);
        if (!run || run.id !== id || run.actor_id !== identity) throw new Error('Unexpected claim in disposable database');
        await executeResearch(run);
        const stored = await getRun(identity, id);
        if (!stored) throw new Error('Missing baseline run');
        result = { snapshot: publicRun(stored), state: stored.state };
      } catch (e) { result = { error: safeError(e), phase: id ? 'execution' : 'create' }; }
      finally { restore(); await Promise.all(pending); }
      const rawPath = `${directory}/${c.id}.json`;
      await writeFile(rawPath, JSON.stringify({ result, modelRequests: requests }, null, 2) + '\n');
      const completed = requests.filter(r => r.usage).length;
      const record = { caseId: c.id, runId: id || null, actor: identity, terminalStatus: result.snapshot?.status || 'infrastructure_failed', elapsedMs: Date.now() - started,
        modelRequests: requests.length, requestsWithUsage: completed, usageCompleteness: requests.length && requests.length === completed ? 'complete' : 'unknown_or_partial',
        usage: completed ? result.snapshot?.usage : null, checkpointTokenCounters: result.snapshot?.usage || null, cost: 'unknown', failureStage: result.error ? result.phase : requests.some(r => r.status === 401 || r.status === 403) ? 'gateway_authentication' : result.snapshot?.error ? requests.length ? 'model_or_tool' : 'pre_model' : null,
        questions: c.questions.map((q: any) => ({ id: q.id, classification: 'unsupported', reason: 'Legacy request and report have no explicit two-period change task contract', semanticScore: null })),
        rawPath, rawSha256: sha(await readFile(rawPath)), toolCalls: result.state?.toolCalls || 0 };
      manifest.runs.push(record); await save();
      console.log(JSON.stringify({ caseId: c.id, runId: id, status: record.terminalStatus, requests: requests.length, usage: record.usageCompleteness, elapsedMs: record.elapsedMs }));
    }
    manifest.finishedAt = new Date().toISOString(); await save();
    console.log(`Saved ${directory}/manifest.json`);
  } finally { await prisma.$disconnect(); }
}
void main().catch(e => { console.error(e.message); process.exitCode = 1; });
