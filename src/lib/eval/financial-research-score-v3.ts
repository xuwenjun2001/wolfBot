import { createHash } from 'node:crypto';
import { cnyUnitPowers, decimal, decimalText, multiplyPowerOfTen } from '../company-research/exact-decimal';
import { normalizedYuan } from '../company-research/financial-normalization';
import { selectFinancialComparisonPair } from '../company-research/financial-comparison';
import type { ResearchReportRevision } from '../company-research/revision-contracts';
import { canonicalResearchJson } from '../company-research/task-contracts';
import { withinTolerance, type EvaluationCase } from './financial-research-score';
import { FINANCIAL_QUESTION_IDS, financialReportHash, type CaseAnswerability, type FinancialResearchRubricV2 } from './financial-research-score-v2';
import type { ConfirmedReferenceCase } from './confirmed-reference-contracts';
import { pairedBootstrapInterval, wilsonScoreInterval } from './statistics';

export const FINANCIAL_SCORING_V3 = 'financial-research-score-v3-bounded-20261026' as const;
type Source = { documentId: string; bytesSha256: string; filePage: number };
type AmountReference = { metric: string; period: { start: string; end: string }; rawValue: string; unit: keyof typeof cnyUnitPowers;
  normalizedYuan: string; restatement: 'original' | 'restated'; source?: Source };
