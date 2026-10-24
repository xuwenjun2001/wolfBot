import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResearchReportRevision } from '../company-research/revision-contracts';
import { canonicalResearchJson } from '../company-research/task-contracts';
import { scoreFinancialCase, summarizeScores, type EvaluationCase } from './financial-research-score';
import { pairedBootstrapInterval, wilsonScoreInterval } from './statistics';

export const FINANCIAL_QUESTION_IDS = ['income_profit', 'cash_flow', 'risks'] as const;
const questionIdSchema = z.enum(FINANCIAL_QUESTION_IDS);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const textSchema = z.string().trim().min(1);
const evidenceReferenceSchema = z.object({ path: textSchema, sha256: sha256Schema }).strict();
const confirmationSchema = z.object({
  receiptPath: textSchema, receiptSha256: sha256Schema,
  kind: z.enum(['complete_reference', 'answerability', 'rubric']), scope: textSchema,
}).strict();
export const questionAnswerabilitySchema = z.object({
  questionId: questionIdSchema,
  answerability: z.enum(['answerable', 'not_disclosed']),
  reviewStatus: z.enum(['pending_review', 'confirmed']),
  rationale: textSchema,
  evidenceRefs: z.array(evidenceReferenceSchema).min(1),
  checkedRanges: z.array(z.object({
    documentId: textSchema, bytesSha256: sha256Schema,
    filePageStart: z.number().int().positive(), filePageEnd: z.number().int().positive(),
    section: textSchema, humanChecked: z.boolean(),
  }).strict().refine(range => range.filePageStart <= range.filePageEnd, 'Page range must be ordered')),
  confirmation: confirmationSchema.nullable(),
}).strict().superRefine((label, ctx) => {
  if (label.reviewStatus === 'confirmed' && (!label.confirmation || !label.checkedRanges.length || label.checkedRanges.some(range => !range.humanChecked))) {
    ctx.addIssue({ code: 'custom', message: 'Confirmed labels require a human receipt and checked source ranges' });
  }
  if (label.reviewStatus === 'confirmed' && label.confirmation?.kind === 'rubric') ctx.addIssue({ code: 'custom', message: 'A rubric receipt cannot confirm a question' });
  if (label.answerability === 'not_disclosed' && label.reviewStatus === 'confirmed' && label.confirmation?.kind !== 'answerability') {
    ctx.addIssue({ code: 'custom', message: 'Partial-reference confirmation does not establish non-disclosure' });
  }
  if (label.reviewStatus === 'pending_review' && label.confirmation !== null) ctx.addIssue({ code: 'custom', message: 'Pending labels cannot carry an approval receipt' });
});
export const caseAnswerabilitySchema = z.object({
  caseId: textSchema, documentIds: z.array(textSchema).length(2),
  questions: z.array(questionAnswerabilitySchema).length(3),
}).strict().superRefine((sample, ctx) => {
  if (new Set(sample.documentIds).size !== 2 || new Set(sample.questions.map(question => question.questionId)).size !== 3) {
    ctx.addIssue({ code: 'custom', message: 'Two unique documents and all three unique financial questions are required' });
  }
  for (const question of sample.questions) {
    if (question.checkedRanges.some(range => !sample.documentIds.includes(range.documentId))) ctx.addIssue({ code: 'custom', message: 'Checked range is outside the registered source documents' });
    if (question.reviewStatus === 'confirmed' && sample.documentIds.some(id => !question.checkedRanges.some(range => range.documentId === id && range.humanChecked))) {
      ctx.addIssue({ code: 'custom', message: 'Confirmed labels must cover both registered report periods' });
    }
  }
});
export const answerabilityDatasetSchema = z.object({
  schemaVersion: z.literal(1), datasetVersion: textSchema, sourceDatasetVersion: textSchema,
  sourceDatasetSha256: sha256Schema, rubricVersion: z.literal('research-rubric-v2'),
  status: z.enum(['pending_review', 'frozen']), note: textSchema,
  cases: z.array(caseAnswerabilitySchema).min(1),
}).strict().superRefine((dataset, ctx) => {
  if (new Set(dataset.cases.map(sample => sample.caseId)).size !== dataset.cases.length) ctx.addIssue({ code: 'custom', message: 'Duplicate answerability case' });
  if (dataset.status === 'frozen' && dataset.cases.some(sample => sample.questions.some(question => question.reviewStatus !== 'confirmed'))) {
    ctx.addIssue({ code: 'custom', message: 'Unreviewed answerability labels cannot be frozen' });
  }
});
export const financialResearchRubricV2Schema = z.object({
  schemaVersion: z.literal(2), version: z.literal('research-rubric-v2'),
  status: z.enum(['pending_review', 'frozen']), confirmation: confirmationSchema.nullable(),
  v1Version: z.literal('research-rubric-v1'), v1DefinitionsUnchanged: z.literal(true),
  thresholds: z.object({ numericAccuracy: z.literal(.95), taskCompletionRate: z.literal(.8),
    answerableSupport: z.literal(.9), correctAbstention: z.literal(1), erroneousAssertion: z.literal(0) }).strict(),
  definitions: z.record(z.string(), textSchema),
  limitations: z.array(textSchema).min(1),
}).strict().superRefine((rubric, ctx) => {
  if (rubric.status === 'frozen' && rubric.confirmation?.kind !== 'rubric') ctx.addIssue({ code: 'custom', message: 'Frozen rubric requires an explicit rubric approval receipt' });
  if (rubric.status === 'pending_review' && rubric.confirmation !== null) ctx.addIssue({ code: 'custom', message: 'Pending rubric cannot carry an approval receipt' });
});
export type CaseAnswerability = z.infer<typeof caseAnswerabilitySchema>;
export type AnswerabilityDataset = z.infer<typeof answerabilityDatasetSchema>;
export type FinancialResearchRubricV2 = z.infer<typeof financialResearchRubricV2Schema>;

