import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir, mkdtemp, readdir, symlink } from 'node:fs/promises';
import { test } from 'node:test';
import {
  ABLATION_VARIANTS, VARIANT_CONCURRENCY, DEFAULT_ABLATION_BUDGET, ablationSha256, contractSha256,
  ablationDatasetSchema, parseAblationOptions, caseCompatibility, campaignInputState, databaseIsolationBlockers,
  realExecutionBlockers, runKey, validateComparisonProtocol, createHarnessMockAdapter, AblationExecutionFailure,
  type AblationOptions, type AblationCase, type AblationExecutionAdapter, type AblationComparisonContract,
} from './ablation-protocol';
import { runAgentAblation } from './run-agent-ablation';

// These repositories contain invented, explicitly synthetic bytes, never financial data or model output.
const workspace = path.resolve('data/research-agent-upgrade/evidence/U03/test-workspaces');
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
async function fixture(count = 2) {
  await mkdir(workspace, { recursive: true });
  const repository = await mkdtemp(path.join(workspace, 'synthetic-'));
  const put = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
    await writeFile(path.join(repository, file), content);
  };
  for (const file of ['scripts/research/run-agent-ablation.ts', 'scripts/research/ablation-protocol.ts',
    'scripts/workers/company-research-worker.ts', 'src/lib/eval/financial-research-score.ts',
    'src/lib/eval/financial-research-score-v2.ts', 'src/lib/eval/statistics.ts', 'prisma/schema.prisma', 'package-lock.json',
    'src/lib/agent/synthetic.ts', 'src/lib/company-research/synthetic.ts']) await put(file, `// SYNTHETIC TEST PLACEHOLDER: ${file}\n`);
  await put('fixtures/company-research/rubric.json', '{"synthetic":true}');
  await put('fixtures/company-research/rubric-v2.json', await readFile('fixtures/company-research/rubric-v2.json', 'utf8'));
  const cases: AblationCase[] = [], documents: { id: string; symbol: string; path: string; bytesSha256: string; parserReceipt: { path: string; sha256: string } }[] = [];
  for (let index = 0; index < count; index++) {
    const id = `case-${index}`, symbol = `${String(index + 1).padStart(6, '0')}.SZ`, documentIds = [];
    for (const year of [2023, 2024]) {
      const documentId = `${id}-${year}`, file = `synthetic-data/${documentId}.txt`, receipt = `synthetic-data/${documentId}.json`;
      const original = `SYNTHETIC TEST BYTES, NOT A PDF ${documentId}`, parser = JSON.stringify({ synthetic: true, documentId });
      await put(file, original); await put(receipt, parser); documentIds.push(documentId);
      documents.push({ id: documentId, symbol, path: file, bytesSha256: ablationSha256(original), parserReceipt: { path: receipt, sha256: ablationSha256(parser) } });
    }
    cases.push({ id, company: { symbol, name: 'SYNTHETIC TEST COMPANY' }, asOf: '2025-06-30', documentIds,
      questions: ['income_profit', 'cash_flow', 'risks'].map(id => ({ id, text: 'SYNTHETIC TEST QUESTION' })),
      reference: {
        facts: ['revenue', 'parent_net_profit', 'operating_cash_flow'].flatMap(metric => [2023, 2024].map(year => ({ metric,
          period: { start: `${year}-01-01`, end: `${year}-12-31` }, rawValue: year === 2023 ? '10' : '12', unit: 'yuan', normalizedYuan: year === 2023 ? '10' : '12' }))),
        changes: ['revenue', 'parent_net_profit', 'operating_cash_flow'].map(metric => ({ metric, percentage: '20' })),
      },
      answerabilityDrafts: { caseId: id, documentIds: [...documentIds], questions: ['income_profit', 'cash_flow', 'risks'].map(questionId => ({
        questionId, answerability: 'answerable', reviewStatus: 'pending_review', rationale: 'Synthetic test label only',
        evidenceRefs: [{ path: documents[documents.length - 1].parserReceipt.path, sha256: documents[documents.length - 1].parserReceipt.sha256 }],
        checkedRanges: [], confirmation: null,
      })) },
    });
  }
  const dataset = { schemaVersion: 2, datasetVersion: 'synthetic-test-only', split: 'development', documents, cases };
  const writeDataset = async () => {
    const bytes = `${JSON.stringify(dataset, null, 2)}\n`;
    await put('fixtures/synthetic.json', bytes);
    await put('fixtures/peers.json', JSON.stringify({ developmentSha256: ablationSha256(bytes), pairs: [{ id: 'synthetic-pair', caseIds: cases.slice(0, 2).map(sample => sample.id), humanReview: 'pending_review' }] }));
  };
  await writeDataset();
  const options = (overrides: Partial<AblationOptions> = {}): AblationOptions => ({ variant: 'A', provider: 'mock', dataset: 'fixtures/synthetic.json',
    campaign: 'data/research-agent-upgrade/evidence/U03/campaign', repeats: 1, maxInputTokens: 100_000,
    model: 'harness-mock', reasoning: 'harness-mock', cache: 'cold', taskKind: 'single',
    rubric: 'fixtures/company-research/rubric-v2.json', peerPairs: 'fixtures/peers.json', ...overrides });
  return { repository, dataset, options, put, writeDataset };
}

