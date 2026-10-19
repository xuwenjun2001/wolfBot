import { z } from 'zod';
import { financialFactSchema, researchCitationSchema, documentAvailableAt, type ResearchDocument, type VersionedCitation } from './document-contracts';
import { companyIdentitySchema, researchIdSchema, researchQuestionSchema, revisionSchema, timestampSchema, type ResearchTaskSpec } from './task-contracts';
import { isResearchEvidencePeriod } from './evidence-periods';
import { factCitations, financialEvidenceErrors } from './financial-evidence';

export const researchClaimSchema = z.object({
  id: researchIdSchema, questionId: researchQuestionSchema.shape.id, text: z.string().min(1).max(3000),
  kind: z.enum(['fact', 'inference', 'opinion']), status: z.enum(['supported', 'evidence_gap', 'conflict', 'incomparable']),
  reason: z.string().min(1).max(1000).optional(), factIds: z.array(researchIdSchema).max(20), citations: z.array(researchCitationSchema).max(10),
}).strict().superRefine((c, ctx) => {
  if (c.status === 'supported' && c.citations.length === 0) ctx.addIssue({ code: 'custom', message: 'Supported claims need citations' });
  if (c.status !== 'supported' && !c.reason) ctx.addIssue({ code: 'custom', message: 'Unresolved claims need an explicit reason' });
});
export const researchReportRevisionSchema = z.object({
  schemaVersion: z.literal(1), taskId: z.uuid(), requestRevision: revisionSchema, planRevision: revisionSchema, revision: revisionSchema,
  companySymbol: companyIdentitySchema.shape.symbol, periodIds: z.tuple([researchIdSchema, researchIdSchema]), asOf: timestampSchema,
  generatedAt: timestampSchema, status: z.enum(['completed', 'partial', 'failed', 'cancelled']),
  facts: z.array(financialFactSchema).max(100), claims: z.array(researchClaimSchema).max(100),
  supportingFacts: z.array(financialFactSchema).max(100).optional(),
  gaps: z.array(z.object({ code: z.enum(['evidence_gap', 'evidence_conflict', 'incomparable_period', 'future_evidence', 'unknown_disclosure', 'parse_failure']), questionId: researchQuestionSchema.shape.id, message: z.string().min(1).max(1000) }).strict()).max(100),
}).strict().superRefine((r, ctx) => {
  const allFacts = [...r.facts, ...(r.supportingFacts || [])];
  if (new Set(allFacts.map(f => f.id)).size !== allFacts.length || new Set(r.claims.map(c => c.id)).size !== r.claims.length) ctx.addIssue({ code: 'custom', message: 'Duplicate fact or claim IDs' });
  if (r.status === 'completed' && (r.gaps.length || !r.claims.length || r.claims.some(c => c.status !== 'supported') || r.facts.some(f => f.value.status !== 'known'))) ctx.addIssue({ code: 'custom', message: 'Completed report contains unresolved evidence' });
});
export type ResearchReportRevision = z.infer<typeof researchReportRevisionSchema>;