interface V3Options {
  rubric: FinancialResearchRubricV2; mode?: 'official' | 'diagnostic'; reference?: ConfirmedReferenceCase;
  legacyLabels?: CaseAnswerability; referenceBindingSha256: string;
}
const amountTolerance = (reference: AmountReference) => decimalText(multiplyPowerOfTen(decimal(`0.${'0'.repeat(reference.rawValue.split('.')[1]?.length ?? 0)}5`), cnyUnitPowers[reference.unit]));
function selectFact(report: ResearchReportRevision | null, reference: AmountReference) {
  const candidates = report?.facts.filter(fact => fact.metric === reference.metric && fact.scope === 'consolidated' && fact.restatement === reference.restatement && fact.period.start === reference.period.start && fact.period.end === reference.period.end
    && (!reference.source || fact.citations.some(citation => citation.documentId === reference.source!.documentId && citation.bytesSha256 === reference.source!.bytesSha256 && citation.locator.kind !== 'html' && citation.locator.filePage === reference.source!.filePage))) ?? [];
  return { fact: candidates.length === 1 ? candidates[0] : null, candidateCount: candidates.length };
}
/** A parallel diagnostic version; historical v1/v2 definitions and thresholds remain unchanged. */
export function scoreFinancialCaseV3(sample: EvaluationCase, report: ResearchReportRevision | null, hardErrors: string[], options: V3Options) {
  const reference = options.reference;
  if (reference && (reference.caseId !== sample.id || reference.company.symbol !== sample.company.symbol || canonicalResearchJson([...reference.taskDocumentIds].sort()) !== canonicalResearchJson([...sample.documentIds].sort()))) throw new Error('V3_REFERENCE_CASE_BINDING');
  if (!reference && !options.legacyLabels) throw new Error('V3_REFERENCE_OR_LEGACY_LABELS_REQUIRED');
  if (options.legacyLabels && (options.legacyLabels.caseId !== sample.id || options.legacyLabels.documentIds.some(id => !sample.documentIds.includes(id)))) throw new Error('V3_LEGACY_LABEL_CASE_BINDING');
  const mode = options.mode ?? 'diagnostic';
  if (!['official', 'diagnostic'].includes(mode)) throw new Error('V3_MODE_INVALID');
  const amounts: AmountReference[] = reference ? reference.numericalReference.figures.flatMap(figure => [
    { ...figure.previous, metric: figure.metric, unit: figure.unit, period: reference.periods[0], restatement: reference.numericalReference.comparisonBasis === 'restated_comparative' ? 'restated' as const : 'original' as const },
    { ...figure.current, metric: figure.metric, unit: figure.unit, period: reference.periods[1], restatement: 'original' as const },
  ]) : sample.reference.facts.map(fact => ({ ...fact, restatement: 'original' as const }));
  const facts = amounts.map(expected => {
    const selected = selectFact(report, expected), actual = selected.fact?.value.status === 'known' ? normalizedYuan(selected.fact) : null;
    return { metric: expected.metric, period: expected.period.end, expected: expected.normalizedYuan, actual, source: expected.source ?? null,
      restatement: expected.restatement, factId: selected.fact?.id ?? null, candidateCount: selected.candidateCount,
      passed: withinTolerance(actual, expected.normalizedYuan, amountTolerance(expected)) };
  });
  const changes = (reference ? reference.numericalReference.figures : sample.reference.changes).map(expected => {
    const pair = amounts.filter(amount => amount.metric === expected.metric).sort((a, b) => a.period.end.localeCompare(b.period.end)).map(amount => selectFact(report, amount).fact);
    const selected = report ? selectFinancialComparisonPair(report.facts, report.periodIds, expected.metric as ResearchReportRevision['facts'][number]['metric']) : null;
    const expectedPairSelected = !!(pair.length === 2 && pair.every(Boolean) && selected?.before?.id === pair[0]!.id && selected?.after?.id === pair[1]!.id);
    const comparison = expectedPairSelected || selected?.comparison?.status === 'incomparable' ? selected!.comparison : null;
    const actual = comparison?.status === 'comparable' ? comparison.percentage : null;
    return { metric: expected.metric, expected: expected.percentage, actual,
      comparisonBasis: reference?.numericalReference.comparisonBasis ?? 'original_disclosure',
      comparison, expectedPairSelected, passed: withinTolerance(actual, expected.percentage, '0.01') };
  });
  const originalDisclosures = reference?.numericalReference.originalPriorDisclosures.map(original => {
    const expected: AmountReference = { ...original, period: reference.periods[0], restatement: 'original' };
    const selected = selectFact(report, expected), actual = selected.fact?.value.status === 'known' ? normalizedYuan(selected.fact) : null;
    return { metric: expected.metric, period: expected.period.end, expected: expected.normalizedYuan, actual, source: original.source,
      candidateCount: selected.candidateCount, factId: selected.fact?.id ?? null, passed: withinTolerance(actual, expected.normalizedYuan, amountTolerance(expected)) };
  }) ?? [];
  const questions = FINANCIAL_QUESTION_IDS.map(questionId => {
    const label = options.legacyLabels?.questions.find(question => question.questionId === questionId);
    const claims = report?.claims.filter(claim => claim.questionId === questionId) ?? [], gaps = report?.gaps.filter(gap => gap.questionId === questionId) ?? [];
    const metrics = questionId === 'income_profit' ? ['revenue', 'parent_net_profit'] : questionId === 'cash_flow' ? ['operating_cash_flow'] : [];
    const numbersPassed = facts.filter(fact => metrics.includes(fact.metric)).every(fact => fact.passed) && changes.filter(change => metrics.includes(change.metric)).every(change => change.passed);
    const explicitGap = claims.some(claim => claim.status === 'evidence_gap' && Boolean(claim.reason?.trim())) || gaps.some(gap => gap.code === 'evidence_gap' && Boolean(gap.message.trim()));
    const diagnosticSupported = hardErrors.length === 0 && claims.length > 0 && claims.every(claim => claim.status === 'supported') && numbersPassed;
    const answerability = reference ? questionId === 'cash_flow' ? 'answerable' as const : 'unknown' as const : label?.answerability ?? 'unknown' as const;
    const confirmationScope = reference ? questionId === 'income_profit' ? 'confirmed_numeric_reference_only' : questionId === 'cash_flow' ? 'confirmed_bounded_answerability_and_reference' : 'confirmed_bounded_risk_reference_only' : label?.reviewStatus === 'confirmed' ? 'legacy_confirmed_label' : 'pending_review';
    const fullQuestionCoverage = reference ? questionId === 'risks' ? reference.risks.fullQuestionCoverage : 'not_assessed_by_this_overlay' : label?.reviewStatus === 'confirmed' ? 'confirmed' : 'pending_review';
    return { questionId, answerability, confirmationScope, fullQuestionCoverage, supported: null, numbersPassed, explicitGap,
      missing: claims.length === 0 && gaps.length === 0, omission: answerability === 'answerable' && explicitGap,
      // A model's supported/gap flag cannot replace review of its complete response.
      correctAbstention: null, erroneousAssertion: null, responseReview: 'not_reviewed' as const,
      diagnostic: { supported: diagnosticSupported, assessment: 'claim_status_and_numbers_proxy_only' as const } };
  });
  const blockers = ['V3_FULL_DATASET_NOT_FROZEN', 'CONFIRMED_NOT_DISCLOSED_STRATUM_MISSING',
    ...(reference ? ['BOUNDED_OVERLAY_NOT_FULL_QUESTION_LABELS'] : []),
    ...questions.filter(question => question.fullQuestionCoverage === 'partial').map(question => `FULL_QUESTION_COVERAGE_PARTIAL:${question.questionId}`),
    ...(report ? ['COMPLETE_REPORT_RESPONSE_REVIEW_REQUIRED'] : []),
    ...(options.rubric.status !== 'frozen' ? ['RUBRIC_PENDING_REVIEW'] : [])];
  if (mode === 'official') throw new Error(`V3_OFFICIAL_REVIEW_REQUIRED:${blockers.join(',')}`);
  return { version: FINANCIAL_SCORING_V3, rubricVersion: options.rubric.version, thresholds: options.rubric.thresholds, caseId: sample.id, mode,
    reportSha256: financialReportHash(report), sampleSha256: createHash('sha256').update(canonicalResearchJson(sample)).digest('hex'),
    referenceVersion: reference ? 'research-dev-u-confirmed-references-20261026-v1' : 'legacy-confirmed-labels-and-original-disclosures', referenceBindingSha256: options.referenceBindingSha256,
    comparativeBasis: reference?.numericalReference.comparisonBasis ?? 'original_disclosure', limitations: reference?.numericalReference.limitations ?? null,
    facts, changes, originalDisclosures, numericPassed: [...facts, ...changes].filter(item => item.passed).length, numericTotal: facts.length + changes.length,
    originalDisclosurePassed: originalDisclosures.filter(item => item.passed).length, originalDisclosureTotal: originalDisclosures.length,
    questions, questionTotal: questions.length, completedQuestions: null, diagnosticCompletedQuestions: questions.filter(question => question.diagnostic.supported).length, hardErrors,
    officialEligible: false as const, gatePassed: null, blockers, wholeCompanyGolden: false as const };
}
export type EvaluationScoreV3 = ReturnType<typeof scoreFinancialCaseV3>;
const proportion = (passed: number, total: number) => ({ passed, total, rate: total ? passed / total : null, wilson95: total ? wilsonScoreInterval(passed, total) : null });
export function summarizeScoresV3(scores: EvaluationScoreV3[]) {
  if (scores.some(score => score.referenceBindingSha256 !== scores[0].referenceBindingSha256 || canonicalResearchJson(score.thresholds) !== canonicalResearchJson(scores[0].thresholds))) throw new Error('V3_REFERENCE_COMPARISON_MISMATCH');
  const questions = scores.flatMap(score => score.questions), answerable = questions.filter(question => question.answerability === 'answerable');
  return { version: FINANCIAL_SCORING_V3, companies: scores.length, questionTotal: questions.length,
    numeric: proportion(scores.reduce((total, score) => total + score.numericPassed, 0), scores.reduce((total, score) => total + score.numericTotal, 0)),
    originalDisclosures: proportion(scores.reduce((total, score) => total + score.originalDisclosurePassed, 0), scores.reduce((total, score) => total + score.originalDisclosureTotal, 0)),
    completion: { passed: null, total: questions.length, rate: null, unreviewed: questions.length },
    answerableSupport: { passed: null, total: answerable.length, rate: null, unreviewed: answerable.length },
    diagnosticCompletion: proportion(questions.filter(question => question.diagnostic.supported).length, questions.length),
    diagnosticAnswerableSupport: proportion(answerable.filter(question => question.diagnostic.supported).length, answerable.length),
    answerability: { answerable: answerable.length, notDisclosed: questions.filter(question => question.answerability === 'not_disclosed').length,
      unknown: questions.filter(question => question.answerability === 'unknown').length, total: questions.length },
    correctAbstention: { passed: null, total: questions.filter(question => question.answerability === 'not_disclosed').length, rate: null },
    erroneousAssertion: { passed: null, total: questions.filter(question => question.answerability === 'not_disclosed').length, rate: null },
    confirmationScopes: Object.fromEntries([...new Set(questions.map(question => question.confirmationScope))].map(scope => [scope, questions.filter(question => question.confirmationScope === scope).length])),
    fullQuestionCoveragePartial: questions.filter(question => question.fullQuestionCoverage === 'partial').map(question => question.questionId),
    qualityConclusion: 'diagnostic_only' as const, officialEligible: false as const, gatePassed: null,
    blockers: [...new Set(scores.flatMap(score => score.blockers))], wholeCompanyGoldenPromotions: 0 };
}