const usage = (inputTokens: number | null, unknownModelRequests = 0) => ({ inputTokens, outputTokens: 0, unknownModelRequests,
  toolCalls: 0, modelRequests: 0, measurement: 'simulated' as const });

test('CLI requires campaign cap, uses explicit mock metadata and requires real model configuration', () => {
  const args = ['--variant=A', '--provider=mock', '--dataset=fixture.json', '--campaign=controlled', '--repeats=2', '--max-input-tokens=1000'];
  const parsed = parseAblationOptions(args);
  assert.equal(parsed.model, 'harness-mock'); assert.equal(parsed.reasoning, 'harness-mock'); assert.equal(parsed.repeats, 2);
  assert.equal(parseAblationOptions(args.map(arg => arg === '--variant=A' ? '--variant=C2-peer' : arg)).taskKind, 'peer');
  assert.throws(() => parseAblationOptions(args.filter(arg => !arg.startsWith('--max-input'))), /REQUIRED/);
  assert.throws(() => parseAblationOptions([...args, '--repeats=3']), /unique/);
  assert.throws(() => parseAblationOptions(args.map(arg => arg === '--repeats=2' ? '--repeats=1.5' : arg)), /INTEGER/);
  assert.throws(() => parseAblationOptions(args.map(arg => arg === '--provider=mock' ? '--provider=real' : arg)), /EXPLICIT_MODEL/);
  assert.equal(parseAblationOptions([...args.map(arg => arg === '--provider=mock' ? '--provider=real' : arg), '--model=gpt-5.6-luna', '--reasoning=max']).model, 'gpt-5.6-luna');
});

test('repeat directories are separate and unsafe path IDs are rejected', () => {
  assert.equal(runKey('A', 1, 'dev-600519'), 'A/repeat-001/dev-600519');
  assert.notEqual(runKey('A', 1, 'c'), runKey('A', 2, 'c'));
  for (const id of ['../escape', 'a/b', 'a\\b', 'CON', 'nul.json', 'case.']) assert.throws(() => runKey('A', 1, id));
  assert.throws(() => runKey('A', 0, 'c'), /REPEAT/);
});

test('campaign cap keeps lower bounds and stops on any unknown usage', () => {
  assert.deepEqual(campaignInputState([usage(800), usage(300)], 1000), { inputTokens: 1100, inputTokensAreLowerBound: false,
    cap: 1000, remaining: 0, stop: true, reason: 'INPUT_TOKEN_CAP', overrun: 100 });
  assert.equal(campaignInputState([usage(500), usage(null)], 1000).reason, 'UNKNOWN_INPUT_USAGE');
  assert.equal(campaignInputState([usage(500, 1)], 1000).remaining, 0);
  assert.throws(() => campaignInputState([usage(-1)], 1000));
  assert.throws(() => campaignInputState([usage(Number.MAX_SAFE_INTEGER), usage(1)], Number.MAX_SAFE_INTEGER), /OVERFLOW/);
});

