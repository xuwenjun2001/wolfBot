import { z } from 'zod';
import type { FinancialFact, ResearchDocument, VersionedCitation } from './document-contracts';
import type { ResearchReportRevision } from './revision-contracts';
import { canonicalResearchJson } from './task-contracts';
import { artifactDigest } from './artifact-store';
import { monetaryUnit } from './financial-normalization';
import { decimal, decimalText } from './exact-decimal';
import { evidenceAmounts, financialLabels, numericEvidenceText, yearAmountColumn } from './numeric-evidence';

export const semanticReviewSchema = z.object({
  version: z.literal('claim-review-v1'), claimHash: z.string().length(64),
  verdict: z.enum(['supported', 'insufficient', 'conflict']), reason: z.string().min(1).max(1200),
  method: z.enum(['human', 'calibrated_model']), reviewer: z.string().min(1).max(100),
  independence: z.enum(['human', 'separate_call_same_model', 'different_model']),
  calibration: z.string().min(1).max(200), reviewedAt: z.iso.datetime({ offset: true }),
}).strict();
export type SemanticReview = z.infer<typeof semanticReviewSchema>;
export type ResearchClaim = ResearchReportRevision['claims'][number];
export function claimReviewHash(report: Pick<ResearchReportRevision, 'taskId' | 'requestRevision' | 'planRevision' | 'asOf' | 'facts' | 'supportingFacts'>, claim: ResearchClaim) {
  return artifactDigest(canonicalResearchJson({ version: 'claim-review-v1', taskId: report.taskId, requestRevision: report.requestRevision, planRevision: report.planRevision,
    asOf: report.asOf, claim, facts: [...report.facts, ...(report.supportingFacts || [])].filter(f => claim.factIds.includes(f.id)) }));
}
export const normalEvidence = (v: string) => v.normalize('NFKC').replace(/\s+/gu, '');
/** Conservative native-table check. Ambiguous columns require repair, never guessed approval. */
export function numericFactErrors(fact: FinancialFact, documents: ResearchDocument[], page: (citation: VersionedCitation) => string | undefined): string[] {
  if (fact.value.status !== 'known' || fact.derivedFrom) return [];
  const errors: string[] = [];
  for (const citation of fact.citations) {
    const document = documents.find(d => d.id === citation.documentId && d.version === citation.documentVersion);
    const original = page(citation) || '', quote = normalEvidence(citation.quote);
    if (!document || !original || !normalEvidence(original).includes(quote)) { errors.push('FACT_ORIGINAL_MISSING'); continue; }
    // Join wrapped Chinese labels, but preserve the boundary between two amount columns.
    const text = numericEvidenceText(original);
    const label = financialLabels[fact.metric].exec(text);
    const units = [...text.matchAll(/单位[:：]?(?:人民币)?(亿元|万元|千元|元)/g)].map(m => monetaryUnit(m[1]));
    // Summary tables often declare the unit on each metric row. Bind it to this
    // exact label; another row's unit cannot establish this fact's scale.
    const rowUnit = label && text.slice(label.index + label[0].length).match(/^\((?:人民币)?(亿元|万元|千元|元)\)/);
    if (rowUnit) units.push(monetaryUnit(rowUnit[1]));
    const inlineUnit = normalEvidence(citation.quote).match(/\d(?:\.\d+)?(亿元|万元|千元|元)(?![\/／股])/);
    if (!units.length && inlineUnit) units.push(monetaryUnit(inlineUnit[1]));
    if (!units.includes(fact.value.unit) || new Set(units).size > 1) errors.push('FACT_UNIT_UNVERIFIED');
    if (fact.scope === 'consolidated' && /母公司(?:利润表|现金流量表|资产负债表)/.test(text) && !/合并(?:利润表|现金流量表|资产负债表)/.test(text)) errors.push('FACT_SCOPE_MISMATCH');
    if (!label) { errors.push('FACT_METRIC_UNVERIFIED'); continue; }
    const row = text.slice(label.index + label[0].length).replace(/^\((?:人民币)?(?:亿元|万元|千元|元)\)/, '').match(/^[\d.,|()−-]+/)?.[0] || '';
    const numbers = evidenceAmounts(row);
    const raw = fact.value.raw;
    const equal = (value: string | undefined) => value !== undefined && decimalText(decimal(value)) === decimalText(decimal(raw));
    if (!evidenceAmounts(citation.quote).some(equal)) errors.push('FACT_QUOTED_NUMBER_MISMATCH');
    // Document period alone cannot prove which numeric column belongs to the fact.
    if (fact.period.start === document.period.start && fact.period.end === document.period.end) {
      const column = yearAmountColumn(text, label.index, fact.period.end.slice(0, 4), numbers.length);
      if (column === null || !equal(numbers[column])) errors.push('FACT_PERIOD_COLUMN_MISMATCH');
    } else {
      const header = fact.periodEvidence?.filter(c => c.documentId === document.id && c.documentVersion === document.version).map(c => normalEvidence(c.quote)).join('') || '';
      if (!header.includes(fact.period.end.slice(0, 4)) || !numbers.some(equal)) errors.push('FACT_PERIOD_COLUMN_MISMATCH');
      const headingYears = [...header.matchAll(/(?:19|20)\d{2}年/g)].map(m => m[0]);
      const headingPosition = header ? text.lastIndexOf(header, label.index) : -1;
      const explicitSinglePeriod = headingYears.length === 1 && headingYears[0] === `${fact.period.end.slice(0, 4)}年` && headingPosition >= 0 && label.index - headingPosition < 200 && equal(numbers[0]);
      if (!explicitSinglePeriod) errors.push('FACT_PRIOR_COLUMN_REVIEW_REQUIRED');
    }
  }
  return [...new Set(errors)];
}

export function semanticPublicationErrors(report: ResearchReportRevision, reviews: SemanticReview[]) {
  return report.claims.filter(c => c.status === 'supported').flatMap(c => {
    const hash = claimReviewHash(report, c), review = reviews.find(r => r.claimHash === hash);
    return !review ? [`CLAIM_REVIEW_MISSING:${c.id}`] : review.verdict !== 'supported' ? [`CLAIM_SEMANTIC_${review.verdict.toUpperCase()}:${c.id}`] : [];
  });
}
