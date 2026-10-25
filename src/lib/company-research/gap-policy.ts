import { createHash } from 'node:crypto';
import { z } from 'zod';
import { researchLocatorSchema } from './document-contracts';
import { researchIdSchema, sha256Schema } from './task-contracts';

export const gapPolicyLimits = {
  maxGaps: 96, maxObservationEvidence: 64, maxSeenEvidence: 256,
  maxStalledAttempts: 4, maxRetrievalAttempts: 8, maxRepairAttempts: 3,
} as const;
export const researchGapTypeSchema = z.enum([
  'retrieval_miss', 'not_disclosed', 'period_unit_conflict', 'tool_transient', 'unverified_claim', 'budget_exhausted',
]);
export type ResearchGapType = z.infer<typeof researchGapTypeSchema>;
const targetFields = {
  targetNodeId: researchIdSchema, questionId: researchIdSchema.nullable(), question: z.string().trim().min(1).max(2000),
};
const originalScopeSchema = z.object({
  documentId: researchIdSchema, documentVersion: z.number().int().min(1), bytesSha256: sha256Schema,
  periodId: researchIdSchema, complete: z.boolean(), truncated: z.boolean(), failedPages: z.number().int().min(0),
  quality: z.enum(['native', 'human_reviewed', 'needs_review']),
}).strict();
/** Application-owned receipt, never a model argument or a statement copied from a document. */
export const notDisclosedConfirmationSchema = z.object({
  ...targetFields, authority: z.enum(['human', 'original_scope']), receiptSha256: sha256Schema,
  explicitlyConfirmed: z.literal(true), periodIds: z.array(researchIdSchema).length(2),
  originals: z.array(originalScopeSchema).min(2).max(20),
}).strict();
export const gapObservationSchema = z.object({
  ...targetFields, kind: z.enum([...researchGapTypeSchema.options, 'resolved']),
  subjectId: researchIdSchema.nullable().optional(), reason: z.string().trim().min(1).max(600).optional(),
  tool: z.string().min(1).max(80).optional(), query: z.string().min(1).max(300).optional(), retryable: z.boolean().optional(),
  evidence: z.array(z.object({
    documentId: researchIdSchema, documentVersion: z.number().int().min(1), bytesSha256: sha256Schema,
    locator: researchLocatorSchema, evidenceHash: sha256Schema.optional(),
  }).strict()).max(gapPolicyLimits.maxObservationEvidence).optional(),
  requiredPeriodIds: z.array(researchIdSchema).length(2).optional(),
  notDisclosedConfirmation: notDisclosedConfirmationSchema.optional(),
}).strict();
export type GapObservation = z.infer<typeof gapObservationSchema>;
const stopReasonSchema = z.enum([
  'no_new_evidence', 'attempt_limit', 'confirmed_not_disclosed', 'budget_exhausted', 'non_retryable', 'evidence_limit',
]);
export const researchGapSchema = z.object({
  ...targetFields, id: sha256Schema, type: researchGapTypeSchema,
  subjectId: researchIdSchema.nullable(), status: z.enum(['open', 'partial', 'not_disclosed']),
  reason: z.string().min(1).max(600), tool: z.string().max(80).nullable(),
  attempts: z.number().int().min(1).max(1000), stalledAttempts: z.number().int().min(0).max(1000),
  seenLocatorKeys: z.array(sha256Schema).max(gapPolicyLimits.maxSeenEvidence),
  seenEvidenceHashes: z.array(sha256Schema).max(gapPolicyLimits.maxSeenEvidence),
  newLocatorKeys: z.array(sha256Schema).max(gapPolicyLimits.maxObservationEvidence),
  newEvidenceHashes: z.array(sha256Schema).max(gapPolicyLimits.maxObservationEvidence),
  lastQuery: z.string().max(300).nullable(), queryChanged: z.boolean(), retryable: z.boolean(),
  stopReason: stopReasonSchema.nullable(),
  notDisclosedConfirmation: notDisclosedConfirmationSchema.nullable(),
}).strict().refine(g => g.status !== 'not_disclosed' || (g.type === 'not_disclosed' && !!g.notDisclosedConfirmation),
  'Not-disclosed gaps require an application-owned confirmation');
