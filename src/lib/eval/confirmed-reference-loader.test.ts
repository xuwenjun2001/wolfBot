import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { confirmedReferenceDatasetSchema } from './confirmed-reference-contracts';
import { CONFIRMED_RECEIPT_SHA256, CONFIRMED_REFERENCE_PATH, loadConfirmedReferences, validateConfirmedReferenceBindings } from './confirmed-reference-loader';

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
describe('accepted bounded references', () => {
  it('checks the actual receipt, card, dataset and evidence hashes and retains all three numerical groups', async () => {
    const loaded = await loadConfirmedReferences();
    expect(loaded.counts).toEqual({ cases: 10, comparativeAmounts: 60, percentages: 30, originalPriorDisclosures: 9, cashFlowAnswerable: 10, confirmedNotDisclosed: 0, wholeCompanyGolden: 0 });
    expect(loaded.binding.receiptSha256).toBe(CONFIRMED_RECEIPT_SHA256);
    expect(Object.keys(loaded.binding.verifiedHashes)).toHaveLength(11);
    expect(loaded.binding.executionApproved).toBe(false);
    expect(loaded.references.integration.scorerIntegrated).toBe(false); // Original historical record stays immutable.
    expect(loaded.references.cases.filter(sample => sample.risks.fullQuestionCoverage === 'partial').map(sample => sample.caseId).sort()).toEqual(['dev-600036', 'dev-601318']);
  });

  it('rejects altered accepted-card bytes even when all JSON inputs are unchanged', async () => {
    const loaded = await loadConfirmedReferences();
    const parent = path.resolve('data/research-agent-upgrade/evidence/U04/engineering-20261026/evaluation/test-workspaces');
    await mkdir(parent, { recursive: true });
    const repository = await mkdtemp(path.join(parent, 'confirmed-hash-'));
    for (const file of Object.keys(loaded.binding.verifiedHashes)) {
      const target = path.join(repository, file); await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(file));
    }
    expect((await loadConfirmedReferences(repository)).counts.comparativeAmounts).toBe(60);
    await appendFile(path.join(repository, loaded.references.choiceCard.path), '\n');
    await expect(loadConfirmedReferences(repository)).rejects.toThrow('CONFIRMED_REFERENCE_HASH');
  });

  it('refuses numeric, original disclosure, document scope and risk-coverage promotions', async () => {
    const reference = await json(CONFIRMED_REFERENCE_PATH), dataset = await json('fixtures/company-research/development-v2.json');
    const wrongArithmetic = structuredClone(reference); wrongArithmetic.cases[0].numericalReference.figures[0].previous.normalizedYuan = '1';
    expect(() => confirmedReferenceDatasetSchema.parse(wrongArithmetic)).toThrow();
    const droppedOriginal = structuredClone(reference); droppedOriginal.cases[0].numericalReference.originalPriorDisclosures.pop();
    expect(() => confirmedReferenceDatasetSchema.parse(droppedOriginal)).toThrow();
    const wrongOriginal = structuredClone(reference); wrongOriginal.cases[0].numericalReference.originalPriorDisclosures[0].source.filePage++;
    expect(() => validateConfirmedReferenceBindings(wrongOriginal, dataset)).toThrow('ORIGINAL_DISCLOSURE_CHANGED');
    const droppedScan = structuredClone(reference); droppedScan.cases.find((sample: { caseId: string }) => sample.caseId === 'dev-002304').taskDocumentIds.pop();
    expect(() => validateConfirmedReferenceBindings(droppedScan, dataset)).toThrow('CASE_BINDING');
    const wrongSource = structuredClone(reference); wrongSource.cases[0].cashFlow.sourceRanges[0].bytesSha256 = '0'.repeat(64);
    expect(() => validateConfirmedReferenceBindings(wrongSource, dataset)).toThrow('SOURCE_BINDING');
    const riskPromotion = structuredClone(reference); riskPromotion.cases.find((sample: { caseId: string }) => sample.caseId === 'dev-601318').risks.fullQuestionCoverage = 'not_assessed_by_this_overlay';
    expect(() => confirmedReferenceDatasetSchema.parse(riskPromotion)).toThrow('may not be promoted');
    const unconfirmedAbstention = structuredClone(reference); unconfirmedAbstention.cases[9].cashFlow.answerability = 'not_disclosed';
    expect(() => confirmedReferenceDatasetSchema.parse(unconfirmedAbstention)).toThrow();
  });
});
