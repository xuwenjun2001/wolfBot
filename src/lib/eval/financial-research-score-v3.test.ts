import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { financialFactSchema, type FinancialFact } from '../company-research/document-contracts';
import { researchReportRevisionSchema } from '../company-research/revision-contracts';
import { reportFixture } from '../company-research/version-test-fixtures';
import type { ConfirmedReferenceCase } from './confirmed-reference-contracts';
import { loadConfirmedReferences } from './confirmed-reference-loader';
import type { EvaluationCase } from './financial-research-score';
import { financialResearchRubricV2Schema } from './financial-research-score-v2';
import { scoreFinancialCaseV3, summarizeScoresV3, compareFinancialScoresV3 } from './financial-research-score-v3';

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
/** Synthetic report only; deliberately not an original-text or model-quality acceptance. */
function syntheticReport(reference: ConfirmedReferenceCase, sample: EvaluationCase) {
  const facts: FinancialFact[] = [];
  for (const figure of reference.numericalReference.figures) {
    const basis = reference.numericalReference.comparisonBasis === 'restated_comparative';
    const header = { documentId: figure.current.source.documentId, documentVersion: 1, bytesSha256: figure.current.source.bytesSha256,
      locator: { kind: 'page' as const, filePage: figure.current.source.filePage }, quote: `SYNTHETIC TEST HEADER ${reference.periods[0].end.slice(0, 4)} ${reference.periods[1].end.slice(0, 4)}` };
    for (const [index, value] of [figure.previous, figure.current].entries()) facts.push(financialFactSchema.parse({
      id: `${figure.metric}_${index}`, companySymbol: sample.company.symbol,
      period: { ...reference.periods[index], id: `FY${reference.periods[index].end.slice(0, 4)}`, basis: 'cumulative' },
      metric: figure.metric, scope: 'consolidated', restatement: basis && index === 0 ? 'restated' : 'original',
      value: { status: 'known', raw: value.rawValue, unit: figure.unit, currency: 'CNY', decimals: value.rawValue.split('.')[1]?.length ?? 0 },
      citations: [{ documentId: value.source.documentId, documentVersion: 1, bytesSha256: value.source.bytesSha256,
        locator: { kind: 'page', filePage: value.source.filePage }, quote: `SYNTHETIC SCORING TEST ${value.rawValue}` }],
      ...(basis ? { accountingBasis: 'synthetic_disclosed_comparative', periodEvidence: [header] } : {}),
    }));
  }
  for (const original of reference.numericalReference.originalPriorDisclosures) facts.push(financialFactSchema.parse({
    id: `${original.metric}_original`, companySymbol: sample.company.symbol, period: { ...reference.periods[0], id: `FY${reference.periods[0].end.slice(0, 4)}`, basis: 'cumulative' },
    metric: original.metric, scope: 'consolidated', restatement: 'original', value: { status: 'known', raw: original.rawValue, unit: original.unit, currency: 'CNY', decimals: original.rawValue.split('.')[1]?.length ?? 0 },
    citations: [{ documentId: original.source.documentId, documentVersion: 1, bytesSha256: original.source.bytesSha256,
      locator: { kind: 'page', filePage: original.source.filePage }, quote: `SYNTHETIC ORIGINAL TEST ${original.rawValue}` }],
  }));
  return researchReportRevisionSchema.parse({ ...reportFixture(), companySymbol: sample.company.symbol, asOf: sample.asOf,
    periodIds: reference.periods.map(period => `FY${period.end.slice(0, 4)}`), facts, gaps: [],
    claims: ['income_profit', 'cash_flow', 'risks'].map(questionId => ({ id: `synthetic_${questionId}`, questionId,
      text: 'Synthetic scoring-transport report; no source semantics or real model quality claimed.', kind: 'fact', status: 'supported', factIds: [], citations: facts[0].citations })) });
}