test('real guards require isolated databases, approvals and exact adapter research configuration', () => {
  const mock = createHarnessMockAdapter();
  const options = { variant: 'A', provider: 'real', model: 'gpt-5.6-luna', reasoning: 'max', taskKind: 'single' } as AblationOptions;
  const base = { options, env: { DATABASE_URL: 'postgresql://localhost/research_test_u03', RESEARCH_TEST_DATABASE_URL: 'postgresql://localhost/research_test_u03' },
    rubricFrozen: true, allLabelsConfirmed: true, registrationApproved: true, registrationBound: true, approvalReceiptBound: true, caseBlockers: [], peerReviewed: true };
  assert.deepEqual(databaseIsolationBlockers(base.env), []);
  assert.ok(databaseIsolationBlockers({ DATABASE_URL: 'postgresql://localhost/production', RESEARCH_TEST_DATABASE_URL: 'postgresql://localhost/production' }).length);
  assert.ok(databaseIsolationBlockers({ DATABASE_URL: 'postgresql://remote/research_test', RESEARCH_TEST_DATABASE_URL: 'postgresql://remote/research_test' }).length);
  assert.ok(realExecutionBlockers({ ...base, adapter: mock }).includes('APPROVED_PRODUCTION_ADAPTER_UNAVAILABLE'));
  const adapter: AblationExecutionAdapter = { ...mock, provider: 'real', supportedVariants: ['A'], assertDisposableDatabase: async () => {},
    researchConfiguration: { model: 'gpt-5.6-luna', reasoning: 'max', ...DEFAULT_ABLATION_BUDGET } };
  assert.deepEqual(realExecutionBlockers({ ...base, adapter }), []);
  assert.ok(realExecutionBlockers({ ...base, adapter, options: { ...options, model: 'different' } }).includes('ADAPTER_ACTUAL_RESEARCH_CONFIGURATION_MISMATCH'));
  assert.ok(realExecutionBlockers({ ...base, adapter, options: { ...options, variant: 'C2' } }).includes('RUNTIME_VARIANT_UNSUPPORTED:C2'));
  assert.ok(realExecutionBlockers({ ...base, adapter, approvalReceiptBound: false }).includes('EXPLICIT_USER_APPROVAL_RECEIPT_REQUIRED'));
});

test('dataset compatibility preserves unsupported units, restated facts and extra documents', async () => {
  const f = await fixture();
  const sample = structuredClone(f.dataset.cases[0]);
  sample.reference.facts[0].unit = 'million_yuan'; sample.reference.comparisonFacts = [{ synthetic: true }]; sample.documentIds.push('scan');
  const checked = caseCompatibility(sample);
  assert.ok(checked.scoringBlockers.includes('UNSUPPORTED_V1_UNIT:million_yuan'));
  assert.ok(checked.scoringBlockers.includes('RESTATED_COMPARISON_NOT_SUPPORTED_BY_V1'));
  assert.ok(checked.executionBlockers.includes('ADDITIONAL_DOCUMENT_SCOPE_NOT_SUPPORTED_BY_PRODUCTION_TASK'));
  assert.equal(sample.documentIds.length, 3);
  assert.throws(() => ablationDatasetSchema.parse({ ...f.dataset, visibility: 'hidden' }), /hidden holdout/);
  assert.throws(() => ablationDatasetSchema.parse({ ...f.dataset, cases: [sample, sample] }), /Duplicate/);
  assert.throws(() => ablationDatasetSchema.parse({ ...f.dataset, cases: [sample, { ...sample, id: sample.id.toUpperCase() }] }), /Duplicate/);
});