/** Pair deterministic numerical items only; bounded risk references never become quality outcomes. */
export function compareFinancialScoresV3(baseline: EvaluationScoreV3[], candidate: EvaluationScoreV3[], options: { iterations?: number; seed?: number; confidence?: number } = {}) {
  summarizeScoresV3(baseline); summarizeScoresV3(candidate);
  const flatten = (scores: EvaluationScoreV3[]) => {
    const items = new Map<string, { passed: boolean; binding: string }>();
    for (const score of scores) {
      const binding = canonicalResearchJson({ sampleSha256: score.sampleSha256, referenceBindingSha256: score.referenceBindingSha256, version: score.version, thresholds: score.thresholds });
      for (const item of [...score.facts.map(fact => ({ key: `amount/${fact.metric}/${fact.period}`, passed: fact.passed })), ...score.changes.map(change => ({ key: `percentage/${change.metric}`, passed: change.passed }))]) {
        const key = `${score.caseId}/${item.key}`;
        if (items.has(key)) throw new Error('V3_DUPLICATE_NUMERICAL_PAIR');
        items.set(key, { passed: item.passed, binding });
      }
    }
    return items;
  };
  const left = flatten(baseline), right = flatten(candidate);
  if (left.size !== right.size || [...left.keys()].some(key => !right.has(key))) throw new Error('V3_NUMERICAL_PAIR_MISMATCH');
  const pairs = [...left.keys()].sort().map(key => {
    if (left.get(key)!.binding !== right.get(key)!.binding) throw new Error('V3_REFERENCE_COMPARISON_MISMATCH');
    return { key, baseline: left.get(key)!.passed, candidate: right.get(key)!.passed };
  });
  return { version: FINANCIAL_SCORING_V3, qualityConclusion: 'diagnostic_numerical_items_only', officialEligible: false,
    ...pairedBootstrapInterval(pairs, options),
    method: 'numerical_item_paired_percentile_bootstrap' as const,
    uncertainty: 'Items within a company and repeated attempts are correlated. This paired diagnostic does not establish full-question quality, general improvement or statistical significance.' };
}