/** Hash the complete report, including claim IDs, text, statuses, gaps and revision. */
export function financialReportHash(report: ResearchReportRevision | null): string {
  return createHash('sha256').update(canonicalResearchJson(report)).digest('hex');
}
export const questionResponseReviewSchema = z.object({
  questionId: questionIdSchema, reportSha256: sha256Schema,
  substantiveAssertion: z.boolean(), confirmed: z.literal(true),
  evidenceRefs: z.array(evidenceReferenceSchema).min(1),
}).strict();
export type QuestionResponseReview = z.infer<typeof questionResponseReviewSchema>;
export interface ScoreFinancialCaseV2Options {
  rubric: FinancialResearchRubricV2;
  mode?: 'official' | 'diagnostic';
  /** Trusted evaluator input, never model-supplied report fields. Required for non-disclosure acceptance. */
  responseReviews?: QuestionResponseReview[];
}

export function scoreFinancialCaseV2(
  sample: EvaluationCase, report: ResearchReportRevision | null, hardErrors: string[],
  answerability: CaseAnswerability, options: ScoreFinancialCaseV2Options,
) {
  const labels = caseAnswerabilitySchema.parse(answerability);
  const rubric = financialResearchRubricV2Schema.parse(options.rubric);
  const mode = options.mode ?? 'official';
  if (!['official', 'diagnostic'].includes(mode)) throw new Error('V2_MODE_INVALID');
  if (labels.caseId !== sample.id || sample.documentIds.length !== labels.documentIds.length || labels.documentIds.some(id => !sample.documentIds.includes(id))) throw new Error('V2_LABEL_CASE_BINDING');
  const reviews = z.array(questionResponseReviewSchema).parse(options.responseReviews ?? []);
  const reportSha256 = financialReportHash(report);
  if (new Set(reviews.map(review => review.questionId)).size !== reviews.length) throw new Error('V2_DUPLICATE_RESPONSE_REVIEW');
  if (reviews.some(review => review.reportSha256 !== reportSha256)) throw new Error('V2_STALE_RESPONSE_REVIEW');
  const v1 = scoreFinancialCase(sample, report, hardErrors);
  const questions = FINANCIAL_QUESTION_IDS.map(questionId => {
    const label = labels.questions.find(question => question.questionId === questionId)!;
    const claims = report?.claims.filter(claim => claim.questionId === questionId) ?? [];
    const gaps = report?.gaps.filter(gap => gap.questionId === questionId) ?? [];
    const explicitGap = claims.some(claim => claim.status === 'evidence_gap' && Boolean(claim.reason?.trim())) || gaps.some(gap => gap.code === 'evidence_gap' && Boolean(gap.message.trim()));
    const missing = claims.length === 0 && gaps.length === 0;
    const review = reviews.find(value => value.questionId === questionId);
    // Status is a diagnostic proxy only: gap text can still contain assertions.
    const structuralAssertionProxy = claims.some(claim => claim.status !== 'evidence_gap') || gaps.some(gap => gap.code !== 'evidence_gap');
    const substantiveAssertion = review ? review.substantiveAssertion : missing ? false : null;
    const supported = v1.questions.find(question => question.questionId === questionId)!.completed;
    const metrics = questionId === 'income_profit' ? ['revenue', 'parent_net_profit'] : questionId === 'cash_flow' ? ['operating_cash_flow'] : [];
    const numbersPassed = v1.facts.filter(fact => metrics.includes(fact.metric)).every(fact => fact.passed) && v1.changes.filter(change => metrics.includes(change.metric)).every(change => change.passed);
    const abstentionPrerequisites = explicitGap && numbersPassed && hardErrors.length === 0;
    const notDisclosed = label.answerability === 'not_disclosed';
    const correctAbstention = notDisclosed && abstentionPrerequisites && substantiveAssertion === false;
    const diagnosticAssertion = substantiveAssertion ?? structuralAssertionProxy;
    const diagnosticCorrectAbstention = notDisclosed && abstentionPrerequisites && !diagnosticAssertion;
    return { questionId, answerability: label.answerability, reviewStatus: label.reviewStatus,
      supported, explicitGap, missing, numbersPassed, substantiveAssertion,
      assertionAssessment: review ? 'reviewed' as const : missing ? 'no_response' as const : 'unreviewed' as const,
      correctAbstention, erroneousAssertion: notDisclosed && substantiveAssertion === true,
      omission: !notDisclosed && explicitGap,
      resolvedCorrectly: notDisclosed ? substantiveAssertion === null ? null : correctAbstention : supported,
      diagnostic: { structuralAssertionProxy, correctAbstention: diagnosticCorrectAbstention,
        erroneousAssertion: notDisclosed && diagnosticAssertion, resolvedCorrectly: notDisclosed ? diagnosticCorrectAbstention : supported } };
  });
  const blockers = [
    ...(rubric.status !== 'frozen' ? ['RUBRIC_PENDING_REVIEW'] : []),
    ...questions.filter(question => question.reviewStatus !== 'confirmed').map(question => `LABEL_PENDING_REVIEW:${question.questionId}`),
    ...questions.filter(question => question.answerability === 'not_disclosed' && question.assertionAssessment === 'unreviewed').map(question => `RESPONSE_REVIEW_REQUIRED:${question.questionId}`),
  ];
  if (mode === 'official' && blockers.length) throw new Error(`V2_OFFICIAL_REVIEW_REQUIRED:${blockers.join(',')}`);
  const sampleSha256 = createHash('sha256').update(canonicalResearchJson(sample)).digest('hex');
  return { version: rubric.version, caseId: sample.id, mode, reportSha256, reportStatus: report?.status ?? null, sampleSha256, labels, rubric,
    officialEligible: mode === 'official' && blockers.length === 0, blockers, v1, questions };
}
export type EvaluationScoreV2 = ReturnType<typeof scoreFinancialCaseV2>;

