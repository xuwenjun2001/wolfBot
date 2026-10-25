import { z } from 'zod';
import type { ResearchTaskSpec } from './task-contracts';

const nodeIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const revisionSchema = z.number().int().min(1);
const questionIdSchema = z.enum(['income_profit', 'cash_flow', 'risks']);
export const planNodeStateSchema = z.enum(['pending', 'ready', 'running', 'waiting_input', 'completed', 'partial', 'failed', 'cancelled']);
export type PlanNodeState = z.infer<typeof planNodeStateSchema>;
export type PlanNodeStates = Readonly<Record<string, PlanNodeState>>;

/** Keep the v1 view unchanged, including its non-null question and legacy kinds. */
export const researchPlanStepSchema = z.object({
  id: nodeIdSchema, questionId: questionIdSchema,
  kind: z.enum(['acquire', 'parse', 'retrieve', 'compare', 'verify', 'report']), title: z.string().min(1).max(300),
}).strict();

const retrievalTools = ['list_documents', 'discover_filings', 'import_filing', 'parse_document', 'search_evidence', 'read_evidence'] as const;
export const financialPlanToolsByKind = {
  prepare: [...retrievalTools, 'record_fact'], retrieve: retrievalTools,
  compare: ['search_evidence', 'read_evidence', 'record_fact', 'record_claim', 'complete_comparison'],
  verify: ['read_evidence', 'verify_claim'], report: ['check_coverage', 'submit_report'],
} as const;
export const financialPlanCompletionByKind = {
  // Preparation ends after a bounded attempt; missing amounts remain gaps, not a global gate.
  prepare: 'facts_prepared', retrieve: 'evidence_retrieved', compare: 'comparison_recorded',
  verify: 'claims_verified', report: 'report_submitted',
} as const;
const financialPlanToolSchema = z.enum([...retrievalTools, 'record_fact', 'record_claim', 'complete_comparison', 'verify_claim', 'check_coverage', 'submit_report']);
export const planNodeSchema = z.object({
  id: nodeIdSchema, questionId: questionIdSchema.nullable(),
  kind: z.enum(['prepare', 'retrieve', 'compare', 'verify', 'report']), title: z.string().min(1).max(300),
  dependsOn: z.array(nodeIdSchema).max(40), allowedTools: z.array(financialPlanToolSchema).min(1).max(11),
  completion: z.enum(['facts_prepared', 'evidence_retrieved', 'comparison_recorded', 'claims_verified', 'report_submitted']),
  budgetShare: z.number().min(0).max(1), role: z.enum(['coordinator', 'income_profit', 'cash_flow', 'risks']),
}).strict().superRefine((node, ctx) => {
  if (new Set(node.dependsOn).size !== node.dependsOn.length) ctx.addIssue({ code: 'custom', path: ['dependsOn'], message: 'Duplicate plan dependencies' });
  if (new Set(node.allowedTools).size !== node.allowedTools.length) ctx.addIssue({ code: 'custom', path: ['allowedTools'], message: 'Duplicate allowed tools' });
  const allowed: readonly string[] = financialPlanToolsByKind[node.kind];
  if (node.allowedTools.some(tool => !allowed.includes(tool))) ctx.addIssue({ code: 'custom', path: ['allowedTools'], message: 'Tool not allowed for plan node kind' });
  if (node.completion !== financialPlanCompletionByKind[node.kind]) ctx.addIssue({ code: 'custom', path: ['completion'], message: 'Completion rule does not match plan node kind' });
  if ((node.questionId === null && node.role !== 'coordinator') || (node.role !== 'coordinator' && node.role !== node.questionId)
    || (node.kind === 'prepare' && (node.questionId !== null || node.role !== 'coordinator'))) ctx.addIssue({ code: 'custom', path: ['role'], message: 'Plan role/question mismatch' });
});
export type PlanNode = z.infer<typeof planNodeSchema>;

/** The legacy steps are a projection; execution authority lives only in nodes. */
function compatibilitySteps(nodes: readonly PlanNode[]) {
  return nodes.flatMap(node => node.questionId !== null && node.kind !== 'prepare'
    ? [{ id: node.id, questionId: node.questionId, kind: node.kind, title: node.title }] : []);
}