export type ResearchGap = z.infer<typeof researchGapSchema>;
export const gapPolicyStateSchema = z.object({ gaps: z.array(researchGapSchema).max(gapPolicyLimits.maxGaps).default([]) });
export type GapPolicyState = Readonly<{ gaps?: readonly ResearchGap[] }>;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function locatorKey(evidence: NonNullable<GapObservation['evidence']>[number]) {
  const l = evidence.locator;
  // Page labels and boxes do not turn a repeated location into new evidence.
  const location = l.kind === 'page' ? [l.kind, l.filePage] : l.kind === 'block' ? [l.kind, l.filePage, l.blockId]
    : l.kind === 'table' ? [l.kind, l.filePage, l.tableId, l.row, l.column] : [l.kind, l.blockId, l.selector];
  return digest([evidence.documentId, evidence.documentVersion, evidence.bytesSha256, location]);
}
function confirmedNotDisclosed(observation: GapObservation) {
  const c = observation.notDisclosedConfirmation, periods = observation.requiredPeriodIds;
  if (!c || !periods || new Set(periods).size !== 2 || new Set(c.periodIds).size !== 2
    || c.targetNodeId !== observation.targetNodeId || c.questionId !== observation.questionId || c.question !== observation.question
    || !periods.every(p => c.periodIds.includes(p) && c.originals.some(o => o.periodId === p))) return false;
  // A human receipt confirms the checked two-period scope. Automatic scope receipts
  // additionally need complete originals, with no truncation or unchecked parsing.
  return c.authority === 'human' || c.originals.every(o => o.complete && !o.truncated && o.failedPages === 0 && o.quality !== 'needs_review');
}
const attemptLimit = (type: ResearchGapType) => type === 'retrieval_miss' ? gapPolicyLimits.maxRetrievalAttempts
  : type === 'not_disclosed' || type === 'budget_exhausted' ? 0 : gapPolicyLimits.maxRepairAttempts;
const gapFamily = (type: ResearchGapType) => type === 'not_disclosed' ? 'retrieval_miss' : type;

/** Classify trusted tool observations; query wording never contributes to evidence gain. */
export function classifyGap(input: GapObservation, state: GapPolicyState = {}): ResearchGap | null {
  const observation = gapObservationSchema.parse(input), gaps = gapPolicyStateSchema.parse(state).gaps;
  if (observation.kind === 'resolved') return null;
  const confirmed = observation.kind === 'not_disclosed' && confirmedNotDisclosed(observation);
  const type = observation.kind === 'not_disclosed' && !confirmed ? 'retrieval_miss' : observation.kind;
  const subjectId = observation.subjectId ?? null;
  const id = digest([observation.targetNodeId, observation.questionId, subjectId, gapFamily(type)]);
  const previous = gaps.find(g => g.id === id);
  const locatorKeys = [...new Set((observation.evidence || []).map(locatorKey))];
  const evidenceHashes = [...new Set((observation.evidence || []).flatMap(e => e.evidenceHash ? [e.evidenceHash] : []))];
  const newLocatorKeys = locatorKeys.filter(key => !previous?.seenLocatorKeys.includes(key));
  const newEvidenceHashes = evidenceHashes.filter(hash => !previous?.seenEvidenceHashes.includes(hash));
  const seenLocators = [...new Set([...(previous?.seenLocatorKeys || []), ...newLocatorKeys])];
  const seenHashes = [...new Set([...(previous?.seenEvidenceHashes || []), ...newEvidenceHashes])];
  const evidenceLimit = seenLocators.length > gapPolicyLimits.maxSeenEvidence || seenHashes.length > gapPolicyLimits.maxSeenEvidence;
  const attempts = Math.min(1000, (previous?.attempts || 0) + 1);
  const stalledAttempts = newLocatorKeys.length || newEvidenceHashes.length ? 0 : Math.min(1000, (previous?.stalledAttempts || 0) + 1);
  const retryable = observation.retryable !== false;
  const stopReason = confirmed ? 'confirmed_not_disclosed' : type === 'budget_exhausted' ? 'budget_exhausted'
    : type === 'tool_transient' && !retryable ? 'non_retryable' : evidenceLimit ? 'evidence_limit'
    : stalledAttempts >= gapPolicyLimits.maxStalledAttempts ? 'no_new_evidence' : attempts >= attemptLimit(type) ? 'attempt_limit' : null;
  return researchGapSchema.parse({
    targetNodeId: observation.targetNodeId, questionId: observation.questionId, question: observation.question,
    id, type, subjectId, status: confirmed ? 'not_disclosed' : stopReason ? 'partial' : 'open',
    reason: observation.kind === 'not_disclosed' && !confirmed ? '尚无覆盖两期范围的可信未披露确认，检索缺证仅能保留 partial'
      : observation.reason || '证据尚不足以完成目标',
    tool: observation.tool || previous?.tool || null, attempts, stalledAttempts,
    seenLocatorKeys: seenLocators.slice(0, gapPolicyLimits.maxSeenEvidence),
    seenEvidenceHashes: seenHashes.slice(0, gapPolicyLimits.maxSeenEvidence), newLocatorKeys, newEvidenceHashes,
    lastQuery: observation.query ?? previous?.lastQuery ?? null,
    queryChanged: !!(observation.query && previous?.lastQuery && observation.query !== previous.lastQuery),
    retryable, stopReason, notDisclosedConfirmation: confirmed ? observation.notDisclosedConfirmation : null,
  });
}