describe('parallel comparative scoring version', () => {
  it('scores the accepted 60 amounts and 30 changes and reports 9 originals separately without quality approval', async () => {
    const loaded = await loadConfirmedReferences(), dataset = await json('fixtures/company-research/development-v2.json');
    const rubric = financialResearchRubricV2Schema.parse(await json('fixtures/company-research/rubric-v2.json'));
    const scores = loaded.references.cases.map(reference => {
      const sample = dataset.cases.find((sample: EvaluationCase) => sample.id === reference.caseId) as EvaluationCase;
      return scoreFinancialCaseV3(sample, syntheticReport(reference, sample), [], { rubric, reference, referenceBindingSha256: loaded.binding.referenceSha256 });
    });
    const summary = summarizeScoresV3(scores);
    expect(summary.numeric).toMatchObject({ passed: 90, total: 90 });
    expect(summary.originalDisclosures).toMatchObject({ passed: 9, total: 9 });
    expect(summary.questionTotal).toBe(30);
    expect(summary.correctAbstention).toEqual({ passed: null, total: 0, rate: null });
    expect(summary.gatePassed).toBeNull(); expect(summary.officialEligible).toBe(false);
    expect(summary.confirmationScopes.confirmed_bounded_answerability_and_reference).toBe(10);
    expect(summary.answerability).toEqual({ answerable: 10, notDisclosed: 0, unknown: 20, total: 30 });
    expect(summary.completion).toEqual({ passed: null, total: 30, rate: null, unreviewed: 30 });
    expect(summary.diagnosticCompletion).toMatchObject({ passed: 30, total: 30 });
    expect(scores.filter(score => score.questions.find(question => question.questionId === 'risks')!.fullQuestionCoverage === 'partial')).toHaveLength(2);
    expect(summary.blockers).toContain('CONFIRMED_NOT_DISCLOSED_STRATUM_MISSING');
    const comparison = compareFinancialScoresV3(scores, scores, { iterations: 100 });
    expect(comparison).toMatchObject({ total: 90, difference: 0, officialEligible: false, qualityConclusion: 'diagnostic_numerical_items_only' });
    expect(() => compareFinancialScoresV3(scores, scores.slice(1))).toThrow('PAIR_MISMATCH');
    const changedBinding = structuredClone(scores); changedBinding[0].referenceBindingSha256 = '0'.repeat(64);
    expect(() => compareFinancialScoresV3(scores, changedBinding)).toThrow('REFERENCE_COMPARISON_MISMATCH');
  });

  it('retains missing items and refuses same-value originals, unrelated sources and ambiguous fact versions', async () => {
    const loaded = await loadConfirmedReferences(), dataset = await json('fixtures/company-research/development-v2.json');
    const reference = loaded.references.cases[0], sample = dataset.cases.find((sample: EvaluationCase) => sample.id === reference.caseId) as EvaluationCase;
    const rubric = financialResearchRubricV2Schema.parse(await json('fixtures/company-research/rubric-v2.json'));
    const options = { rubric, reference, referenceBindingSha256: loaded.binding.referenceSha256 };
    const missing = scoreFinancialCaseV3(sample, null, ['NO_REPORT'], options);
    expect(missing).toMatchObject({ numericPassed: 0, numericTotal: 9, originalDisclosurePassed: 0, originalDisclosureTotal: 3, questionTotal: 3 });
    const report = syntheticReport(reference, sample);
    const sameValueOriginal = structuredClone(report); sameValueOriginal.facts.find(fact => fact.id === 'parent_net_profit_0')!.restatement = 'original';
    expect(scoreFinancialCaseV3(sample, sameValueOriginal, [], options).facts.find(fact => fact.metric === 'parent_net_profit' && fact.period === '2023-12-31')!.passed).toBe(false);
    const wrongSource = structuredClone(report); wrongSource.facts[0].citations[0].bytesSha256 = '0'.repeat(64);
    expect(scoreFinancialCaseV3(sample, wrongSource, [], options).facts[0].passed).toBe(false);
    const ambiguous = structuredClone(report); ambiguous.facts.push({ ...ambiguous.facts[0], id: 'ambiguous_basis', accountingBasis: 'another_basis' });
    expect(scoreFinancialCaseV3(sample, ambiguous, [], options).facts[0]).toMatchObject({ actual: null, candidateCount: 2, passed: false });
    const unrelatedAmbiguousBasis = structuredClone(report); unrelatedAmbiguousBasis.facts.push({ ...unrelatedAmbiguousBasis.facts[0], id: 'unrelated_ambiguous_basis', accountingBasis: 'another_basis',
      citations: [{ ...unrelatedAmbiguousBasis.facts[0].citations[0], locator: { kind: 'page', filePage: 999 } }] });
    const ambiguousScore = scoreFinancialCaseV3(sample, unrelatedAmbiguousBasis, [], options);
    expect(ambiguousScore.facts[0].passed).toBe(true);
    expect(ambiguousScore.changes[0]).toMatchObject({ actual: null, passed: false, comparison: { status: 'incomparable', reason: 'comparison_basis_ambiguous' } });
    const hardFailure = scoreFinancialCaseV3(sample, report, ['SOURCE_SEMANTICS_FAILED'], options);
    expect(hardFailure.completedQuestions).toBeNull(); expect(hardFailure.diagnosticCompletedQuestions).toBe(0);
    expect(() => scoreFinancialCaseV3(sample, report, [], { ...options, mode: 'official' })).toThrow('V3_OFFICIAL_REVIEW_REQUIRED');
  });
});
