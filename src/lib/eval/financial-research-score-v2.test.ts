import { describe, expect, it } from 'vitest';
import rubricFixture from '../../../fixtures/company-research/rubric-v2.json';
import answerabilityFixture from '../../../fixtures/company-research/answerability-dev-v1.json';
import { reportFixture } from '../company-research/version-test-fixtures';
import type { ResearchReportRevision } from '../company-research/revision-contracts';
import { scoreFinancialCase, summarizeScores, type EvaluationCase } from './financial-research-score';
import { pairedBootstrapInterval } from './statistics';
import {
  FINANCIAL_QUESTION_IDS, answerabilityDatasetSchema, caseAnswerabilitySchema, compareFinancialScoresV2,
  financialReportHash, financialResearchRubricV2Schema, scoreFinancialCaseV2, summarizeScoresV2,
  type CaseAnswerability, type QuestionResponseReview,
} from './financial-research-score-v2';

const hash = 'a'.repeat(64);
const refs = [{ path: 'synthetic-test-only/receipt.json', sha256: hash }];
const confirmation = { receiptPath: refs[0].path, receiptSha256: hash, kind: 'answerability' as const, scope: 'Synthetic test only; no real human approval claimed.' };
const frozenRubric = financialResearchRubricV2Schema.parse({ ...rubricFixture, status: 'frozen', confirmation: { ...confirmation, kind: 'rubric' } });
const sample: EvaluationCase = {
  id: 'synthetic-test', company: { symbol: '600519.SH', name: 'test' }, asOf: '2025-06-30T15:59:59.999Z',
  documentIds: ['annual-2023', 'annual-2024'], questions: [],
  reference: { facts: [{ metric: 'operating_cash_flow', period: { start: '2024-01-01', end: '2024-12-31' }, rawValue: '0.00', unit: 'yuan', normalizedYuan: '0' }], changes: [] },
};
function labels(answerability: 'answerable' | 'not_disclosed' = 'answerable'): CaseAnswerability {
  return { caseId: sample.id, documentIds: [...sample.documentIds], questions: FINANCIAL_QUESTION_IDS.map(questionId => ({
    questionId, answerability: questionId === 'cash_flow' ? answerability : 'answerable', reviewStatus: 'confirmed',
    rationale: 'Synthetic test-only classification', evidenceRefs: refs,
    checkedRanges: sample.documentIds.map(documentId => ({ documentId, bytesSha256: hash, filePageStart: 1, filePageEnd: 2, section: 'Synthetic source range', humanChecked: true })),
    confirmation,
  })) };
}
function response(gap: boolean): ResearchReportRevision {
  const report = reportFixture();
  report.gaps = [];
  if (gap) report.claims[0] = { ...report.claims[0], status: 'evidence_gap', text: 'Supported numbers; the required explanation remains undisclosed in this synthetic example.', reason: 'Required explanation has no evidence.' };
  return report;
}
function reviews(report: ResearchReportRevision, substantiveAssertion: boolean): QuestionResponseReview[] {
  return [{ questionId: 'cash_flow', reportSha256: financialReportHash(report), substantiveAssertion, confirmed: true, evidenceRefs: refs }];
}
function score(answerability: 'answerable' | 'not_disclosed', gap: boolean, assertion = !gap) {
  const report = response(gap);
  return scoreFinancialCaseV2(sample, report, [], labels(answerability), { rubric: frozenRubric, responseReviews: reviews(report, assertion) });
}

