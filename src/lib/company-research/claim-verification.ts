import { z } from 'zod';
import type { FinancialFact, ResearchDocument, VersionedCitation } from './document-contracts';
import type { ResearchReportRevision } from './revision-contracts';
import { canonicalResearchJson } from './task-contracts';
import { artifactDigest } from './artifact-store';
import { monetaryUnit } from './financial-normalization';
import { decimal, decimalText } from './exact-decimal';
import { evidenceAmounts, financialLabels, financialRowUnits, monetaryUnitPattern, numericEvidenceText, yearAmountColumn } from './numeric-evidence';
import { sameFinancialEvidenceLocation } from './financial-comparison';

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
    let label = financialLabels[fact.metric].exec(text);
    // A bare consolidated net-profit row is never an alias for parent profit.
    // Some summaries explicitly mark this particular row with an attribution footnote.
    if (!label && fact.metric === 'parent_net_profit') {
      const candidate = /(?<!扣除非经常性损益的)净利润注(\d+)/.exec(text);
      if (candidate) {
        const nextUnit = text.slice(candidate.index + candidate[0].length).search(new RegExp(`(?:单位[:：]?(?:人民币)?|人民币)${monetaryUnitPattern}`));
        const section = text.slice(candidate.index, nextUnit < 0 ? undefined : candidate.index + candidate[0].length + nextUnit);
        if (new RegExp(`${candidate[1]}[、.．:：]以归属于(?:本公司|母公司|上市公司)股东的数据填列`).test(section)) label = candidate;
      }
    }
    if (!label || !quote.includes(label[0])) { errors.push('FACT_METRIC_UNVERIFIED'); continue; }
    const context = financialRowUnits(text, label.index, label[0].length), units = context.units.map(monetaryUnit);
    const inlineUnit = normalEvidence(citation.quote).match(new RegExp(`\\d(?:\\.\\d+)?(${monetaryUnitPattern})(?![\\/／股])`));
    if (!units.length && inlineUnit) units.push(monetaryUnit(inlineUnit[1]));
    if (!units.includes(fact.value.unit) || new Set(units).size > 1) errors.push('FACT_UNIT_UNVERIFIED');
    if (context.foreignCurrency) errors.push('FACT_CURRENCY_UNVERIFIED');
    if (fact.scope === 'consolidated' && /母公司(?:利润表|现金流量表|资产负债表)/.test(text) && !/合并(?:利润表|现金流量表|资产负债表)/.test(text)) errors.push('FACT_SCOPE_MISMATCH');
    const remaining = text.slice(label.index + label[0].length).replace(new RegExp(`^\\((?:人民币)?${monetaryUnitPattern}\\)`), '');
    let row = remaining.match(/^[\d.,|()−-]+/)?.[0] || '';
    if (remaining.slice(row.length).startsWith('年')) row = row.replace(/(?:\||^)(?:19|20)\d{2}$/, '');
    const numbers = evidenceAmounts(row);
    const raw = fact.value.raw;
    const equal = (value: string | undefined) => value !== undefined && decimalText(decimal(value)) === decimalText(decimal(raw));
    if (!evidenceAmounts(citation.quote).some(equal)) errors.push('FACT_QUOTED_NUMBER_MISMATCH');
    const headers = (fact.periodEvidence || []).filter(header => (sameFinancialEvidenceLocation(citation, header)
      || citation.locator.kind === 'html' && header.locator.kind === 'html' && citation.documentId === header.documentId
        && citation.documentVersion === header.documentVersion && citation.bytesSha256 === header.bytesSha256)
      && context.header.text.includes(numericEvidenceText(header.quote)) && normalEvidence(original).includes(normalEvidence(header.quote))
      && new RegExp(`(?:^|[^0-9])${fact.period.end.slice(0, 4)}年`).test(normalEvidence(header.quote)));
    if (fact.accountingBasis && !headers.length) errors.push('FACT_COMPARISON_HEADER_UNVERIFIED');
    // Document period alone cannot prove which numeric column belongs to the fact.
    if (fact.period.start === document.period.start && fact.period.end === document.period.end) {
      const column = yearAmountColumn(text, label.index, fact.period.end.slice(0, 4), numbers.length);
      if (column === null || !equal(numbers[column])) errors.push('FACT_PERIOD_COLUMN_MISMATCH');
    } else {
      const column = yearAmountColumn(text, label.index, fact.period.end.slice(0, 4), numbers.length, fact.restatement);
      if (!headers.length || column === null || !equal(numbers[column])) errors.push('FACT_PERIOD_COLUMN_MISMATCH');
      const restatementDisclosed = /调整后|重述|重列/.test(context.header.text) || (fact.accountingBasisEvidence || []).some(evidence =>
        evidence.documentId === citation.documentId && evidence.documentVersion === citation.documentVersion && evidence.bytesSha256 === citation.bytesSha256
        && /追溯调整|重述|重列/.test(normalEvidence(evidence.quote)) && normalEvidence(page(evidence) || '').includes(normalEvidence(evidence.quote)));
      if (fact.restatement !== 'restated' || !restatementDisclosed) errors.push('FACT_RESTATEMENT_UNVERIFIED');
    }
  }
  for (const evidence of fact.accountingBasisEvidence || []) if (!normalEvidence(page(evidence) || '').includes(normalEvidence(evidence.quote))) errors.push('FACT_BASIS_ORIGINAL_MISSING');
  return [...new Set(errors)];
}

export function semanticPublicationErrors(report: ResearchReportRevision, reviews: SemanticReview[]) {
  return report.claims.filter(c => c.status === 'supported').flatMap(c => {
    const hash = claimReviewHash(report, c), review = reviews.find(r => r.claimHash === hash);
    return !review ? [`CLAIM_REVIEW_MISSING:${c.id}`] : review.verdict !== 'supported' ? [`CLAIM_SEMANTIC_${review.verdict.toUpperCase()}:${c.id}`] : [];
  });
}
