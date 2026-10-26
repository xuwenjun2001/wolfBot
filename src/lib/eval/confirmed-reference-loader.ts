import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalResearchJson } from '../company-research/task-contracts';
import { confirmedReferenceDatasetSchema, type ConfirmedReferenceDataset } from './confirmed-reference-contracts';

export const CONFIRMED_REFERENCE_PATH = 'fixtures/company-research/confirmed-references-20261026.json';
export const CONFIRMED_REFERENCE_SHA256 = '441db0d606042d06392a06bd6628a1134bc50a4c6e8bc1d911c67cc26f5b14c6';
export const CONFIRMED_RECEIPT_PATH = 'data/research-agent-upgrade/evidence/U04/confirmation-20261026-01/confirmation.json';
export const CONFIRMED_RECEIPT_SHA256 = 'c034d837afcb9ba73763d1358470808113350c2af74be4e1c0cedf83aeabc466';
const digest = z.string().regex(/^[a-f0-9]{64}$/), binding = z.object({ path: z.string().min(1), sha256: digest }).passthrough();
const datasetSchema = z.object({ datasetVersion: z.string(), documents: z.array(z.object({ id: z.string(), symbol: z.string(), bytesSha256: digest,
  pageCount: z.number().int().positive(), period: z.object({ start: z.string(), end: z.string() }).passthrough() }).passthrough()),
cases: z.array(z.object({ id: z.string(), company: z.object({ symbol: z.string(), name: z.string() }), documentIds: z.array(z.string()),
  periods: z.array(z.object({ start: z.string(), end: z.string(), kind: z.string() })),
  reference: z.object({ facts: z.array(z.object({ metric: z.string(), rawValue: z.string(), unit: z.string(), normalizedYuan: z.string(),
    citation: z.object({ documentId: z.string(), bytesSha256: digest, filePage: z.number() }).passthrough() }).passthrough()) }).passthrough(),
}).passthrough()) }).passthrough();
const receiptSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('bounded_reference_and_configuration_selection'),
  status: z.literal('selection_recorded'), originalResponse: z.literal('A A  A B'), choices: z.object({ Q6: z.literal('A'), Q7: z.literal('A'), Q8: z.literal('A'), Q9: z.literal('B') }),
  choiceCard: binding, inputBindings: z.array(binding), confirmationDocument: binding,
  referenceArtifact: binding.extend({ version: z.string() }), executionApproved: z.literal(false), g0Passed: z.literal(false),
  formalScoringIntegrated: z.literal(false), gatesPassedByThisReceipt: z.array(z.never()),
}).passthrough();
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Every located source remains inside the original registered task scope. */
export function validateConfirmedReferenceBindings(input: unknown, datasetInput: unknown) {
  const references = confirmedReferenceDatasetSchema.parse(input), dataset = datasetSchema.parse(datasetInput);
  if (references.sourceDataset.datasetVersion !== dataset.datasetVersion) throw new Error('CONFIRMED_REFERENCE_DATASET_VERSION');
  let comparativeAmounts = 0, percentages = 0, originalPriorDisclosures = 0;
  for (const sample of references.cases) {
    const original = dataset.cases.find(candidate => candidate.id === sample.caseId);
    if (!original || canonicalResearchJson(original.company) !== canonicalResearchJson(sample.company) || canonicalResearchJson(original.periods) !== canonicalResearchJson(sample.periods)
      || canonicalResearchJson([...original.documentIds].sort()) !== canonicalResearchJson([...sample.taskDocumentIds].sort())) throw new Error(`CONFIRMED_REFERENCE_CASE_BINDING:${sample.caseId}`);
    const sources = [...sample.numericalReference.figures.flatMap(figure => [figure.previous.source, figure.current.source]), ...sample.numericalReference.originalPriorDisclosures.map(figure => figure.source)];
    for (const source of [...sources.map(source => ({ ...source, filePageEnd: source.filePage })), ...sample.cashFlow.sourceRanges, ...sample.risks.sourceRanges]) {
      const document = dataset.documents.find(document => document.id === source.documentId);
      if (!document || !original.documentIds.includes(document.id) || document.symbol !== sample.company.symbol || document.bytesSha256 !== source.bytesSha256 || source.filePageEnd > document.pageCount) throw new Error(`CONFIRMED_REFERENCE_SOURCE_BINDING:${sample.caseId}:${source.documentId}`);
    }
    for (const figure of sample.numericalReference.figures) {
      const previousDocument = dataset.documents.find(document => document.id === figure.previous.source.documentId)!;
      const currentDocument = dataset.documents.find(document => document.id === figure.current.source.documentId)!;
      const previousPeriod = sample.numericalReference.comparisonBasis === 'restated_comparative' ? sample.periods[1] : sample.periods[0];
      if (currentDocument.period.start !== sample.periods[1].start || currentDocument.period.end !== sample.periods[1].end
        || previousDocument.period.start !== previousPeriod.start || previousDocument.period.end !== previousPeriod.end
        || (sample.numericalReference.comparisonBasis === 'restated_comparative' && (previousDocument.id !== currentDocument.id || figure.previous.source.filePage !== figure.current.source.filePage))) throw new Error(`CONFIRMED_REFERENCE_COMPARATIVE_PERIOD_BINDING:${sample.caseId}`);
    }
    for (const figure of sample.numericalReference.originalPriorDisclosures) {
      const fact = original.reference.facts.find(fact => fact.metric === figure.metric && fact.citation.documentId === figure.source.documentId);
      if (!fact || fact.rawValue !== figure.rawValue || fact.unit !== figure.unit || fact.normalizedYuan !== figure.normalizedYuan || fact.citation.bytesSha256 !== figure.source.bytesSha256 || fact.citation.filePage !== figure.source.filePage) throw new Error(`CONFIRMED_REFERENCE_ORIGINAL_DISCLOSURE_CHANGED:${sample.caseId}`);
    }
    for (const supporting of sample.supportingDocumentAcceptance) if (!sample.taskDocumentIds.includes(supporting.documentId)) throw new Error('CONFIRMED_REFERENCE_SUPPORTING_SCOPE');
    comparativeAmounts += sample.numericalReference.figures.length * 2;
    percentages += sample.numericalReference.figures.length;
    originalPriorDisclosures += sample.numericalReference.originalPriorDisclosures.length;
  }
  if (comparativeAmounts !== 60 || percentages !== 30 || originalPriorDisclosures !== 9) throw new Error('CONFIRMED_REFERENCE_DENOMINATOR');
  return { references, counts: { cases: references.cases.length, comparativeAmounts, percentages, originalPriorDisclosures,
    cashFlowAnswerable: references.cases.length, confirmedNotDisclosed: 0, wholeCompanyGolden: 0 } };
}
async function controlledRead(repository: string, file: string) {
  const target = path.resolve(repository, file), relative = path.relative(repository, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('CONFIRMED_REFERENCE_PATH_SCOPE');
  let cursor = repository;
  for (const segment of relative.split(path.sep)) { cursor = path.join(cursor, segment); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('CONFIRMED_REFERENCE_SYMLINK'); }
  const real = path.relative(repository, await realpath(target));
  if (!(await lstat(target)).isFile() || real === '..' || real.startsWith(`..${path.sep}`) || path.isAbsolute(real)) throw new Error('CONFIRMED_REFERENCE_PATH_SCOPE');
  return readFile(target);
}
export interface LoadedConfirmedReferences {
  references: ConfirmedReferenceDataset; counts: ReturnType<typeof validateConfirmedReferenceBindings>['counts'];
  binding: { referenceVersion: string; referenceSha256: string; receiptSha256: string; sourceDatasetSha256: string; verifiedHashes: Record<string, string>; executionApproved: false };
}
/** Fixed acceptance bytes are checked independently of the historical artifact's integration flags. */
export async function loadConfirmedReferences(repository = process.cwd()): Promise<LoadedConfirmedReferences> {
  const root = await realpath(repository), verifiedHashes: Record<string, string> = {};
  const verify = async (ref: { path: string; sha256: string }) => {
    const bytes = await controlledRead(root, ref.path), actual = sha(bytes);
    if (actual !== ref.sha256) throw new Error(`CONFIRMED_REFERENCE_HASH:${ref.path}`);
    verifiedHashes[ref.path] = actual;
    return bytes;
  };
  const bytes = await verify({ path: CONFIRMED_REFERENCE_PATH, sha256: CONFIRMED_REFERENCE_SHA256 });
  const references = confirmedReferenceDatasetSchema.parse(JSON.parse(bytes.toString()));
  const receiptBytes = await verify({ path: CONFIRMED_RECEIPT_PATH, sha256: CONFIRMED_RECEIPT_SHA256 });
  const receipt = receiptSchema.parse(JSON.parse(receiptBytes.toString()));
  if (receipt.referenceArtifact.path !== CONFIRMED_REFERENCE_PATH || receipt.referenceArtifact.sha256 !== CONFIRMED_REFERENCE_SHA256 || receipt.referenceArtifact.version !== references.referenceVersion
    || canonicalResearchJson(receipt.choices) !== canonicalResearchJson(references.confirmation.choices) || receipt.choiceCard.path !== references.choiceCard.path || receipt.choiceCard.sha256 !== references.choiceCard.sha256
    || receipt.confirmationDocument.path !== references.confirmation.path || receipt.confirmationDocument.sha256 !== references.confirmation.sha256) throw new Error('CONFIRMED_REFERENCE_RECEIPT_BINDING');
  const inputs = [references.sourceDataset, references.choiceCard, references.confirmation, ...references.evidence, ...receipt.inputBindings];
  if (new Set(receipt.inputBindings.map(ref => ref.path)).size !== receipt.inputBindings.length) throw new Error('CONFIRMED_REFERENCE_DUPLICATE_RECEIPT_INPUT');
  for (const ref of inputs) await verify(ref);
  for (const sample of references.cases) if (sample.cashFlow.accountingBridge) await verify(sample.cashFlow.accountingBridge);
  const dataset = JSON.parse((await verify(references.sourceDataset)).toString());
  const validated = validateConfirmedReferenceBindings(references, dataset);
  return { ...validated, binding: { referenceVersion: references.referenceVersion, referenceSha256: CONFIRMED_REFERENCE_SHA256, receiptSha256: CONFIRMED_RECEIPT_SHA256,
    sourceDatasetSha256: references.sourceDataset.sha256, verifiedHashes, executionApproved: false } };
}
