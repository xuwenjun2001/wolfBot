import { createHash } from 'node:crypto';
import { z } from 'zod';

export const revisionSchema = z.number().int().min(1);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const researchIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
export const timestampSchema = z.iso.datetime({ offset: true });
export const companyIdentitySchema = z.object({
  symbol: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/), name: z.string().trim().min(1).max(100),
  exchange: z.enum(['SH', 'SZ', 'BJ']), issuerId: z.string().max(100).optional(),
}).strict().superRefine((v, ctx) => {
  const validPrefix = v.exchange === 'SH' ? /^6/ : v.exchange === 'SZ' ? /^[03]/ : /^(?:[48]|92)/;
  if (!v.symbol.endsWith(`.${v.exchange}`) || !validPrefix.test(v.symbol)) ctx.addIssue({ code: 'custom', message: 'Company symbol/exchange mismatch' });
});
export const researchPeriodSchema = z.object({
  id: researchIdSchema, start: z.iso.date(), end: z.iso.date(),
  kind: z.enum(['annual', 'interim', 'quarter']), basis: z.enum(['cumulative', 'single_quarter']),
}).strict().superRefine((p, ctx) => {
  if (p.start > p.end) ctx.addIssue({ code: 'custom', message: 'Period start after end' });
  const [year, month, day] = p.start.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const months = p.kind === 'annual' ? 12 : p.kind === 'interim' ? 6 : p.basis === 'single_quarter' ? 3 : Number(p.end.slice(5, 7));
  if (day !== 1 || (p.basis === 'cumulative' && month !== 1) || (p.kind !== 'quarter' && p.basis !== 'cumulative')) ctx.addIssue({ code: 'custom', message: 'Invalid period basis/start' });
  start.setUTCMonth(start.getUTCMonth() + months); start.setUTCDate(start.getUTCDate() - 1);
  if (start.toISOString().slice(0, 10) !== p.end || (p.kind === 'quarter' && !['03', '06', '09', '12'].includes(p.end.slice(5, 7)))) ctx.addIssue({ code: 'custom', message: 'Period kind does not match boundaries' });
});
export const researchQuestionSchema = z.object({
  id: z.enum(['income_profit', 'cash_flow', 'risks']), text: z.string().trim().min(1).max(1000),
}).strict();
export const researchTaskSpecSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('financial_change'), requestRevision: revisionSchema,
  company: companyIdentitySchema, periods: z.tuple([researchPeriodSchema, researchPeriodSchema]),
  asOf: timestampSchema, questions: z.array(researchQuestionSchema).length(3),
  scope: z.enum(['consolidated', 'parent']), currency: z.literal('CNY'),
  comparison: z.discriminatedUnion('status', [z.object({ status: z.literal('comparable') }).strict(),
    z.object({ status: z.literal('incomparable'), reason: z.string().min(1).max(500) }).strict()]),
  budget: z.object({ maxToolCalls: z.number().int().min(1).max(100), timeoutMs: z.number().int().min(1).max(3600000) }).strict(),
}).strict().superRefine((v, ctx) => {
  const [a, b] = v.periods;
  if (a.id === b.id || a.end >= b.start) ctx.addIssue({ code: 'custom', message: 'Periods must be distinct and chronological' });
  if (new Set(v.questions.map(q => q.id)).size !== 3) ctx.addIssue({ code: 'custom', message: 'All three research questions required exactly once' });
  if (new Date(v.asOf).getTime() < new Date(`${b.end}T00:00:00+08:00`).getTime()) ctx.addIssue({ code: 'custom', message: 'Cutoff precedes the requested period end' });
  if (v.comparison.status === 'comparable' && (a.kind !== b.kind || a.basis !== b.basis || a.start.slice(5) !== b.start.slice(5) || a.end.slice(5) !== b.end.slice(5))) ctx.addIssue({ code: 'custom', message: 'Incomparable periods require an explicit reason' });
});
export type ResearchTaskSpec = z.infer<typeof researchTaskSpecSchema>;
export const researchTaskRevisionChangesSchema = z.object({
  questions: z.array(researchQuestionSchema).length(3).optional(),
  periods: z.tuple([researchPeriodSchema, researchPeriodSchema]).optional(),
  asOf: timestampSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'At least one request field must change');
export type ResearchTaskRevisionChanges = z.infer<typeof researchTaskRevisionChangesSchema>;
export const researchPlanSchema = z.object({
  schemaVersion: z.literal(1), taskId: z.uuid(), requestRevision: revisionSchema, revision: revisionSchema,
  createdAt: timestampSchema, steps: z.array(z.object({
    id: researchIdSchema, questionId: researchQuestionSchema.shape.id,
    kind: z.enum(['acquire', 'parse', 'retrieve', 'compare', 'verify', 'report']), title: z.string().min(1).max(300),
  }).strict()).min(1).max(40),
}).strict().refine(p => new Set(p.steps.map(s => s.id)).size === p.steps.length, 'Duplicate plan step IDs');
export type ResearchPlan = z.infer<typeof researchPlanSchema>;
export const taskStatusSchema = z.enum(['draft', 'queued', 'running', 'partial', 'completed', 'failed', 'cancelled']);
export const executionAttemptSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), taskId: z.uuid(), requestRevision: revisionSchema, planRevision: revisionSchema,
  generation: revisionSchema, worker: z.string().min(1).max(200), leaseUntil: timestampSchema, startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(), status: z.enum(['running', 'completed', 'partial', 'failed', 'cancelled', 'superseded']),
}).strict();
export type ResearchExecutionAttempt = z.infer<typeof executionAttemptSchema>;
export const logicalResearchUsageSchema = z.object({
  toolCalls: z.number().int().min(0), inputTokens: z.number().int().min(0).nullable(), outputTokens: z.number().int().min(0).nullable(),
  unknownModelRequests: z.number().int().min(0), startedAt: timestampSchema.nullable(), deadline: timestampSchema.nullable(),
}).strict();

/** Stable over JSON key ordering; every validated user-controlled request field participates. */
export function canonicalResearchJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalResearchJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalResearchJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function researchRequestHash(input: unknown) {
  return createHash('sha256').update(canonicalResearchJson(researchTaskSpecSchema.parse(input))).digest('hex');
}
export function assertPlanForSpec(plan: ResearchPlan, spec: ResearchTaskSpec) {
  if (plan.requestRevision !== spec.requestRevision || plan.steps.some(s => !spec.questions.some(q => q.id === s.questionId))) throw new Error('PLAN_REQUEST_MISMATCH');
}
