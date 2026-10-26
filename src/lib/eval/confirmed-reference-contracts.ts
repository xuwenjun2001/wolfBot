import { z } from 'zod';
import { cnyUnitPowers, decimal, decimalText, multiplyPowerOfTen, percentChange, subtract } from '../company-research/exact-decimal';

const text = z.string().min(1), digest = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/).max(120);
const binding = z.object({ path: text, sha256: digest }).passthrough();
const period = z.object({ start: z.iso.date(), end: z.iso.date(), kind: z.literal('annual') }).strict();
const metric = z.enum(['revenue', 'parent_net_profit', 'operating_cash_flow']);
const unit = z.enum(['yuan', 'thousand_yuan', 'ten_thousand_yuan', 'million_yuan', 'hundred_million_yuan']);
const source = z.object({ documentId: text, bytesSha256: digest, filePage: z.number().int().positive() }).strict();
const value = z.object({ rawValue: amount, normalizedYuan: amount, source }).strict();
const range = z.object({ documentId: text, bytesSha256: digest, filePageStart: z.number().int().positive(), filePageEnd: z.number().int().positive() }).strict()
  .refine(value => value.filePageStart <= value.filePageEnd, 'Unordered source range');
export const confirmedReferenceCaseSchema = z.object({
  caseId: text, company: z.object({ symbol: text, name: text }).strict(), periods: z.tuple([period, period]), taskDocumentIds: z.array(text).min(2),
  numericalReference: z.object({ confirmedBy: z.literal('Q6A'), currency: z.literal('CNY'), scope: z.literal('consolidated'), basis: z.literal('annual_cumulative'),
    comparisonBasis: z.enum(['original_disclosure', 'restated_comparative']),
    figures: z.array(z.object({ metric, unit, previous: value, current: value, percentage: amount }).strict()).length(3),
    originalPriorDisclosures: z.array(value.extend({ metric, unit })).max(3), limitations: text,
  }).passthrough(),
  cashFlow: z.object({ questionId: z.literal('cash_flow'), confirmedBy: z.literal('Q7A'), answerability: z.literal('answerable'),
    referenceStatus: z.literal('confirmed_within_choice_card_scope'), comparisonReference: z.literal('numericalReference.figures'),
    acceptedDirectionStatement: text, profitDirectionMetric: z.literal('parent_net_profit'), direction: z.enum(['same', 'opposite']),
    explanationType: text, acceptedReference: text, sourceRanges: z.array(range).min(1),
    accountingBridge: binding.extend({ caseId: text, startingProfitMetric: z.literal('consolidated_net_profit'), beforeYuan: amount, afterYuan: amount, deltaYuan: amount, boundary: text }).optional(),
  }).passthrough(),
  risks: z.object({ questionId: z.literal('risks'), confirmedBy: z.literal('Q8A'), referenceStatus: z.literal('confirmed_within_choice_card_scope'),
    acceptedReference: text, boundary: text, sourceRanges: z.array(range).min(2),
    fullQuestionCoverage: z.enum(['partial', 'not_assessed_by_this_overlay']), actualRiskDegreeConfirmed: z.literal(false),
  }).passthrough(),
  remainingSourceAndExecutionLimitations: z.array(text), supportingDocumentAcceptance: z.array(z.object({ documentId: text, acceptedByTheseChoices: z.literal(false) }).strict()),
  wholeCompanyGolden: z.literal(false),
}).passthrough().superRefine((sample, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const reference = sample.numericalReference;
  if (new Set(reference.figures.map(figure => figure.metric)).size !== 3) fail('All three unique financial metrics required');
  if (new Set(sample.taskDocumentIds).size !== sample.taskDocumentIds.length || sample.periods[0].end >= sample.periods[1].start) fail('Invalid document scope or periods');
  if (reference.comparisonBasis === 'restated_comparative' && reference.originalPriorDisclosures.length !== 3) fail('Restated comparisons must retain three original prior disclosures');
  if (new Set(reference.originalPriorDisclosures.map(figure => figure.metric)).size !== reference.originalPriorDisclosures.length) fail('Duplicate original disclosure metric');
  try {
    for (const figure of reference.figures) {
      for (const entry of [figure.previous, figure.current]) if (subtract(multiplyPowerOfTen(decimal(entry.rawValue), cnyUnitPowers[figure.unit]), decimal(entry.normalizedYuan)).coefficient !== 0n) fail('Invalid exact unit normalization');
      const calculated = percentChange(decimal(figure.previous.normalizedYuan), decimal(figure.current.normalizedYuan));
      const difference = calculated === null ? null : subtract(decimal(calculated), decimal(figure.percentage));
      if (!difference || subtract({ ...difference, coefficient: difference.coefficient < 0n ? -difference.coefficient : difference.coefficient }, decimal('0.01')).coefficient > 0n) fail('Percentage inconsistent with comparative amounts');
    }
    for (const figure of reference.originalPriorDisclosures) if (decimalText(multiplyPowerOfTen(decimal(figure.rawValue), cnyUnitPowers[figure.unit])) !== decimalText(decimal(figure.normalizedYuan))) fail('Invalid original disclosure normalization');
  } catch { fail('Invalid exact decimal reference'); }
});
export const confirmedReferenceDatasetSchema = z.object({
  schemaVersion: z.literal(1), referenceVersion: z.literal('research-dev-u-confirmed-references-20261026-v1'),
  artifactKind: z.literal('bounded_reference_overlay'), status: z.literal('confirmed_within_choice_card_scope'), recordedAt: text,
  sourceDataset: binding.extend({ datasetVersion: text }), choiceCard: binding.extend({ commit: z.string().regex(/^[a-f0-9]{40}$/) }),
  confirmation: binding.extend({ originalResponse: z.literal('A A  A B'), choices: z.object({ Q6: z.literal('A'), Q7: z.literal('A'), Q8: z.literal('A'), Q9: z.literal('B') }).strict(),
    method: text, personalReadingTime: z.null(), signature: z.null() }), evidence: z.array(binding).min(1),
  integration: z.object({ scorerIntegrated: z.literal(false), runnerIntegrated: z.literal(false), datasetFrozen: z.literal(false), formalAnswerabilityLabelsFrozen: z.literal(false),
    humanGoldenCompaniesAdded: z.literal(0), executionApproved: z.literal(false) }).passthrough(),
  experimentPreference: z.object({ model: z.literal('gpt-6.1-sol'), reasoning: z.literal('max'), status: z.literal('preference_only'), executionApproved: z.literal(false) }).passthrough(),
  summary: z.object({ numericCaseReferencesConfirmed: z.literal(10), cashFlowAnswerabilityReferencesConfirmed: z.literal(10), riskSectionReferencesConfirmed: z.literal(10),
    riskFullQuestionCoverageStillPartial: z.array(text).length(2), confirmedNotDisclosedCases: z.array(z.never()).length(0), wholeCompanyGoldenPromotions: z.literal(0) }).strict(),
  cases: z.array(confirmedReferenceCaseSchema).length(10),
}).passthrough().superRefine((dataset, ctx) => {
  if (new Set(dataset.cases.map(sample => sample.caseId)).size !== dataset.cases.length) ctx.addIssue({ code: 'custom', message: 'Duplicate confirmed reference case' });
  const partial = dataset.cases.filter(sample => sample.risks.fullQuestionCoverage === 'partial').map(sample => sample.caseId).sort();
  if (JSON.stringify(partial) !== JSON.stringify([...dataset.summary.riskFullQuestionCoverageStillPartial].sort()) || JSON.stringify(partial) !== JSON.stringify(['dev-600036', 'dev-601318'])) ctx.addIssue({ code: 'custom', message: 'Bounded risk coverage may not be promoted' });
});
export type ConfirmedReferenceCase = z.infer<typeof confirmedReferenceCaseSchema>;
export type ConfirmedReferenceDataset = z.infer<typeof confirmedReferenceDatasetSchema>;