/** Referential/time integrity only. This does not prove semantic support. */
export function reportBindingErrors(report: ResearchReportRevision, spec: ResearchTaskSpec, documents: ResearchDocument[], pageText?: (documentId: string, version: number, filePage: number) => string | undefined, locatedText?: (citation: VersionedCitation) => string | undefined): string[] {
  const errors: string[] = [];
  if (report.requestRevision !== spec.requestRevision || report.companySymbol !== spec.company.symbol || new Date(report.asOf).getTime() !== new Date(spec.asOf).getTime() || report.periodIds.some((id, i) => id !== spec.periods[i].id)) errors.push('REPORT_REQUEST_MISMATCH');
  if (spec.comparison.status === 'incomparable' && report.status === 'completed') errors.push('INCOMPARABLE_REPORT_COMPLETED');
  const verify = (c: VersionedCitation) => {
    const d = documents.find(d => d.id === c.documentId && d.version === c.documentVersion);
    if (!d || d.taskId !== report.taskId || d.bytesSha256 !== c.bytesSha256 || d.company.symbol !== spec.company.symbol) { errors.push('CITATION_DOCUMENT_MISMATCH'); return; }
    if (!isResearchEvidencePeriod(spec, d.period)) errors.push('CITATION_PERIOD_MISMATCH');
    if (d.state === 'unreadable' || d.parser?.warnings.includes('issuer_or_report_year_unverified')) errors.push('CITATION_DOCUMENT_UNUSABLE');
    if (!documentAvailableAt(d, spec.asOf)) errors.push('CITATION_NOT_AVAILABLE_ASOF');
    if (c.locator.kind !== 'html') {
      if (d.mediaType !== 'application/pdf' || !d.pageCount || c.locator.filePage > d.pageCount) errors.push('CITATION_PAGE_OUT_OF_RANGE');
      if (pageText) {
        const text = pageText(d.id, d.version, c.locator.filePage);
        const normal = (v: string) => v.normalize('NFKC').replace(/\s+/gu, '');
        if (!text || !normal(text).includes(normal(c.quote))) errors.push('CITATION_QUOTE_MISMATCH');
      }
    } else if (d.mediaType !== 'text/html') errors.push('CITATION_LOCATOR_TYPE_MISMATCH');
    if (locatedText) {
      const text = locatedText(c), normal = (v: string) => v.normalize('NFKC').replace(/\s+/gu, '');
      if (!text || !normal(text).includes(normal(c.quote))) errors.push('CITATION_LOCATOR_MISMATCH');
    }
  };
  errors.push(...financialEvidenceErrors(report.facts, report.supportingFacts || [], spec, documents));
  for (const f of [...report.facts, ...(report.supportingFacts || [])]) factCitations(f).forEach(verify);
  for (const c of report.claims) {
    if (c.factIds.some(id => !report.facts.some(f => f.id === id))) errors.push('CLAIM_FACT_NOT_FOUND');
    if (c.status === 'supported' && c.factIds.some(id => report.facts.some(f => f.id === id && f.value.status !== 'known'))) errors.push('CLAIM_UNRESOLVED_FACT');
    c.citations.forEach(citation => verify(citation));
  }
  if (report.status === 'completed') {
    for (const q of spec.questions) if (!report.claims.some(c => c.questionId === q.id && c.status === 'supported')) errors.push('REQUIRED_QUESTION_MISSING');
    for (const period of spec.periods) for (const metric of ['revenue', 'parent_net_profit', 'operating_cash_flow']) if (!report.facts.some(f => f.period.id === period.id && f.metric === metric && f.value.status === 'known')) errors.push('REQUIRED_FACT_MISSING');
  }
  return [...new Set(errors)];
}

export const researchEventSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), taskId: z.uuid(), sequence: z.number().int().min(1), at: timestampSchema,
  requestRevision: revisionSchema, planRevision: revisionSchema.nullable(), reportRevision: revisionSchema.nullable(),
  attemptId: z.uuid().nullable(), generation: z.number().int().min(0),
  event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('task.created') }).strict(), z.object({ type: z.literal('plan.created') }).strict(),
    z.object({ type: z.literal('document.registered'), documentId: researchIdSchema, version: revisionSchema }).strict(),
    z.object({ type: z.literal('attempt.started') }).strict(), z.object({ type: z.literal('attempt.finished'), status: z.enum(['completed', 'partial', 'failed', 'cancelled', 'superseded']) }).strict(),
    z.object({ type: z.literal('report.created'), status: z.enum(['completed', 'partial', 'failed', 'cancelled']) }).strict(),
    z.object({ type: z.literal('task.cancelled') }).strict(),
  ]),
}).strict().superRefine((v, ctx) => {
  if (v.event.type === 'plan.created' && v.planRevision === null) ctx.addIssue({ code: 'custom', message: 'Plan event needs revision' });
  if (v.event.type === 'report.created' && v.reportRevision === null) ctx.addIssue({ code: 'custom', message: 'Report event needs revision' });
  if (v.event.type.startsWith('attempt.') && (!v.attemptId || v.generation < 1 || v.planRevision === null)) ctx.addIssue({ code: 'custom', message: 'Attempt event needs plan and fencing identity' });
});
export type ResearchVersionEvent = z.infer<typeof researchEventSchema>;