function proportion(passed: number, total: number, unreviewed = 0) {
  return { passed, total, rate: total ? passed / total : null,
    wilson95: total ? wilsonScoreInterval(passed, total) : null, unreviewed };
}
export function summarizeScoresV2(scores: EvaluationScoreV2[]) {
  if (scores.some(score => canonicalResearchJson(score.rubric) !== canonicalResearchJson(scores[0].rubric))) throw new Error('V2_RUBRIC_COMPARISON_MISMATCH');
  const v1 = summarizeScores(scores.map(score => score.v1));
  const questions = scores.flatMap(score => score.questions);
  const answerable = questions.filter(question => question.answerability === 'answerable');
  const notDisclosed = questions.filter(question => question.answerability === 'not_disclosed');
  const unreviewed = notDisclosed.filter(question => question.assertionAssessment === 'unreviewed').length;
  const answerableSupport = proportion(answerable.filter(question => question.supported).length, answerable.length);
  const correctAbstention = proportion(notDisclosed.filter(question => question.correctAbstention).length, notDisclosed.length, unreviewed);
  const erroneousAssertion = proportion(notDisclosed.filter(question => question.erroneousAssertion).length, notDisclosed.length, unreviewed);
  const omission = proportion(answerable.filter(question => question.omission).length, answerable.length);
  const officialEligible = scores.length > 0 && scores.every(score => score.officialEligible);
  const thresholds = scores[0]?.rubric.thresholds;
  const gatePassed = officialEligible && thresholds ? v1.hardPassed && v1.numeric.rate !== null && v1.numeric.rate >= thresholds.numericAccuracy &&
    v1.completion.rate !== null && v1.completion.rate >= thresholds.taskCompletionRate &&
    (answerable.length === 0 || (answerableSupport.rate !== null && answerableSupport.rate >= thresholds.answerableSupport)) &&
    (notDisclosed.length === 0 || correctAbstention.rate === thresholds.correctAbstention) && erroneousAssertion.passed === 0 && unreviewed === 0 : null;
  return { version: 'research-rubric-v2' as const, companies: scores.length, questionTotal: questions.length,
    labelReview: { confirmed: questions.filter(question => question.reviewStatus === 'confirmed').length,
      pendingReview: questions.filter(question => question.reviewStatus !== 'confirmed').length },
    officialEligible, qualityConclusion: officialEligible ? 'eligible_for_registered_v2_metrics' : 'diagnostic_only', gatePassed,
    answerableSupport, correctAbstention, erroneousAssertion, omission,
    numeric: v1.numeric, completion: v1.completion,
    completedCompanies: proportion(scores.filter(score => score.reportStatus === 'completed' && score.v1.completedQuestions === score.v1.questionTotal && score.v1.hardErrors.length === 0).length, scores.length),
    v1,
    diagnostic: { note: 'Conditional on draft labels and, where unreviewed, a structured-status proxy. Not an accepted semantic judgment or v2 quality conclusion.',
      correctAbstention: proportion(notDisclosed.filter(question => question.diagnostic.correctAbstention).length, notDisclosed.length, unreviewed),
      erroneousAssertion: proportion(notDisclosed.filter(question => question.diagnostic.erroneousAssertion).length, notDisclosed.length, unreviewed),
      resolvedQuestions: proportion(questions.filter(question => question.diagnostic.resolvedCorrectly).length, questions.length, unreviewed) },
    uncertainty: 'Wilson intervals are descriptive percentages. Questions within companies and repeated attempts are correlated; draft labels and unreviewed assertions add uncertainty not represented by the interval.' };
}