test('A completes all planned repeats with reports, v1/v2 scores and full denominators', async () => {
  const f = await fixture(4), run = await runAgentAblation(f.options({ repeats: 2 }), { repository: f.repository });
  assert.equal(run.summary.complete, true); assert.equal(run.summary.plannedRuns, 8); assert.equal(run.summary.savedRuns, 8);
  assert.equal(run.summary.plannedDenominators.numericItems, 72); assert.equal(run.summary.plannedDenominators.singleCompanyQuestions, 24);
  assert.equal(run.summary.v1?.numeric.total, 72); assert.equal(run.summary.v2?.answerableSupport.total, 24);
  assert.equal(run.summary.actualModelCalls, 0); assert.equal(run.summary.productionAcceptance, false);
  assert.equal(run.summary.results[0].reports.length, 1); assert.equal(run.summary.results[0].reports[0].report, null);
  assert.equal(run.summary.results[0].usage.measurement, 'simulated');
  assert.notEqual(run.summary.results[0].runKey, run.summary.results[4].runKey);
  assert.ok((await readFile(path.join(run.arm, 'results.md'), 'utf8')).includes('mock'));
});

test('all variant transport routes forward options without any provider request', async () => {
  const f = await fixture(3), base = createHarnessMockAdapter();
  const requests: { variant: string; concurrency: number; runtime: string }[] = [];
  let networkRequests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkRequests++; throw new Error('Unexpected network in mock'); };
  try {
    const adapter: AblationExecutionAdapter = { ...base, run: async request => {
      requests.push({ variant: request.variant, concurrency: request.concurrency, runtime: request.runtimeOptions.variant });
      return base.run(request);
    } };
    for (const variant of ABLATION_VARIANTS) {
      const peer = variant === 'C2-peer';
      const result = await runAgentAblation(f.options({ variant, taskKind: peer ? 'peer' : 'single', campaign: `data/research-agent-upgrade/evidence/U03/${peer ? 'peer' : 'single'}` }), { repository: f.repository, adapter });
      assert.equal(result.summary.actualModelCalls, 0);
      if (peer) {
        assert.equal(result.summary.plannedRuns, 1); assert.equal(result.summary.plannedDenominators.companyLegs, 2);
        assert.deepEqual(result.summary.peerUnpairedCaseIds, ['case-2']); assert.equal(result.summary.results[0].peerComparison?.status, 'not_scored');
      }
    }
    assert.equal(networkRequests, 0);
    for (const variant of ABLATION_VARIANTS) {
      const request = requests.find(request => request.variant === variant)!;
      assert.equal(request.runtime, variant); assert.equal(request.concurrency, VARIANT_CONCURRENCY[variant]);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test('protocol binding rejects changed model, data, scoring, code, budget, repeats, cache and concurrency', async () => {
  const f = await fixture(), run = await runAgentAblation(f.options(), { repository: f.repository });
  const { contract } = await readJson(path.join(run.campaign, 'protocol.json')) as { contract: AblationComparisonContract };
  const changes: ((copy: AblationComparisonContract) => void)[] = [
    copy => { copy.model = 'changed'; }, copy => { copy.reasoning = 'high'; }, copy => { copy.datasetSha256 = '0'.repeat(64); },
    copy => { copy.dataHashes.original = '0'.repeat(64); }, copy => { copy.codeHashes.runtime = '0'.repeat(64); },
    copy => { copy.rubricSha256 = '0'.repeat(64); }, copy => { copy.repeats++; }, copy => { copy.maxInputTokens++; },
    copy => { copy.cacheCondition = 'warm'; }, copy => { copy.concurrencyByVariant.C2 = 1; },
  ];
  for (const change of changes) { const copy = structuredClone(contract); change(copy); assert.throws(() => validateComparisonProtocol(contract, copy), /PROTOCOL_MISMATCH/); }
  await assert.rejects(runAgentAblation(f.options({ variant: 'B', model: 'different' }), { repository: f.repository }), /PROTOCOL_MISMATCH/);
  assert.equal((await readdir(run.campaign)).includes('B'), false);
});

test('existing arm is immutable and protocol digest tampering is refused', async () => {
  const f = await fixture(), run = await runAgentAblation(f.options(), { repository: f.repository });
  const before = await readFile(path.join(run.arm, 'results.json'));
  await assert.rejects(runAgentAblation(f.options(), { repository: f.repository }), /DIRECTORY_EXISTS/);
  assert.deepEqual(await readFile(path.join(run.arm, 'results.json')), before);
  const protocol = await readJson(path.join(run.campaign, 'protocol.json')); protocol.comparisonContractSha256 = '0'.repeat(64);
  await saveJson(path.join(run.campaign, 'protocol.json'), protocol);
  await assert.rejects(runAgentAblation(f.options({ variant: 'B' }), { repository: f.repository }), /DIGEST_MISMATCH/);
});

test('input cap spans arms and preserves partial and not-started results in every denominator', async () => {
  const f = await fixture(), options = f.options({ maxInputTokens: 2500 });
  await runAgentAblation(options, { repository: f.repository });
  const run = await runAgentAblation({ ...options, variant: 'B' }, { repository: f.repository });
  assert.deepEqual(run.summary.results.map(result => result.status), ['partial', 'not_started']);
  assert.equal(run.summary.stoppedEarly, true); assert.equal(run.summary.savedRuns, 2); assert.equal(run.summary.executedRuns, 1);
  assert.equal(run.summary.campaignInputUsage.inputTokens, 2500); assert.equal(run.summary.v1?.numeric.total, 18);
  assert.equal(run.summary.v2?.answerableSupport.total, 6);
  assert.equal(run.summary.results[1].scores[0].v1?.questionTotal, 3);
});

test('result-before-ledger crash recovery cannot reset campaign input cap', async () => {
  const f = await fixture(), options = f.options({ maxInputTokens: 2000 }), first = await runAgentAblation(options, { repository: f.repository });
  // Synthetic fault injection only: simulate a crash after immutable results but before journal append.
  await writeFile(path.join(first.campaign, 'usage-ledger.jsonl'), '');
  const second = await runAgentAblation({ ...options, variant: 'B' }, { repository: f.repository });
  assert.equal(second.summary.executedRuns, 0); assert.equal(second.summary.campaignInputUsage.inputTokens, 2000);
  assert.equal(second.summary.results.filter(result => result.status === 'not_started').length, 2);
  assert.equal((await readFile(path.join(first.campaign, 'usage-ledger.jsonl'), 'utf8')).trim().split('\n').length, 4);
});

test('known partial failure usage and report context survive while subsequent work may continue', async () => {
  const f = await fixture(), base = createHarnessMockAdapter();
  let calls = 0;
  const adapter: AblationExecutionAdapter = { ...base, run: async request => {
    const partial = await base.run(request); calls++;
    if (calls === 1) throw new AblationExecutionFailure('known failure', { ...partial, usage: usage(400), error: 'known failure' });
    return partial;
  } };
  const run = await runAgentAblation(f.options(), { repository: f.repository, adapter });
  assert.equal(calls, 2); assert.equal(run.summary.results[0].status, 'failed'); assert.equal(run.summary.results[0].usage.inputTokens, 400);
  assert.ok(run.summary.results[0].reports[0].hardErrors.includes('ADAPTER_FAILURE'));
  assert.equal(run.summary.campaignInputUsage.inputTokens, 1400); assert.equal(run.summary.plannedDenominators.numericItems, 18);
});

test('unknown failure usage stops all later work and remains unknown across arms', async () => {
  const f = await fixture(), base = createHarnessMockAdapter(); let calls = 0;
  const adapter: AblationExecutionAdapter = { ...base, run: async () => { calls++; throw new Error('failure Bearer private-token'); } };
  const first = await runAgentAblation(f.options(), { repository: f.repository, adapter });
  const second = await runAgentAblation(f.options({ variant: 'B' }), { repository: f.repository, adapter });
  assert.equal(calls, 1); assert.equal(first.summary.results[0].usage.inputTokens, null);
  assert.equal(first.summary.results[1].status, 'not_started'); assert.equal(second.summary.executedRuns, 0);
  assert.equal(second.summary.campaignInputUsage.inputTokensAreLowerBound, true);
  assert.equal((await readFile(path.join(first.arm, 'results.json'), 'utf8')).includes('private-token'), false);
});

test('adapter report-set mismatch retains reported cost and records a failed run', async () => {
  const f = await fixture(), base = createHarnessMockAdapter();
  const adapter: AblationExecutionAdapter = { ...base, run: async request => ({ ...await base.run(request), reports: [] }) };
  const run = await runAgentAblation(f.options(), { repository: f.repository, adapter });
  assert.equal(run.summary.results[0].status, 'failed'); assert.equal(run.summary.results[0].usage.inputTokens, 1000);
  assert.ok(run.summary.results[0].error?.includes('REPORT_SET_MISMATCH')); assert.equal(run.summary.savedRuns, 2);
});

test('budget overrun is retained and stops following tasks', async () => {
  const f = await fixture(), base = createHarnessMockAdapter();
  const adapter: AblationExecutionAdapter = { ...base, run: async request => ({ ...await base.run(request), usage: usage(1200) }) };
  const run = await runAgentAblation(f.options({ maxInputTokens: 1000 }), { repository: f.repository, adapter });
  assert.equal(run.summary.results[0].status, 'failed'); assert.equal(run.summary.campaignInputUsage.overrun, 200);
  assert.equal(run.summary.results[1].status, 'not_started'); assert.equal(run.summary.savedRuns, 2);
});

test('ledger result tampering, duplicate rows and usage substitution are refused', async () => {
  for (const fault of ['result', 'duplicate', 'usage'] as const) {
    const f = await fixture(), first = await runAgentAblation(f.options(), { repository: f.repository });
    const ledger = path.join(first.campaign, 'usage-ledger.jsonl'), rows = (await readFile(ledger, 'utf8')).trim().split('\n');
    if (fault === 'result') await writeFile(path.join(first.campaign, JSON.parse(rows[0]).resultFile), '{"tampered":true}');
    if (fault === 'duplicate') await writeFile(ledger, `${rows.join('\n')}\n${rows[0]}\n`);
    if (fault === 'usage') { const row = JSON.parse(rows[0]); row.usage.inputTokens = 0; rows[0] = JSON.stringify(row); await writeFile(ledger, `${rows.join('\n')}\n`); }
    await assert.rejects(runAgentAblation(f.options({ variant: 'B' }), { repository: f.repository }), /LEDGER_/);
  }
});

test('comparisons rebuild scores from verified per-run results instead of mutable summaries', async () => {
  const f = await fixture(), first = await runAgentAblation(f.options(), { repository: f.repository });
  const file = path.join(first.arm, 'results.json'), summary = await readJson(file);
  for (const question of summary.results[0].scores[0].v2.questions) question.diagnostic.resolvedCorrectly = true;
  await saveJson(file, summary);
  const second = await runAgentAblation(f.options({ variant: 'B' }), { repository: f.repository });
  const comparisons = await readJson(path.join(second.arm, 'comparisons.json'));
  assert.equal(comparisons[0].result.baselinePassed, 0);
  assert.equal(comparisons[0].result.difference, 0);
});

test('dataset, original and parser receipt junctions cannot escape the repository', async () => {
  for (const kind of ['dataset', 'original', 'receipt'] as const) {
    const f = await fixture(), outside = await mkdtemp(path.join(workspace, 'outside-input-'));
    await symlink(outside, path.join(f.repository, 'linked-input'), process.platform === 'win32' ? 'junction' : 'dir');
    if (kind === 'dataset') await writeFile(path.join(outside, 'fixture.json'), await readFile(path.join(f.repository, 'fixtures/synthetic.json')));
    if (kind === 'original') {
      const document = f.dataset.documents[0]; await writeFile(path.join(outside, 'original.txt'), await readFile(path.join(f.repository, document.path)));
      document.path = 'linked-input/original.txt'; await f.writeDataset();
    }
    if (kind === 'receipt') {
      const document = f.dataset.documents[0]; await writeFile(path.join(outside, 'receipt.json'), await readFile(path.join(f.repository, document.parserReceipt.path)));
      document.parserReceipt.path = 'linked-input/receipt.json'; await f.writeDataset();
    }
    await assert.rejects(runAgentAblation(f.options(kind === 'dataset' ? { dataset: 'linked-input/fixture.json' } : {}), { repository: f.repository }), /SYMLINK|EXTERNAL|OUTSIDE/);
  }
});

test('started runs with no result cannot be silently retried or treated as zero cost', async () => {
  const f = await fixture(), first = await runAgentAblation(f.options(), { repository: f.repository });
  const directory = path.join(first.campaign, 'B/repeat-001/case-0'); await mkdir(directory, { recursive: true });
  await saveJson(path.join(directory, 'started.json'), { syntheticInterrupted: true });
  await assert.rejects(runAgentAblation(f.options({ variant: 'C1' }), { repository: f.repository }), /PRIOR_RUN_USAGE_UNKNOWN/);
});

test('controlled output paths and Windows junctions cannot redirect evidence writes', async () => {
  const f = await fixture();
  await assert.rejects(runAgentAblation(f.options({ campaign: 'elsewhere' }), { repository: f.repository }), /CONTROLLED_CAMPAIGN/);
  const redirect = path.join(f.repository, 'data/research-agent-upgrade/evidence/U03/redirect'), target = path.join(f.repository, 'elsewhere');
  await mkdir(path.dirname(redirect), { recursive: true }); await mkdir(target);
  await symlink(target, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runAgentAblation(f.options({ campaign: 'data/research-agent-upgrade/evidence/U03/redirect/campaign' }), { repository: f.repository }), /SYMLINK/);
  assert.deepEqual(await readdir(target), []);
});

test('incompatible cases stay in the run matrix and suppress aggregate scores', async () => {
  const f = await fixture(4);
  f.dataset.cases[0].reference.facts[0].unit = 'million_yuan';
  f.dataset.cases[1].reference.comparisonFacts = [{ syntheticRestatement: true }];
  f.dataset.cases[2].documentIds.push(f.dataset.cases[2].documentIds[0].replace('2023', 'scan'));
  const scanId = f.dataset.cases[2].documentIds[2], original = f.dataset.documents.find(document => document.id === f.dataset.cases[2].documentIds[0])!;
  f.dataset.documents.push({ ...original, id: scanId }); await f.writeDataset();
  const run = await runAgentAblation(f.options(), { repository: f.repository });
  assert.equal(run.summary.plannedRuns, 4); assert.equal(run.summary.results.length, 4); assert.equal(run.summary.v1, null); assert.equal(run.summary.v2, null);
  assert.equal(run.summary.plannedDenominators.numericItems, 36); assert.equal(run.summary.scoringCoverage.totalCompanyLegs, 4);
  assert.equal(run.summary.scoringCoverage.v1ScoredCompanyLegs, 2); assert.equal(run.summary.scoringCoverage.v2ScoredCompanyLegs, 1);
  assert.ok(run.summary.results[2].scores[0].notScored.some(reason => reason.includes('V2_LABEL_CASE_BINDING')));
});

test('real runner rejects pending registration and missing adapters before any execution', async () => {
  const f = await fixture(); let calls = 0, databaseProofs = 0;
  const mock = createHarnessMockAdapter();
  const adapter: AblationExecutionAdapter = { ...mock, provider: 'real', researchConfiguration: { model: 'gpt-5.6-luna', reasoning: 'max', ...DEFAULT_ABLATION_BUDGET },
    assertDisposableDatabase: async () => { databaseProofs++; }, run: async request => { calls++; return mock.run(request); } };
  const options = f.options({ provider: 'real', model: 'gpt-5.6-luna', reasoning: 'max' });
  await assert.rejects(runAgentAblation(options, { repository: f.repository }), /APPROVED_PRODUCTION_ADAPTER_UNAVAILABLE/);
  await assert.rejects(runAgentAblation(options, { repository: f.repository, adapter }), /RUBRIC_NOT_HUMAN_FROZEN/);
  assert.equal(calls, 0); assert.equal(databaseProofs, 0);
  assert.equal(contractSha256(f.dataset).length, 64);
});