/** Upsert without mutation or eviction, so checkpoint compaction cannot silently reset a retry counter. */
export function updateGap(gaps: readonly ResearchGap[], gap: ResearchGap): ResearchGap[] {
  const current = gapPolicyStateSchema.parse({ gaps }).gaps, next = researchGapSchema.parse(gap);
  const index = current.findIndex(g => g.id === next.id);
  if (index >= 0) return current.map((g, i) => i === index ? next : g);
  if (current.length >= gapPolicyLimits.maxGaps) throw new RangeError('Research gap checkpoint capacity reached');
  return [...current, next];
}

const stopConditionSchema = z.enum([
  'target_satisfied', 'no_new_evidence_limit', 'attempt_limit', 'evidence_limit', 'confirmed_not_disclosed',
  'non_retryable_error', 'research_budget_reserved', 'budget_exhausted', 'deadline_exceeded', 'closure_complete',
]);
export const gapRepairActionSchema = z.object({
  action: z.enum(['search_evidence', 'read_targeted_evidence', 'inspect_period_unit', 'retry_tool', 'verify_claim', 'finalize_partial', 'verify_and_finalize', 'stop']),
  targetNodeId: researchIdSchema, maxAttempts: z.number().int().min(0).max(1000), stopWhen: z.array(stopConditionSchema).min(1).max(10),
}).strict();
export type GapRepairAction = z.infer<typeof gapRepairActionSchema>;
const repairBudgetSchema = z.object({
  remaining: z.number().int().min(0).max(1000), reserve: z.number().int().min(0).max(1000).default(0),
  deadlineExceeded: z.boolean().default(false),
});
export type GapRepairBudget = z.input<typeof repairBudgetSchema>;

/** maxAttempts bounds further repair attempts; closure still uses the parent's atomic budget ledger. */
export function repairAction(input: ResearchGap, inputBudget: GapRepairBudget): GapRepairAction {
  const gap = researchGapSchema.parse(input), budget = repairBudgetSchema.parse(inputBudget);
  const result = (action: GapRepairAction['action'], maxAttempts: number, stopWhen: GapRepairAction['stopWhen']): GapRepairAction =>
    ({ action, targetNodeId: gap.targetNodeId, maxAttempts, stopWhen });
  if (budget.deadlineExceeded) return result('stop', 0, ['deadline_exceeded']);
  if (budget.remaining === 0) return result('stop', 0, ['budget_exhausted']);
  if (gap.type === 'budget_exhausted' || budget.remaining <= budget.reserve)
    return result('verify_and_finalize', budget.remaining, ['closure_complete', 'budget_exhausted']);
  if (gap.status !== 'open') {
    const condition = gap.stopReason === 'no_new_evidence' ? 'no_new_evidence_limit'
      : gap.stopReason === 'non_retryable' ? 'non_retryable_error' : gap.stopReason || 'attempt_limit';
    return result('finalize_partial', 0, [condition]);
  }
  const available = Math.max(0, Math.min(attemptLimit(gap.type) - gap.attempts, budget.remaining - budget.reserve));
  if (!available) return result('finalize_partial', 0, ['attempt_limit']);
  const action = gap.type === 'period_unit_conflict' ? 'inspect_period_unit' : gap.type === 'tool_transient' ? 'retry_tool'
    : gap.type === 'unverified_claim' ? 'verify_claim' : gap.newLocatorKeys.length || gap.seenLocatorKeys.length ? 'read_targeted_evidence' : 'search_evidence';
  return result(action, available, ['target_satisfied', 'no_new_evidence_limit', 'attempt_limit', 'research_budget_reserved', 'budget_exhausted']);
}
