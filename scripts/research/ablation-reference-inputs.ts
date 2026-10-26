import { loadConfirmedReferences } from '../../src/lib/eval/confirmed-reference-loader';
import { answerabilityDatasetSchema } from '../../src/lib/eval/financial-research-score-v2';
import { canonicalResearchJson } from '../../src/lib/company-research/task-contracts';
import { ablationSha256, contractSha256, type AblationCase } from './ablation-protocol';
import { createFixtureTaskInput, readScopedFixtureFile } from './fixture-task-adapter';

/** Keep the two accepted generations separate; an overlay never rewrites historical labels. */
export async function loadAblationConfirmedInputs(repository: string, dataset: { datasetVersion: string; cases: AblationCase[] }, datasetSha256: string, documents: unknown[]) {
  const confirmed = await loadConfirmedReferences(repository);
  if (confirmed.binding.sourceDatasetSha256 !== datasetSha256 || confirmed.references.sourceDataset.datasetVersion !== dataset.datasetVersion) throw new Error('ABLATION_CONFIRMED_REFERENCE_DATASET_BINDING');
  const labelPath = 'fixtures/company-research/answerability-dev-v1.json';
  const labelBytes = await readScopedFixtureFile(repository, labelPath), labelSha256 = ablationSha256(labelBytes);
  if (labelSha256 !== 'c43df428b0bda80c41d98bf273e06bc35b4efe955098556d9a5656d60f648d61') throw new Error('ABLATION_LEGACY_LABEL_HASH');
  const labels = answerabilityDatasetSchema.parse(JSON.parse(labelBytes.toString()));
  const legacyDatasetBytes = await readScopedFixtureFile(repository, 'fixtures/company-research/development.json');
  if (ablationSha256(legacyDatasetBytes) !== labels.sourceDatasetSha256) throw new Error('ABLATION_LEGACY_LABEL_SOURCE_HASH');
  const legacyDataset = JSON.parse(legacyDatasetBytes.toString()) as { cases: AblationCase[] };
  for (const label of labels.cases) {
    const sample = dataset.cases.find(sample => sample.id === label.caseId), original = legacyDataset.cases.find(sample => sample.id === label.caseId);
    const facts = (sample: AblationCase) => sample.reference.facts.map(fact => ({ metric: fact.metric, period: { start: fact.period.start, end: fact.period.end }, rawValue: fact.rawValue, unit: fact.unit, normalizedYuan: fact.normalizedYuan }));
    if (!sample || !original || canonicalResearchJson(sample.documentIds) !== canonicalResearchJson(label.documentIds) || canonicalResearchJson(facts(sample)) !== canonicalResearchJson(facts(original))
      || canonicalResearchJson(sample.reference.changes.map(change => ({ metric: change.metric, percentage: change.percentage }))) !== canonicalResearchJson(original.reference.changes.map(change => ({ metric: change.metric, percentage: change.percentage })))) throw new Error(`ABLATION_LEGACY_REFERENCE_CHANGED:${label.caseId}`);
    for (const question of label.questions) {
      for (const evidence of question.evidenceRefs) if (ablationSha256(await readScopedFixtureFile(repository, evidence.path)) !== evidence.sha256) throw new Error('ABLATION_LEGACY_EVIDENCE_HASH');
      if (question.confirmation && ablationSha256(await readScopedFixtureFile(repository, question.confirmation.receiptPath)) !== question.confirmation.receiptSha256) throw new Error('ABLATION_LEGACY_CONFIRMATION_HASH');
    }
  }
  const referenceCases = new Map(confirmed.references.cases.map(reference => [reference.caseId, reference]));
  const legacyLabels = new Map(labels.cases.map(label => [label.caseId, label]));
  if (dataset.cases.length !== referenceCases.size + legacyLabels.size || dataset.cases.some(sample => Number(referenceCases.has(sample.id)) + Number(legacyLabels.has(sample.id)) !== 1)) throw new Error('ABLATION_V3_COMPLETE_REFERENCE_COVERAGE_REQUIRED');
  const fixtureInputs = new Map(dataset.cases.map(sample => [sample.id, createFixtureTaskInput(sample, documents)]));
  return { confirmed, referenceCases, legacyLabels, fixtureInputs,
    referenceBindingSha256: contractSha256({ ...confirmed.binding, legacyLabelsSha256: labelSha256 }),
    hashes: { ...confirmed.binding.verifiedHashes, [labelPath]: labelSha256, 'fixtures/company-research/development.json': labels.sourceDatasetSha256 } };
}
export type AblationConfirmedInputs = Awaited<ReturnType<typeof loadAblationConfirmedInputs>>;