export const researchPlanV2Schema = z.object({
  schemaVersion: z.literal(2), taskId: z.uuid(), requestRevision: revisionSchema, revision: revisionSchema,
  createdAt: z.iso.datetime({ offset: true }), nodes: z.array(planNodeSchema).min(1).max(40),
  steps: z.array(researchPlanStepSchema).min(1).max(40),
}).strict().superRefine((plan, ctx) => {
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  if (byId.size !== plan.nodes.length) ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'Duplicate plan node IDs' });
  if (new Set(plan.steps.map(step => step.id)).size !== plan.steps.length) ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Duplicate plan step IDs' });
  for (const [index, node] of plan.nodes.entries()) for (const dependency of node.dependsOn) {
    if (!byId.has(dependency)) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'dependsOn'], message: `Dangling plan dependency: ${dependency}` });
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn || []) if (byId.has(dependency) && !visit(dependency)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (plan.nodes.some(node => !visit(node.id))) ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'Plan graph contains a cycle' });
  for (const [index, node] of plan.nodes.entries()) if (node.questionId === 'risks') {
    const ancestors = new Set(node.dependsOn), pending = [...ancestors];
    while (pending.length) for (const id of byId.get(pending.pop()!)?.dependsOn || []) if (!ancestors.has(id)) { ancestors.add(id); pending.push(id); }
    if ([...ancestors].some(id => byId.get(id)?.kind === 'prepare')) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'dependsOn'], message: 'Risk research cannot depend on financial fact preparation' });
  }
  const totalShare = plan.nodes.reduce((sum, node) => sum + node.budgetShare, 0);
  if (totalShare <= 0 || totalShare > 1 + 1e-9) ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'Plan budget shares must total more than zero and at most one' });
  const projected = compatibilitySteps(plan.nodes), stepsById = new Map(plan.steps.map(step => [step.id, step]));
  if (projected.length !== plan.steps.length || projected.some(step => {
    const legacy = stepsById.get(step.id);
    return !legacy || legacy.questionId !== step.questionId || legacy.kind !== step.kind || legacy.title !== step.title;
  })) ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Plan steps do not match graph projection' });
});
export type ResearchPlanV2 = z.infer<typeof researchPlanV2Schema>;
export type FinancialPlanMetadata = { taskId: string; createdAt: string; revision?: number };

/** A pure builder: the caller supplies task identity and creation time. */
export function buildFinancialPlanV2(spec: ResearchTaskSpec, metadata: FinancialPlanMetadata): ResearchPlanV2 {
  const questions = z.array(z.object({ id: questionIdSchema, text: z.string().trim().min(1).max(1000) }).strict()).length(3).parse(spec.questions);
  if (new Set(questions.map(question => question.id)).size !== 3) throw new Error('PLAN_QUESTIONS_MISMATCH');
  const nodes: PlanNode[] = [{ id: 'prepare-facts', questionId: null, kind: 'prepare', title: '准备两期资料和可取得的财务事实',
    dependsOn: [], allowedTools: [...financialPlanToolsByKind.prepare], completion: 'facts_prepared', budgetShare: 0.10, role: 'coordinator' }];
  const phases = [
    ['retrieve', '检索两期证据', 0.15], ['compare', '核对事实与变化', 0.05],
    ['verify', '核验结论', 0.07], ['report', '交付结论和缺口', 0.03],
  ] as const;
  for (const question of questions) for (const [index, [kind, label, budgetShare]] of phases.entries()) {
    const suffix = ` · ${label}`;
    nodes.push({ id: `${question.id}-${kind}`, questionId: question.id, kind, title: `${question.text.slice(0, 300 - suffix.length)}${suffix}`,
      dependsOn: index === 0 ? question.id === 'risks' ? [] : ['prepare-facts'] : [`${question.id}-${phases[index - 1][0]}`],
      allowedTools: [...financialPlanToolsByKind[kind]], completion: financialPlanCompletionByKind[kind], budgetShare,
      role: kind === 'report' ? 'coordinator' : question.id });
  }
  return validatePlanGraph({ schemaVersion: 2, taskId: metadata.taskId, requestRevision: spec.requestRevision,
    revision: metadata.revision ?? 1, createdAt: metadata.createdAt, nodes, steps: compatibilitySteps(nodes) });
}

/** Reject malformed, cyclic, dangling or duplicate graphs before any scheduling. */
export function validatePlanGraph(plan: unknown): ResearchPlanV2 { return researchPlanV2Schema.parse(plan); }