describe('parallel financial rubric v2', () => {
  it.each([
    ['answerable', false, true, false, false, false],
    ['answerable', true, false, false, false, true],
    ['not_disclosed', true, false, true, false, false],
    ['not_disclosed', false, true, false, true, false],
  ] as const)('scores %s with explicit gap %s', (answerability, gap, supported, correctAbstention, erroneousAssertion, omission) => {
    expect(score(answerability, gap).questions.find(question => question.questionId === 'cash_flow')).toMatchObject({
      supported, correctAbstention, erroneousAssertion, omission,
    });
  });

  it('retains v1 numbers, question completion and the complete denominator verbatim', () => {
    const report = response(true), hardErrors = ['ACTOR_MISMATCH'];
    const result = scoreFinancialCaseV2(sample, report, hardErrors, labels('not_disclosed'), { rubric: frozenRubric, responseReviews: reviews(report, false) });
    expect(result.v1).toEqual(scoreFinancialCase(sample, report, hardErrors));
    expect(result.questions.find(question => question.questionId === 'cash_flow')?.correctAbstention).toBe(false);
    expect(summarizeScoresV2([result]).v1).toEqual(summarizeScores([result.v1]));
    expect(summarizeScoresV2([result])).toMatchObject({ numeric: { passed: 1, total: 1 }, completion: { passed: 0, total: 3 }, questionTotal: 3 });
  });

  it('gives no abstention credit when required numbers are absent or incorrect', () => {
    for (const raw of [null, '100']) {
      const report = response(true);
      if (raw === null) report.facts = [];
      else if (report.facts[0].value.status === 'known') report.facts[0].value.raw = raw;
      const result = scoreFinancialCaseV2(sample, report, [], labels('not_disclosed'), { rubric: frozenRubric, responseReviews: reviews(report, false) });
      expect(result.questions[1].correctAbstention).toBe(false);
      expect(result.v1.numericTotal).toBe(1);
      expect(result.v1.numericPassed).toBe(0);
    }
  });

  it('does not let an evidence_gap status hide an independently reviewed assertion', () => {
    const result = score('not_disclosed', true, true);
    expect(result.questions[1]).toMatchObject({ explicitGap: true, correctAbstention: false, erroneousAssertion: true });
    expect(summarizeScoresV2([result]).erroneousAssertion).toMatchObject({ passed: 1, total: 1, rate: 1, wilson95: { lower: 20.65, upper: 100 } });
  });

  it('separates unreviewed content from a clearly marked diagnostic proxy', () => {
    const result = scoreFinancialCaseV2(sample, response(true), [], labels('not_disclosed'), { mode: 'diagnostic', rubric: frozenRubric });
    expect(result.questions[1]).toMatchObject({ substantiveAssertion: null, assertionAssessment: 'unreviewed', correctAbstention: false });
    expect(summarizeScoresV2([result])).toMatchObject({ officialEligible: false, gatePassed: null,
      correctAbstention: { passed: 0, total: 1, unreviewed: 1 }, diagnostic: { correctAbstention: { passed: 1, total: 1, unreviewed: 1 } } });
    expect(() => scoreFinancialCaseV2(sample, response(true), [], labels('not_disclosed'), { rubric: frozenRubric })).toThrow('RESPONSE_REVIEW_REQUIRED');
  });

  it('counts silence, null reports, conflicts and incomparable answers without inventing gaps', () => {
    const empty = scoreFinancialCaseV2(sample, null, ['NO_REPORT'], labels('not_disclosed'), { rubric: frozenRubric });
    expect(empty.questions[1]).toMatchObject({ missing: true, explicitGap: false, correctAbstention: false, erroneousAssertion: false });
    expect(empty.v1).toMatchObject({ numericPassed: 0, numericTotal: 1, questionTotal: 3 });
    for (const status of ['conflict', 'incomparable'] as const) {
      const report = response(false);
      report.claims[0].status = status;
      report.claims[0].reason = 'Synthetic unresolved answer';
      const result = scoreFinancialCaseV2(sample, report, [], labels(), { rubric: frozenRubric });
      expect(result.questions[1]).toMatchObject({ supported: false, explicitGap: false, omission: false });
    }
    const report = response(false);
    report.claims = [];
    report.gaps = [{ code: 'evidence_gap', questionId: 'cash_flow', message: 'Explicit standalone gap' }];
    const result = scoreFinancialCaseV2(sample, report, [], labels('not_disclosed'), { rubric: frozenRubric, responseReviews: reviews(report, false) });
    expect(result.questions[1].correctAbstention).toBe(true);
  });

  it('reports zero denominators as undefined and retains Wilson counts', () => {
    const empty = summarizeScoresV2([]);
    for (const metric of [empty.answerableSupport, empty.correctAbstention, empty.erroneousAssertion, empty.omission, empty.numeric, empty.completion]) {
      expect(metric).toMatchObject({ passed: 0, total: 0, rate: null, wilson95: null });
    }
    expect(empty.gatePassed).toBeNull();
    const allAnswerable = summarizeScoresV2([score('answerable', false)]);
    expect(allAnswerable.correctAbstention).toMatchObject({ total: 0, rate: null, wilson95: null });
    expect(allAnswerable.answerableSupport).toMatchObject({ passed: 1, total: 3, rate: 1 / 3 });
    expect(allAnswerable.omission.total).toBe(3);
    const allNotDisclosed = labels('not_disclosed');
    allNotDisclosed.questions.forEach(question => { question.answerability = 'not_disclosed'; });
    const result = scoreFinancialCaseV2(sample, null, ['NO_REPORT'], allNotDisclosed, { rubric: frozenRubric });
    expect(summarizeScoresV2([result])).toMatchObject({ answerableSupport: { total: 0, rate: null, wilson95: null }, omission: { total: 0, rate: null, wilson95: null },
      correctAbstention: { passed: 0, total: 3 }, completion: { passed: 0, total: 3 } });
  });

  it('rejects stale, duplicate and wrong-case semantic review reuse', () => {
    const report = response(true), review = reviews(report, false);
    const changed = structuredClone(report);
    changed.claims[0].text += ' Changed assertion';
    expect(() => scoreFinancialCaseV2(sample, changed, [], labels('not_disclosed'), { rubric: frozenRubric, responseReviews: review })).toThrow('V2_STALE_RESPONSE_REVIEW');
    expect(() => scoreFinancialCaseV2(sample, report, [], labels('not_disclosed'), { rubric: frozenRubric, responseReviews: [...review, ...review] })).toThrow('V2_DUPLICATE_RESPONSE_REVIEW');
    expect(() => scoreFinancialCaseV2({ ...sample, id: 'other-case' }, report, [], labels(), { rubric: frozenRubric })).toThrow('V2_LABEL_CASE_BINDING');
    expect(financialReportHash({ ...report, revision: report.revision + 1 })).not.toBe(financialReportHash(report));
  });

  it('requires real confirmation structure and both source periods for freezing', () => {
    const candidate = labels('not_disclosed');
    candidate.questions[1].confirmation = { ...confirmation, kind: 'complete_reference' };
    expect(caseAnswerabilitySchema.safeParse(candidate).success).toBe(false);
    candidate.questions[1].confirmation = confirmation;
    candidate.questions[1].checkedRanges[1].humanChecked = false;
    expect(caseAnswerabilitySchema.safeParse(candidate).success).toBe(false);
    candidate.questions[1].checkedRanges.pop();
    expect(caseAnswerabilitySchema.safeParse(candidate).success).toBe(false);
    expect(financialResearchRubricV2Schema.safeParse({ ...rubricFixture, status: 'frozen', confirmation: null }).success).toBe(false);
    expect(answerabilityDatasetSchema.safeParse({ ...answerabilityFixture, status: 'frozen' }).success).toBe(false);
    expect(answerabilityDatasetSchema.parse(answerabilityFixture).cases).toHaveLength(4);
    const parsed = answerabilityDatasetSchema.parse(answerabilityFixture);
    expect(parsed.cases.flatMap(item => item.questions).filter(question => question.reviewStatus === 'confirmed')).toHaveLength(9);
    expect(parsed.cases.flatMap(item => item.questions).filter(question => question.answerability === 'not_disclosed').every(question => question.reviewStatus === 'pending_review')).toBe(true);
  });

  it('rejects pending labels or rubric in official mode and preserves explicit diagnostic mode', () => {
    const pending = labels();
    pending.questions[1].reviewStatus = 'pending_review';
    pending.questions[1].confirmation = null;
    expect(() => scoreFinancialCaseV2(sample, response(false), [], pending, { rubric: frozenRubric })).toThrow('LABEL_PENDING_REVIEW');
    const rubric = financialResearchRubricV2Schema.parse({ ...rubricFixture, status: 'pending_review', confirmation: null });
    expect(() => scoreFinancialCaseV2(sample, response(false), [], labels(), { rubric })).toThrow('RUBRIC_PENDING_REVIEW');
    expect(scoreFinancialCaseV2(sample, response(false), [], pending, { rubric, mode: 'diagnostic' }).officialEligible).toBe(false);
  });

  it('pairs the full question set and refuses different labels or duplicate attempts', () => {
    const left = score('not_disclosed', false), right = score('not_disclosed', true);
    const compared = compareFinancialScoresV2([left], [right], { iterations: 500, seed: 1 });
    expect(compared).toMatchObject({ total: 3, baselinePassed: 0, candidatePassed: 1, difference: 1 / 3 });
    expect(compared.interval!.lower).toBeGreaterThanOrEqual(0);
    expect(() => compareFinancialScoresV2([left], [])).toThrow('V2_QUESTION_PAIR_MISMATCH');
    expect(() => compareFinancialScoresV2([left], [score('answerable', true)])).toThrow('V2_LABEL_COMPARISON_MISMATCH');
    expect(() => compareFinancialScoresV2([left, left], [right, right])).toThrow('V2_DUPLICATE_QUESTION_PAIR');
    const changedReport = response(true);
    const differentReference = scoreFinancialCaseV2({ ...sample, reference: { ...sample.reference, changes: [{ metric: 'operating_cash_flow', percentage: '1' }] } }, changedReport, [], labels('not_disclosed'), {
      rubric: frozenRubric, responseReviews: reviews(changedReport, false), mode: 'diagnostic',
    });
    expect(() => compareFinancialScoresV2([left], [differentReference], { mode: 'diagnostic' })).toThrow('V2_LABEL_COMPARISON_MISMATCH');
    const diagnostic = scoreFinancialCaseV2(sample, response(true), [], labels('not_disclosed'), { rubric: frozenRubric, mode: 'diagnostic' });
    expect(() => compareFinancialScoresV2([diagnostic], [diagnostic])).toThrow('V2_OFFICIAL_COMPARISON_REQUIRES_REVIEW');
    expect(compareFinancialScoresV2([diagnostic], [diagnostic], { mode: 'diagnostic', iterations: 100 }).qualityConclusion).toBe('diagnostic_only');
  });
});

