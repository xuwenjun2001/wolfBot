import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, lstat, realpath, open, appendFile, unlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { scoreFinancialCase, summarizeScores, type EvaluationCase } from '../../src/lib/eval/financial-research-score';
import { answerabilityDatasetSchema, financialResearchRubricV2Schema, scoreFinancialCaseV2, summarizeScoresV2, compareFinancialScoresV2,
  type CaseAnswerability, type EvaluationScoreV2 } from '../../src/lib/eval/financial-research-score-v2';
import { ABLATION_VARIANTS, VARIANT_CONCURRENCY, DEFAULT_ABLATION_BUDGET, ablationDatasetSchema, ablationDocumentSchema, peerPairsSchema, safeIdSchema,
  ablationSha256, contractSha256, parseAblationOptions, caseCompatibility, validateComparisonProtocol, validateUsage,
  campaignInputState, realExecutionBlockers, createHarnessMockAdapter, runKey, AblationExecutionFailure, validateExecutionResult, ablationReportResultSchema,
  type AblationOptions, type AblationCase, type AblationWorkItem, type AblationComparisonContract,
  type AblationExecutionAdapter, type AblationExecutionResult, type AblationUsage } from './ablation-protocol';

const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const json = async (file: string) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as unknown;
const exists = async (file: string) => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const exclusiveJson = async (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
function publicError(error: unknown) {
  let message = error instanceof Error ? error.message : 'Ablation execution failed';
  for (const secret of [process.env.COMPANY_RESEARCH_API_KEY, process.env.DEEPSEEK_API_KEY, process.env.DATABASE_URL, process.env.RESEARCH_TEST_DATABASE_URL]) if (secret) message = message.replaceAll(secret, '[redacted]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/(?:sk-|tvly-)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1200);
}
/** Check each ancestor before creating the next one; never follow a junction/symlink. */
async function ensureScopedDirectory(root: string, target: string) {
  if (!inside(root, target)) throw new Error('ABLATION_OUTPUT_OUTSIDE_ROOT');
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { await mkdir(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('ABLATION_OUTPUT_SYMLINK_OR_NON_DIRECTORY');
  }
}
async function assertScopedFile(root: string, file: string) {
  if (!inside(root, file)) throw new Error('ABLATION_SAVED_FILE_OUTSIDE_CAMPAIGN');
  let cursor = root;
  for (const segment of path.relative(root, file).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('ABLATION_SAVED_FILE_SYMLINK');
  }
  if (!(await lstat(file)).isFile()) throw new Error('ABLATION_SAVED_FILE_NOT_REGULAR');
  if (!inside(root, await realpath(file))) throw new Error('ABLATION_FILE_REALPATH_OUTSIDE_ROOT');
}
async function readRepositoryFile(repository: string, file: string) {
  const resolved = path.resolve(repository, file);
  await assertScopedFile(repository, resolved);
  return readFile(resolved);
}
const repositoryJson = async (repository: string, file: string) => JSON.parse((await readRepositoryFile(repository, file)).toString().replace(/^\uFEFF/, '')) as unknown;
async function sourceCodeHashes(repository: string) {
  const files = ['scripts/research/run-agent-ablation.ts', 'scripts/research/ablation-protocol.ts',
    'src/lib/eval/financial-research-score.ts', 'src/lib/eval/financial-research-score-v2.ts', 'src/lib/eval/statistics.ts',
    'scripts/workers/company-research-worker.ts', 'prisma/schema.prisma', 'package-lock.json'];
  async function walk(directory: string) {
    if ((await lstat(path.join(repository, directory))).isSymbolicLink()) throw new Error('ABLATION_CODE_SYMLINK');
    for (const entry of await readdir(path.join(repository, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('ABLATION_CODE_SYMLINK');
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (/\.(ts|js)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(name);
    }
  }
  await Promise.all(['src/lib/company-research', 'src/lib/agent'].map(walk));
  const pairs = await Promise.all([...new Set(files)].sort().map(async file => [file, ablationSha256(await readRepositoryFile(repository, file))] as const));
  return Object.fromEntries(pairs);
}

const approvalSchema = z.object({ schemaVersion: z.literal(1), status: z.enum(['pending_review', 'approved']),
  comparisonContractSha256: z.string(), variants: z.array(z.enum(ABLATION_VARIANTS)), repeats: z.number().int().positive(),
  maxInputTokens: z.number().int().positive(), approvalReceipt: z.object({ path: z.string(), sha256: z.string() }).nullable() }).strict();

async function loadInputs(options: AblationOptions, repository: string, adapter: AblationExecutionAdapter | undefined) {
  const datasetFile = path.resolve(repository, options.dataset);
  if (!inside(repository, datasetFile)) throw new Error('ABLATION_EXTERNAL_DATASET_REQUIRES_SEPARATE_HOLDOUT_RUNNER');
  const datasetBytes = await readRepositoryFile(repository, datasetFile), dataset = ablationDatasetSchema.parse(JSON.parse(datasetBytes.toString()));
  const datasetSha256 = ablationSha256(datasetBytes);
  const manifest = dataset.documents ?? z.object({ documents: z.array(ablationDocumentSchema) }).parse(await repositoryJson(repository, options.documents ?? 'fixtures/company-research/documents.json')).documents;
  const dataHashes: Record<string, string> = { 'rubric-v1': ablationSha256(await readRepositoryFile(repository, 'fixtures/company-research/rubric.json')) };
  const documentIds = dataset.cases.flatMap(sample => sample.documentIds);
  if (new Set(manifest.map(document => document.id)).size !== manifest.length) throw new Error('ABLATION_DUPLICATE_DOCUMENT');
  for (const id of [...new Set(documentIds)].sort()) {
    const document = manifest.find(candidate => candidate.id === id);
    if (!document) throw new Error(`ABLATION_DOCUMENT_MISSING:${id}`);
    const originalFile = path.resolve(repository, document.path);
    if (!inside(repository, originalFile)) throw new Error('ABLATION_EXTERNAL_DOCUMENT_REFUSED');
    const original = await readRepositoryFile(repository, originalFile);
    if (ablationSha256(original) !== document.bytesSha256) throw new Error(`ABLATION_ORIGINAL_HASH_MISMATCH:${id}`);
    dataHashes[`${id}:original`] = document.bytesSha256;
    const receipt = document.parserReceipt ?? { path: `data/research-agent-upgrade/evidence/S07/2026-10-18T17-44-58-299Z/${id}.json`, sha256: '' };
    const receiptFile = path.resolve(repository, receipt.path);
    if (!inside(repository, receiptFile)) throw new Error('ABLATION_EXTERNAL_RECEIPT_REFUSED');
    const bytes = await readRepositoryFile(repository, receiptFile), actualHash = ablationSha256(bytes);
    if (receipt.sha256 && actualHash !== receipt.sha256) throw new Error(`ABLATION_PARSER_HASH_MISMATCH:${id}`);
    dataHashes[`${id}:parserReceipt`] = actualHash;
  }
  for (const sample of dataset.cases) {
    if (new Set(sample.documentIds).size !== sample.documentIds.length || sample.documentIds.some(id => manifest.find(document => document.id === id)?.symbol !== sample.company.symbol)) throw new Error(`ABLATION_DOCUMENT_COMPANY_BINDING:${sample.id}`);
  }
  const rubricFile = path.resolve(repository, options.rubric), rubricBytes = await readRepositoryFile(repository, rubricFile);
  const rubric = financialResearchRubricV2Schema.parse(JSON.parse(rubricBytes.toString()));
  const labels = new Map<string, CaseAnswerability>(), labelHashes: Record<string, string> = {};
  const defaultLabels = 'fixtures/company-research/answerability-dev-v1.json';
  const labelFile = options.answerability ?? (dataset.datasetVersion === 'research-dev-v1' ? defaultLabels : undefined);
  if (labelFile) {
    const labelBytes = await readRepositoryFile(repository, labelFile), parsed = answerabilityDatasetSchema.parse(JSON.parse(labelBytes.toString()));
    if (parsed.sourceDatasetSha256 !== datasetSha256 || parsed.sourceDatasetVersion !== dataset.datasetVersion || parsed.cases.length !== dataset.cases.length || parsed.cases.some(sample => !dataset.cases.some(candidate => candidate.id === sample.caseId))) throw new Error('ABLATION_LABEL_DATASET_BINDING');
    labelHashes[labelFile] = ablationSha256(labelBytes);
    parsed.cases.forEach(sample => labels.set(sample.caseId, sample));
  } else for (const sample of dataset.cases) {
    const compatible = caseCompatibility(sample);
    labelHashes[`${sample.id}:inlineDraft`] = contractSha256(sample.answerabilityDrafts ?? null);
    if (compatible.inlineLabels) labels.set(sample.id, compatible.inlineLabels);
  }
  const verifyReference = async (ref: { path: string; sha256: string }) => {
    const file = path.resolve(repository, ref.path);
    if (!inside(repository, file) || ablationSha256(await readRepositoryFile(repository, file)) !== ref.sha256) throw new Error('ABLATION_REVIEW_RECEIPT_HASH');
  };
  for (const sample of labels.values()) for (const question of sample.questions) {
    await Promise.all(question.evidenceRefs.map(verifyReference));
    if (question.confirmation) await verifyReference({ path: question.confirmation.receiptPath, sha256: question.confirmation.receiptSha256 });
  }
  if (rubric.confirmation) await verifyReference({ path: rubric.confirmation.receiptPath, sha256: rubric.confirmation.receiptSha256 });
  let peerPairsSha256: string | null = null, peerReviewed = options.taskKind !== 'peer';
  let work: AblationWorkItem[] = dataset.cases.map(sample => ({ id: sample.id, kind: 'single', cases: [sample] }));
  const peerUnpairedCaseIds: string[] = [];
  if (options.taskKind === 'peer') {
    const pairBytes = await readRepositoryFile(repository, options.peerPairs ?? 'fixtures/company-research/peer-pairs-v1.json');
    const pairs = peerPairsSchema.parse(JSON.parse(pairBytes.toString()));
    if (pairs.developmentSha256 !== datasetSha256 || new Set(pairs.pairs.map(pair => pair.id)).size !== pairs.pairs.length) throw new Error('ABLATION_PEER_DATASET_BINDING');
    peerPairsSha256 = ablationSha256(pairBytes);
    work = pairs.pairs.map(pair => {
      const selected = pair.caseIds.map(id => dataset.cases.find(sample => sample.id === id));
      if (selected.some(sample => !sample) || new Set(pair.caseIds).size !== 2) throw new Error('ABLATION_PEER_CASE_BINDING');
      return { id: pair.id, kind: 'peer', cases: selected as AblationCase[], peerExecutionBlocked: pair.realExecutionBlocked };
    });
    peerUnpairedCaseIds.push(...dataset.cases.filter(sample => !work.some(item => item.cases.some(candidate => candidate.id === sample.id))).map(sample => sample.id));
    peerReviewed = pairs.pairs.every(pair => pair.humanReview === 'confirmed');
  }
  const contract: AblationComparisonContract = { schemaVersion: 1, version: 'research-ablation-v1', provider: options.provider,
    model: options.model, reasoning: options.reasoning, taskKind: options.taskKind, datasetSha256, dataHashes, codeHashes: await sourceCodeHashes(repository),
    rubricSha256: ablationSha256(rubricBytes), labelHashes, peerPairsSha256, caseIds: dataset.cases.map(sample => sample.id), repeats: options.repeats,
    budget: DEFAULT_ABLATION_BUDGET, maxInputTokens: options.maxInputTokens, cacheCondition: options.cache, concurrencyByVariant: VARIANT_CONCURRENCY,
    adapter: { id: adapter?.id ?? 'production-adapter-unavailable', supportedVariants: adapter?.supportedVariants ?? [],
      inputBudget: adapter?.inputBudget ?? 'accounted_after_task', researchConfiguration: adapter?.researchConfiguration ?? null } };
  const comparisonContractSha256 = contractSha256(contract);
  let registrationApproved = false, registrationBound = false, approvalReceiptBound = false, approvalHash: string | null = null;
  if (options.registration) {
    const registrationBytes = await readRepositoryFile(repository, options.registration);
    const registration = approvalSchema.parse(JSON.parse(registrationBytes.toString()));
    approvalHash = ablationSha256(registrationBytes);
    registrationApproved = registration.status === 'approved';
    registrationBound = registration.comparisonContractSha256 === comparisonContractSha256 && registration.maxInputTokens === options.maxInputTokens && registration.repeats === options.repeats && registration.variants.includes(options.variant);
    if (registration.approvalReceipt) {
      await verifyReference(registration.approvalReceipt);
      const receipt = z.object({ kind: z.literal('explicit_user_approval'), status: z.literal('approved'), statement: z.string().min(1),
        comparisonContractSha256: z.string(), maxInputTokens: z.number(), variants: z.array(z.enum(ABLATION_VARIANTS)) }).passthrough().parse(await repositoryJson(repository, registration.approvalReceipt.path));
      approvalReceiptBound = receipt.comparisonContractSha256 === comparisonContractSha256 && receipt.maxInputTokens === options.maxInputTokens && receipt.variants.includes(options.variant);
    }
  }
  const caseBlockers = dataset.cases.flatMap(sample => caseCompatibility(sample).executionBlockers.map(reason => `${sample.id}:${reason}`));
  if (options.provider === 'real') {
    const blockers = realExecutionBlockers({ options, adapter,
      env: { DATABASE_URL: process.env.DATABASE_URL, RESEARCH_TEST_DATABASE_URL: process.env.RESEARCH_TEST_DATABASE_URL }, rubricFrozen: rubric.status === 'frozen',
      allLabelsConfirmed: labels.size === dataset.cases.length && [...labels.values()].every(sample => sample.questions.every(question => question.reviewStatus === 'confirmed')),
      registrationApproved, registrationBound, approvalReceiptBound, caseBlockers: [...caseBlockers, ...work.filter(item => item.peerExecutionBlocked).map(item => `${item.id}:PEER_EXECUTION_BLOCKED`)], peerReviewed });
    if (blockers.length) throw new Error(`ABLATION_REAL_PREFLIGHT_REQUIRED:${blockers.join(';')}`);
  }
  return { dataset, contract, comparisonContractSha256, approvalHash, rubric, labels, work, peerUnpairedCaseIds, caseBlockers };
}

type CaseScore = { caseId: string; v1: ReturnType<typeof scoreFinancialCase> | null; v2: EvaluationScoreV2 | null; notScored: string[] };
function scoreReports(samples: AblationCase[], execution: AblationExecutionResult, labels: Map<string, CaseAnswerability>, rubric: ReturnType<typeof financialResearchRubricV2Schema.parse>): CaseScore[] {
  return samples.map(sample => {
    const source = execution.reports.find(report => report.caseId === sample.id);
    const errors = [...(source?.hardErrors ?? ['NO_REPORT']), ...(['failed', 'cancelled'].includes(execution.status) ? [`EXECUTION_STATUS:${execution.status}`] : [])];
    const compatible = caseCompatibility(sample), notScored = [...compatible.scoringBlockers];
    if (notScored.length) return { caseId: sample.id, v1: null, v2: null, notScored };
    const evaluation = sample as unknown as EvaluationCase;
    let v1: ReturnType<typeof scoreFinancialCase>;
    try { v1 = scoreFinancialCase(evaluation, source?.report ?? null, errors); }
    catch (error) { return { caseId: sample.id, v1: null, v2: null, notScored: [`V1_SCORING_UNAVAILABLE:${publicError(error)}`] }; }
    let v2: EvaluationScoreV2 | null = null;
    if (!labels.has(sample.id)) notScored.push(`V2_LABEL_SCHEMA_NOT_READY:${compatible.inlineLabelError ?? 'missing labels'}`);
    else {
      try { v2 = scoreFinancialCaseV2(evaluation, source?.report ?? null, errors, labels.get(sample.id)!, { rubric, mode: 'diagnostic' }); }
      catch (error) { notScored.push(`V2_SCORING_UNAVAILABLE:${publicError(error)}`); }
    }
    return { caseId: sample.id, v1, v2, notScored };
  });
}
interface SavedRun {
  schemaVersion: 1; runKey: string; comparisonContractSha256: string; variant: AblationOptions['variant']; repeat: number;
  workId: string; taskKind: 'single' | 'peer'; provider: 'mock' | 'real'; productionAcceptance: false;
  status: string; actualModelCalls: number | null; usage: AblationUsage; elapsedMs: number; phaseDurationsMs: Record<string, number | null>;
  treeSummary: AblationExecutionResult['treeSummary']; reports: AblationExecutionResult['reports']; error: string | null; scores: CaseScore[];
  peerComparison: { status: 'not_scored'; reason: string } | null;
}
interface LedgerEntry { runKey: string; resultFile: string; resultSha256: string; usage: AblationUsage }
async function loadLedger(campaign: string, comparisonContractSha256: string) {
  const ledgerFile = path.join(campaign, 'usage-ledger.jsonl');
  if (await exists(ledgerFile)) await assertScopedFile(campaign, ledgerFile);
  const entries: LedgerEntry[] = await exists(ledgerFile) ? (await readFile(ledgerFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as LedgerEntry) : [];
  const seen = new Set<string>(), verifiedRuns = new Map<string, SavedRun>();
  for (const entry of entries) {
    if (seen.has(entry.runKey) || !/^(?:A|B|B2|C1|C2|C2-peer)\/repeat-\d{3}\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.runKey) || path.resolve(campaign, entry.resultFile) !== path.join(campaign, ...entry.runKey.split('/'), 'result.json')) throw new Error('ABLATION_LEDGER_INTEGRITY');
    seen.add(entry.runKey);
    const file = path.resolve(campaign, entry.resultFile);
    await assertScopedFile(campaign, file);
    const bytes = await readFile(file), saved = JSON.parse(bytes.toString()) as SavedRun;
    if (ablationSha256(bytes) !== entry.resultSha256) throw new Error('ABLATION_LEDGER_RESULT_HASH');
    if (saved.runKey !== entry.runKey || saved.comparisonContractSha256 !== comparisonContractSha256 || contractSha256(saved.usage) !== contractSha256(entry.usage)) throw new Error('ABLATION_LEDGER_RESULT_BINDING');
    verifiedRuns.set(saved.runKey, saved);
    validateUsage(entry.usage);
  }
  // A crash between saving a result and appending usage cannot reset the cap.
  for (const variant of ABLATION_VARIANTS) {
    const variantRoot = path.join(campaign, variant);
    if (!await exists(variantRoot)) continue;
    if ((await lstat(variantRoot)).isSymbolicLink()) throw new Error('ABLATION_SAVED_RUN_SYMLINK');
    for (const repeat of await readdir(variantRoot, { withFileTypes: true })) {
      if (repeat.isSymbolicLink()) throw new Error('ABLATION_SAVED_RUN_SYMLINK');
      if (!repeat.isDirectory() || !/^repeat-\d{3}$/.test(repeat.name)) continue;
      for (const item of await readdir(path.join(variantRoot, repeat.name), { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error('ABLATION_SAVED_RUN_SYMLINK');
        if (!item.isDirectory()) continue;
        safeIdSchema.parse(item.name);
        const directory = path.join(variantRoot, repeat.name, item.name), file = path.join(directory, 'result.json');
        if (!await exists(file)) {
          if (await exists(path.join(directory, 'started.json'))) throw new Error('ABLATION_PRIOR_RUN_USAGE_UNKNOWN: interrupted task needs explicit accounting; cap cannot be reset');
          continue;
        }
        await assertScopedFile(campaign, file);
        const bytes = await readFile(file), result = JSON.parse(bytes.toString()) as SavedRun;
        const expectedKey = `${variant}/${repeat.name}/${item.name}`;
        if (result.comparisonContractSha256 !== comparisonContractSha256 || result.runKey !== expectedKey) throw new Error('ABLATION_SAVED_RUN_PROTOCOL_MISMATCH');
        if (!seen.has(result.runKey)) {
          const entry = { runKey: result.runKey, resultFile: path.relative(campaign, file), resultSha256: ablationSha256(bytes), usage: validateUsage(result.usage) };
          await appendFile(ledgerFile, `${JSON.stringify(entry)}\n`); entries.push(entry); seen.add(result.runKey);
          verifiedRuns.set(result.runKey, result);
        }
      }
    }
  }
  return { entries, ledgerFile, verifiedRuns };
}

export async function runAgentAblation(options: AblationOptions, dependencies: { adapter?: AblationExecutionAdapter; repository?: string } = {}) {
  const repository = await realpath(dependencies.repository ?? process.cwd());
  const adapter = dependencies.adapter ?? (options.provider === 'mock' ? createHarnessMockAdapter() : undefined);
  if (adapter && (adapter.provider !== options.provider || !adapter.supportedVariants.includes(options.variant))) throw new Error('ABLATION_ADAPTER_PROVIDER_OR_VARIANT_MISMATCH');
  const loaded = await loadInputs(options, repository, adapter);
  const campaign = path.resolve(repository, options.campaign);
  const allowedRoots = [path.join(repository, 'data/research-agent-upgrade/evidence/U-ablation'), ...(options.provider === 'mock' ? [path.join(repository, 'data/research-agent-upgrade/evidence/U03')] : [])];
  if (!allowedRoots.some(root => campaign !== root && inside(root, campaign))) throw new Error('ABLATION_EXPLICIT_CONTROLLED_CAMPAIGN_REQUIRED');
  await ensureScopedDirectory(repository, campaign);
  const lockFile = path.join(campaign, '.run.lock'), lockId = randomUUID();
  const lock = await open(lockFile, 'wx');
  await lock.writeFile(JSON.stringify({ id: lockId, pid: process.pid, purpose: 'serialize the whole campaign input-token ledger' }));
  try {
    const protocolFile = path.join(campaign, 'protocol.json');
    if (await exists(protocolFile)) {
      await assertScopedFile(campaign, protocolFile);
      const existing = await json(protocolFile) as { contract: AblationComparisonContract; comparisonContractSha256: string };
      if (existing.comparisonContractSha256 !== contractSha256(existing.contract)) throw new Error('ABLATION_PROTOCOL_DIGEST_MISMATCH');
      validateComparisonProtocol(existing.contract, loaded.contract);
    }
    else {
      const existing = (await readdir(campaign)).filter(file => file !== '.run.lock');
      if (existing.length) throw new Error('ABLATION_NONEMPTY_UNREGISTERED_CAMPAIGN');
      await exclusiveJson(protocolFile, { contract: loaded.contract, comparisonContractSha256: loaded.comparisonContractSha256, approvalHash: loaded.approvalHash,
        scope: options.provider === 'mock' ? 'Harness mock only: no production finance Agent, provider, tools or database execution' : 'Registered execution adapter; quality acceptance still requires report review' });
    }
    const rootProtocol = await json(protocolFile) as { approvalHash: string | null };
    if (rootProtocol.approvalHash !== loaded.approvalHash) throw new Error('ABLATION_APPROVAL_RECEIPT_CHANGED');
    const arm = path.join(campaign, options.variant);
    if (await exists(arm)) throw new Error('ABLATION_RUN_DIRECTORY_EXISTS: choose a new campaign; previous attempts cannot be overwritten or retried invisibly');
    const ledger = await loadLedger(campaign, loaded.comparisonContractSha256);
    if (options.provider === 'real') await adapter!.assertDisposableDatabase!();
    await ensureScopedDirectory(repository, arm);
    await exclusiveJson(path.join(arm, 'protocol.json'), { comparisonContractSha256: loaded.comparisonContractSha256, variant: options.variant,
      concurrency: VARIANT_CONCURRENCY[options.variant], runtimeOptions: { variant: options.variant }, taskKind: options.taskKind,
      repeats: options.repeats, cacheCondition: options.cache, peerUnpairedCaseIds: loaded.peerUnpairedCaseIds });
    const results: SavedRun[] = [];
    let stoppedEarly = false;
    for (let repeat = 1; repeat <= options.repeats; repeat++) for (const work of loaded.work) {
      const key = runKey(options.variant, repeat, work.id), directory = path.join(campaign, ...key.split('/'));
      await ensureScopedDirectory(repository, directory);
      const budget = campaignInputState(ledger.entries.map(entry => entry.usage), options.maxInputTokens);
      const started = Date.now();
      let execution: AblationExecutionResult;
      if (budget.stop) {
        stoppedEarly = true;
        execution = { status: 'cancelled', reports: work.cases.map(sample => ({ caseId: sample.id, report: null, hardErrors: [`NOT_STARTED:${budget.reason}`] })),
          usage: { inputTokens: 0, outputTokens: 0, unknownModelRequests: 0, toolCalls: 0, modelRequests: 0, measurement: options.provider === 'mock' ? 'simulated' : 'provider_reported' },
          phaseDurationsMs: {}, treeSummary: [], error: `NOT_STARTED:${budget.reason}` };
      } else {
        await exclusiveJson(path.join(directory, 'started.json'), { runKey: key, comparisonContractSha256: loaded.comparisonContractSha256, remainingInputTokens: budget.remaining, at: new Date().toISOString() });
        try {
          const returned = await adapter!.run({ variant: options.variant, runtimeOptions: { variant: options.variant }, work, repeat,
            model: options.model, reasoning: options.reasoning, concurrency: VARIANT_CONCURRENCY[options.variant], cacheCondition: options.cache,
            budget: DEFAULT_ABLATION_BUDGET, remainingInputTokens: budget.remaining, signal: AbortSignal.timeout(DEFAULT_ABLATION_BUDGET.timeoutMs) });
          try { execution = validateExecutionResult(returned); }
          catch (error) { throw new AblationExecutionFailure(`ADAPTER_RESULT_INVALID:${publicError(error)}`, returned); }
          if (execution.reports.length !== work.cases.length || new Set(execution.reports.map(report => report.caseId)).size !== work.cases.length || execution.reports.some(report => !work.cases.some(sample => sample.id === report.caseId))) throw new AblationExecutionFailure('ADAPTER_REPORT_SET_MISMATCH', execution);
          if (execution.usage.inputTokens !== null && execution.usage.inputTokens > budget.remaining) execution = { ...execution, status: 'failed', error: 'ADAPTER_INPUT_TOKEN_CAP_VIOLATION: actual overrun retained; no further tasks may start' };
        } catch (error) {
          const partial = error instanceof AblationExecutionFailure && error.partial && typeof error.partial === 'object' ? error.partial : {};
          const safeUsage = (() => { try { return partial.usage ? validateUsage(partial.usage) : null; } catch { return null; } })();
          execution = { status: 'failed', reports: work.cases.map(sample => {
            const parsed = ablationReportResultSchema.safeParse(Array.isArray(partial.reports) ? partial.reports.find(report => report?.caseId === sample.id) : undefined);
            return parsed.success ? { ...parsed.data, hardErrors: [...parsed.data.hardErrors, 'ADAPTER_FAILURE'] } : { caseId: sample.id, report: null, hardErrors: ['ADAPTER_FAILURE'] };
          }),
            usage: safeUsage ?? { inputTokens: null, outputTokens: null, unknownModelRequests: 1, toolCalls: 0, modelRequests: 0, measurement: 'unknown' },
            phaseDurationsMs: z.record(z.string(), z.number().finite().nonnegative().nullable()).catch({}).parse(partial.phaseDurationsMs),
            treeSummary: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), role: z.string(), status: z.string() }).strict()).catch([]).parse(partial.treeSummary), error: publicError(error) };
        }
      }
      const saved: SavedRun = { schemaVersion: 1, runKey: key, comparisonContractSha256: loaded.comparisonContractSha256, variant: options.variant, repeat,
        workId: work.id, taskKind: work.kind, provider: options.provider, productionAcceptance: false,
        status: budget.stop ? 'not_started' : execution.status, actualModelCalls: options.provider === 'mock' ? 0 : execution.usage.measurement === 'provider_reported' ? execution.usage.modelRequests : null,
        usage: execution.usage, elapsedMs: Date.now() - started, phaseDurationsMs: execution.phaseDurationsMs, treeSummary: execution.treeSummary,
        reports: execution.reports, error: execution.error ? publicError(new Error(execution.error)) : null,
        scores: scoreReports(work.cases, execution, loaded.labels, loaded.rubric),
        peerComparison: work.kind === 'peer' ? { status: 'not_scored', reason: 'U37 peer production adapter and cross-company scoring are not implemented; transport mock only' } : null };
      await exclusiveJson(path.join(directory, 'result.json'), saved);
      const file = path.join(directory, 'result.json');
      const entry: LedgerEntry = { runKey: key, resultFile: path.relative(campaign, file), resultSha256: ablationSha256(await readFile(file)), usage: saved.usage };
      await appendFile(ledger.ledgerFile, `${JSON.stringify(entry)}\n`); ledger.entries.push(entry); results.push(saved);
    }
    const allCaseScores = results.flatMap(result => result.scores);
    const v1Scores = allCaseScores.flatMap(score => score.v1 ? [score.v1] : []), v2Scores = allCaseScores.flatMap(score => score.v2 ? [score.v2] : []);
    const summary = { schemaVersion: 1, variant: options.variant, provider: options.provider, productionAcceptance: false,
      measurement: options.provider === 'mock' ? 'simulated harness usage; actual model calls zero' : 'provider usage with unknown items preserved',
      comparisonContractSha256: loaded.comparisonContractSha256, complete: !stoppedEarly, stoppedEarly,
      plannedRuns: loaded.work.length * options.repeats, savedRuns: results.length, executedRuns: results.filter(result => result.status !== 'not_started').length,
      plannedDenominators: { companyLegs: loaded.work.reduce((total, work) => total + work.cases.length, 0) * options.repeats,
        numericItems: loaded.work.reduce((total, work) => total + work.cases.reduce((sum, sample) => sum + sample.reference.facts.length + sample.reference.changes.length, 0), 0) * options.repeats,
        singleCompanyQuestions: loaded.work.reduce((total, work) => total + work.cases.length * 3, 0) * options.repeats,
        peerComparisonQuestions: options.taskKind === 'peer' ? loaded.work.length * options.repeats : 0 },
      scoringCoverage: { v1ScoredCompanyLegs: v1Scores.length, v2ScoredCompanyLegs: v2Scores.length, totalCompanyLegs: allCaseScores.length,
        incompleteCoverage: v1Scores.length !== allCaseScores.length || v2Scores.length !== allCaseScores.length },
      // An incompatible case suppresses the aggregate; no silent subset accuracy.
      v1: v1Scores.length === allCaseScores.length ? summarizeScores(v1Scores) : null,
      v2: v2Scores.length === allCaseScores.length ? summarizeScoresV2(v2Scores) : null,
      campaignInputUsage: campaignInputState(ledger.entries.map(entry => entry.usage), options.maxInputTokens),
      actualModelCalls: options.provider === 'mock' ? 0 : results.some(result => result.actualModelCalls === null) ? null : results.reduce((sum, result) => sum + result.actualModelCalls!, 0),
      cost: 'unknown', failureRuns: results.filter(result => result.error).length, datasetCompatibilityBlockers: loaded.caseBlockers,
      peerUnpairedCaseIds: loaded.peerUnpairedCaseIds, results };
    await exclusiveJson(path.join(arm, 'results.json'), summary);
    const rows = results.map(result => `| ${result.repeat} | ${result.workId} | ${result.status} | ${result.usage.inputTokens ?? 'unknown'} | ${result.scores.map(score => score.v1 ? `${score.v1.numericPassed}/${score.v1.numericTotal}` : 'not_scored').join('; ')} | ${result.error?.replace(/\|/g, '/') ?? ''} |`);
    await writeFile(path.join(arm, 'results.md'), `# ${options.variant} — ${options.provider === 'mock' ? '运输框架 mock，非生产 Agent 验收' : '登记实验执行'}\n\n完整计划 ${summary.plannedRuns} 个父任务，保存 ${summary.savedRuns}，实际启动 ${summary.executedRuns}；提前停止 ${summary.stoppedEarly}。公司分支 ${summary.plannedDenominators.companyLegs}，必需数值 ${summary.plannedDenominators.numericItems}，单公司问题 ${summary.plannedDenominators.singleCompanyQuestions}，跨公司比较 ${summary.plannedDenominators.peerComparisonQuestions}。\n\n所有失败和未启动任务保留。评分兼容覆盖不足时汇总为 null，不把可兼容子集当全部质量。mock 用量是模拟账本，实际模型调用为零；真实费用 unknown。G0 人审未完成，当前不作正式 v2 质量结论。\n\n| 重复 | 案例/同行对 | 状态 | 输入 Token | v1 数值 | 错误/停止原因 |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n全 campaign 已知输入 ${summary.campaignInputUsage.inputTokens}/${options.maxInputTokens}，未知用量 ${summary.campaignInputUsage.inputTokensAreLowerBound}。cap跨变体和重复共享；未知用量时停止后续任务。所有原始结果和账本保持可复核。\n`, { flag: 'wx' });
    const comparisons: unknown[] = [];
    for (const other of ABLATION_VARIANTS.filter(variant => variant !== options.variant)) {
      // Summaries are presentation artifacts. Only ledger-verified per-run reports/scores enter comparisons.
      const previous = [...ledger.verifiedRuns.values()].filter(result => result.variant === other);
      if (!previous.length) continue;
      const expectedKeys = Array.from({ length: options.repeats }, (_, index) => loaded.work.map(work => runKey(other, index + 1, work.id))).flat();
      if (previous.length !== expectedKeys.length || expectedKeys.some(key => !previous.some(result => result.runKey === key))) {
        comparisons.push({ baseline: other, candidate: options.variant, result: null, reason: 'Incomplete previous arm matrix; missing runs may not be dropped' });
        continue;
      }
      const scores = (runs: SavedRun[]) => runs.flatMap(run => run.scores.flatMap(score => score.v2 ? [{ ...score.v2, caseId: `${run.repeat}:${run.workId}:${score.caseId}` }] : []));
      const left = scores(previous), right = scores(results);
      comparisons.push(left.length === previous.reduce((sum, run) => sum + run.scores.length, 0) && right.length === allCaseScores.length ?
        { baseline: other, candidate: options.variant, result: compareFinancialScoresV2(left, right, { mode: 'diagnostic' }) } :
        { baseline: other, candidate: options.variant, result: null, reason: 'Incomplete v2 scoring coverage; paired comparison refused rather than dropping cases' });
    }
    await exclusiveJson(path.join(arm, 'comparisons.json'), comparisons);
    return { campaign, arm, summary };
  } finally {
    await lock.close();
    const current = await json(lockFile) as { id: string };
    if (current.id !== lockId) throw new Error('ABLATION_CAMPAIGN_LOCK_CHANGED');
    await unlink(lockFile);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAgentAblation(parseAblationOptions(process.argv.slice(2))).then(result => {
    console.log(JSON.stringify({ evidence: result.arm, plannedRuns: result.summary.plannedRuns, executedRuns: result.summary.executedRuns,
      stoppedEarly: result.summary.stoppedEarly, actualModelCalls: result.summary.actualModelCalls, productionAcceptance: false }));
  }).catch(error => { console.error(publicError(error)); process.exitCode = 1; });
}