export function readyNodes(input: ResearchPlanV2, states: PlanNodeStates): PlanNode[] {
  const plan = validatePlanGraph(input), parsedStates = z.record(nodeIdSchema, planNodeStateSchema).parse(states);
  const ids = new Set(plan.nodes.map(node => node.id));
  if (Object.keys(parsedStates).length > 40 || Object.keys(parsedStates).some(id => !ids.has(id))) throw new Error('PLAN_NODE_STATE_UNKNOWN');
  const stateOf = (id: string) => Object.hasOwn(parsedStates, id) ? parsedStates[id] : 'pending';
  return plan.nodes.filter(node => ['pending', 'ready'].includes(stateOf(node.id)) && node.dependsOn.every(id => stateOf(id) === 'completed'));
}

function affectedNodes(plan: ResearchPlanV2, seeds: ReadonlySet<string>): Set<string> {
  const affected = new Set(seeds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of plan.nodes) if (!affected.has(node.id) && node.dependsOn.some(id => affected.has(id))) {
      affected.add(node.id); expanded = true;
    }
  }
  return affected;
}

/** Includes the changed node itself; ordering follows the public plan. */
export function invalidateDownstream(input: ResearchPlanV2, nodeId: string): string[] {
  const plan = validatePlanGraph(input);
  if (!plan.nodes.some(node => node.id === nodeId)) throw new Error('PLAN_NODE_NOT_FOUND');
  const affected = affectedNodes(plan, new Set([nodeId]));
  return plan.nodes.filter(node => affected.has(node.id)).map(node => node.id);
}

const planRevisionChangeSchema = z.object({
  nodes: z.array(planNodeSchema).min(1).max(40).optional(), changedNodeIds: z.array(nodeIdSchema).min(1).max(40).optional(),
  requestRevision: revisionSchema.optional(), createdAt: z.iso.datetime({ offset: true }).optional(),
}).strict().refine(change => change.nodes !== undefined || change.changedNodeIds !== undefined || change.requestRevision !== undefined, 'A plan change is required');
export type PlanRevisionChange = z.infer<typeof planRevisionChangeSchema>;

function nodeSignature(node: PlanNode) {
  return JSON.stringify({ ...node, dependsOn: [...node.dependsOn].sort(), allowedTools: [...node.allowedTools].sort() });
}

/** Replacing a subgraph invalidates its descendants in both the old and new DAG. */
export function revisePlan(input: ResearchPlanV2, change: PlanRevisionChange): { plan: ResearchPlanV2; retained: string[]; invalidated: string[] } {
  const original = validatePlanGraph(input), parsedChange = planRevisionChangeSchema.parse(change);
  const requestRevision = parsedChange.requestRevision ?? original.requestRevision;
  if (requestRevision < original.requestRevision) throw new Error('PLAN_REQUEST_REVISION_REGRESSION');
  const nodes = parsedChange.nodes ?? original.nodes;
  const candidate = validatePlanGraph({ ...original, revision: original.revision + 1, requestRevision,
    createdAt: parsedChange.createdAt ?? original.createdAt, nodes, steps: compatibilitySteps(nodes) });
  const oldById = new Map(original.nodes.map(node => [node.id, node])), newById = new Map(candidate.nodes.map(node => [node.id, node]));
  const seeds = new Set(parsedChange.changedNodeIds ?? []);
  if (seeds.size !== (parsedChange.changedNodeIds?.length ?? 0)) throw new Error('PLAN_DUPLICATE_CHANGED_NODE');
  if ([...seeds].some(id => !oldById.has(id) && !newById.has(id))) throw new Error('PLAN_NODE_NOT_FOUND');
  for (const node of original.nodes) if (!newById.has(node.id) || nodeSignature(node) !== nodeSignature(newById.get(node.id)!)) seeds.add(node.id);
  for (const node of candidate.nodes) if (!oldById.has(node.id)) seeds.add(node.id);
  // A changed request with no declared local effect must conservatively re-evaluate all nodes.
  if (requestRevision !== original.requestRevision && seeds.size === 0) for (const node of original.nodes) seeds.add(node.id);
  if (seeds.size === 0) return { plan: original, retained: original.nodes.map(node => node.id), invalidated: [] };
  const invalid = new Set([...affectedNodes(original, seeds), ...affectedNodes(candidate, seeds)]);
  const allIds = new Set([...original.nodes.map(node => node.id), ...candidate.nodes.map(node => node.id)]);
  return { plan: candidate, retained: candidate.nodes.filter(node => oldById.has(node.id) && !invalid.has(node.id)).map(node => node.id),
    invalidated: [...allIds].filter(id => invalid.has(id)) };
}
