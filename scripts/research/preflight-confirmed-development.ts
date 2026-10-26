import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalResearchJson } from '../../src/lib/company-research/task-contracts';
import { FINANCIAL_SCORING_V3 } from '../../src/lib/eval/financial-research-score-v3';
import { ablationDatasetSchema, ablationSha256, caseCompatibility } from './ablation-protocol';
import { loadAblationConfirmedInputs } from './ablation-reference-inputs';
import { loadFixtureTaskDocuments, readScopedFixtureFile } from './fixture-task-adapter';

/** Read fixed public development bytes only; importing this module starts no work. */
export async function preflightConfirmedDevelopment(outputDirectory: string, repository = process.cwd()) {
  const root = await realpath(repository), output = path.resolve(root, outputDirectory);
  const evidenceRoot = path.join(root, 'data/research-agent-upgrade/evidence/U04/engineering-20261026/evaluation');
  const relative = path.relative(evidenceRoot, output);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('PREFLIGHT_EXPLICIT_EVIDENCE_SUBDIRECTORY_REQUIRED');
  const datasetPath = 'fixtures/company-research/development-v2.json', bytes = await readScopedFixtureFile(root, datasetPath);
  const dataset = ablationDatasetSchema.parse(JSON.parse(bytes.toString()));
  if (!dataset.documents) throw new Error('PREFLIGHT_EXPLICIT_DOCUMENT_MANIFEST_REQUIRED');
  const inputs = await loadAblationConfirmedInputs(root, dataset, ablationSha256(bytes), dataset.documents);
  const cases = [];
  for (const sample of dataset.cases) {
    const input = inputs.fixtureInputs.get(sample.id)!;
    const loaded = await loadFixtureTaskDocuments(input, '11111111-1111-4111-8111-111111111111', root);
    const encoded = canonicalResearchJson(input);
    for (const forbidden of ['reference', 'acceptedReference', 'answerabilityDrafts', 'normalizedYuan', 'rawValue']) if (encoded.includes(`"${forbidden}"`)) throw new Error(`PREFLIGHT_ANSWER_INPUT_LEAK:${sample.id}`);
    cases.push({ caseId: sample.id, periods: input.spec.periods, documentScope: input.documentScope,
      taskInputSha256: createHash('sha256').update(encoded).digest('hex'), compatibility: caseCompatibility(sample, 'confirmed-v3'),
      documents: loaded.map(({ document, original, parsed }) => ({ documentId: document.id, originalSha256: ablationSha256(original), parserReceiptSha256: ablationSha256(parsed),
        byteLength: original.length, state: document.state, pageCount: document.pageCount, failedPages: document.parser?.failedPages ?? [], warnings: document.parser?.warnings ?? [] })) });
  }
  const sourceFiles = ['scripts/research/preflight-confirmed-development.ts', 'scripts/research/fixture-task-adapter.ts', 'scripts/research/ablation-reference-inputs.ts',
    'scripts/research/ablation-protocol.ts', 'scripts/research/run-agent-ablation.ts', 'src/lib/eval/confirmed-reference-contracts.ts',
    'src/lib/eval/confirmed-reference-loader.ts', 'src/lib/eval/financial-research-score-v3.ts', 'src/lib/company-research/document-contracts.ts',
    'src/lib/company-research/exact-decimal.ts', 'src/lib/company-research/financial-comparison.ts', 'src/lib/company-research/parsed-document.ts'];
  const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, ablationSha256(await readScopedFixtureFile(root, file))])));
  const result = { schemaVersion: 1, kind: 'confirmed_development_source_and_execution_input_preflight', checkedAt: new Date().toISOString(),
    scoringVersion: FINANCIAL_SCORING_V3, datasetSha256: ablationSha256(bytes), referenceBinding: inputs.confirmed.binding, counts: inputs.confirmed.counts,
    companies: cases.length, questions: cases.length * 3, documents: cases.reduce((sum, sample) => sum + sample.documents.length, 0),
    partialDocuments: cases.flatMap(sample => sample.documents.filter(document => document.state !== 'ready').map(document => document.documentId)),
    sourceSha256, cases, actualModelCalls: 0, networkCalls: 0, databaseCalls: 0, holdoutContentsRead: false,
    officialScoringEligible: false, g0Passed: false, executionApproved: false,
    limits: ['Uses fixed historical parser receipts; newer parser evidence needs a separately frozen derived manifest.',
      'Source binding and input compatibility do not establish complete OCR, source semantics, full risk coverage or model quality.',
      'No confirmed non-disclosure stratum, full-dataset label freeze, final adapter protocol, pricing or execution approval.'] };
  let cursor = root;
  for (const segment of path.relative(root, output).split(path.sep)) {
    cursor = path.join(cursor, segment); await mkdir(cursor, { recursive: true });
    const entry = await lstat(cursor); if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('PREFLIGHT_OUTPUT_SYMLINK');
  }
  await writeFile(path.join(output, 'preflight.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return { evidence: output, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || !arguments_[0].startsWith('--output=')) throw new Error('PREFLIGHT_EXPLICIT_OUTPUT_REQUIRED');
  preflightConfirmedDevelopment(arguments_[0].slice('--output='.length)).then(({ evidence, result }) => console.log(JSON.stringify({ evidence, companies: result.companies,
    questions: result.questions, documents: result.documents, referenceCounts: result.counts, actualModelCalls: 0, executionApproved: false }))).catch(error => { console.error(error instanceof Error ? error.message : 'Preflight failed'); process.exitCode = 1; });
}