/** Exact matching prevents dropping failures, missing questions or label changes. */
export function compareFinancialScoresV2(
  baseline: EvaluationScoreV2[], candidate: EvaluationScoreV2[],
  options: { mode?: 'official' | 'diagnostic'; iterations?: number; seed?: number; confidence?: number } = {},
) {
  const mode = options.mode ?? 'official';
  if (!['official', 'diagnostic'].includes(mode)) throw new Error('V2_MODE_INVALID');
  summarizeScoresV2(baseline);
  summarizeScoresV2(candidate);
  const flatten = (scores: EvaluationScoreV2[]) => {
    const pairs = new Map<string, { outcome: boolean; contract: string }>();
    for (const score of scores) {
      if (mode === 'official' && !score.officialEligible) throw new Error('V2_OFFICIAL_COMPARISON_REQUIRES_REVIEW');
      for (const question of score.questions) {
        const key = `${score.caseId}/${question.questionId}`;
        if (pairs.has(key)) throw new Error('V2_DUPLICATE_QUESTION_PAIR');
        const outcome = mode === 'diagnostic' ? question.diagnostic.resolvedCorrectly : question.resolvedCorrectly;
        if (outcome === null) throw new Error('V2_UNREVIEWED_QUESTION_PAIR');
        pairs.set(key, { outcome, contract: canonicalResearchJson({ sampleSha256: score.sampleSha256, labels: score.labels, rubric: score.rubric }) });
      }
    }
    return pairs;
  };
  const left = flatten(baseline), right = flatten(candidate);
  if (left.size !== right.size || [...left.keys()].some(key => !right.has(key))) throw new Error('V2_QUESTION_PAIR_MISMATCH');
  const observations = [...left.keys()].sort().map(key => {
    if (left.get(key)!.contract !== right.get(key)!.contract) throw new Error('V2_LABEL_COMPARISON_MISMATCH');
    return { key, baseline: left.get(key)!.outcome, candidate: right.get(key)!.outcome };
  });
  return { mode, qualityConclusion: mode === 'diagnostic' ? 'diagnostic_only' : 'paired_registered_metrics',
    ...pairedBootstrapInterval(observations, options),
    uncertainty: 'Question pairs are resampled together. Within-company/repeat dependence remains; small samples do not support general improvement or significance claims.' };
}