describe('question-level paired bootstrap', () => {
  it('keeps the arms paired and uses difference units with a reproducible seed', () => {
    const observations = [{ key: 'a', baseline: true, candidate: false }, { key: 'b', baseline: false, candidate: true }];
    const first = pairedBootstrapInterval(observations, { seed: 0, iterations: 500 });
    expect(first).toEqual(pairedBootstrapInterval(observations, { seed: 0, iterations: 500 }));
    expect(first).toMatchObject({ total: 2, baselinePassed: 1, candidatePassed: 1, difference: 0, interval: { lower: -1, upper: 1 }, units: 'proportion_difference' });
    expect(pairedBootstrapInterval([{ key: 'a', baseline: false, candidate: true }])).toMatchObject({ difference: 1, interval: { lower: 1, upper: 1 } });
    expect(observations[0].baseline).toBe(true);
  });
  it('does not drop missing pairs, invalid observations or invalid resampling options', () => {
    expect(pairedBootstrapInterval([])).toMatchObject({ total: 0, difference: null, interval: null });
    const pair = { key: 'one', baseline: false, candidate: true };
    expect(() => pairedBootstrapInterval([pair, pair])).toThrow('QUESTION_KEY');
    expect(() => pairedBootstrapInterval([{ ...pair, baseline: null as unknown as boolean }])).toThrow('BINARY_REQUIRED');
    expect(() => pairedBootstrapInterval([pair], { iterations: 0 })).toThrow('ITERATIONS');
    expect(() => pairedBootstrapInterval([pair], { seed: -1 })).toThrow('SEED');
    expect(() => pairedBootstrapInterval([pair], { confidence: 1 })).toThrow('CONFIDENCE');
  });
});
