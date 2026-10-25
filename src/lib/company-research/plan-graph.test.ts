import { describe, expect, it } from 'vitest';
import { initialFinancialPlan } from './execution-contracts';
import { assertPlanForSpec, researchPlanSchema, type ResearchPlanV1 } from './task-contracts';
import { specFixture } from './version-test-fixtures';
import { buildFinancialPlanV2, financialPlanToolsByKind, invalidateDownstream, planNodeStateSchema, readyNodes,
  revisePlan, validatePlanGraph, type PlanNodeState, type PlanNodeStates } from './plan-graph';

const metadata = { taskId: '00000000-0000-4000-8000-000000000001', createdAt: '2026-10-25T06:00:00Z' };
const build = () => buildFinancialPlanV2(specFixture(), metadata);

describe('financial research plan graph contracts', () => {
  it('builds a deterministic bounded DAG and preserves the legacy steps view', () => {
    const spec = specFixture(), plan = buildFinancialPlanV2(spec, { ...metadata, revision: 3 });
    expect(plan).toEqual(buildFinancialPlanV2(spec, { ...metadata, revision: 3 }));
    expect(plan).toMatchObject({ schemaVersion: 2, requestRevision: 1, revision: 3, ...metadata });
    expect(plan.nodes).toHaveLength(13);
    expect(plan.steps).toEqual(initialFinancialPlan(metadata.taskId, spec).steps);
    expect(plan.nodes.reduce((sum, node) => sum + node.budgetShare, 0)).toBeCloseTo(1);
    expect(researchPlanSchema.parse(plan)).toEqual(plan);
    expect(() => assertPlanForSpec(plan, spec)).not.toThrow();
    expect(() => assertPlanForSpec({ ...plan, requestRevision: 2 }, spec)).toThrow('PLAN_REQUEST_MISMATCH');
    for (const node of plan.nodes) expect(node.allowedTools).toEqual(financialPlanToolsByKind[node.kind]);
    expect(plan.nodes.find(node => node.id === 'prepare-facts')).toMatchObject({ questionId: null, role: 'coordinator', completion: 'facts_prepared' });
  });

  it('keeps the original v1 schema, strictness and default plan behavior', () => {
    const legacy = initialFinancialPlan(metadata.taskId, specFixture());
    expect(legacy.schemaVersion).toBe(1);
    expect(researchPlanSchema.parse(legacy)).toEqual(legacy);
    // Both branches expose the exact legacy question/kind types to existing callers.
    const steps: ResearchPlanV1['steps'] = researchPlanSchema.parse(build()).steps;
    expect(steps).toHaveLength(12);
    expect(researchPlanSchema.safeParse({ ...legacy, nodes: [] }).success).toBe(false);
    expect(researchPlanSchema.safeParse({ ...legacy, steps: [legacy.steps[0], legacy.steps[0]] }).success).toBe(false);
    expect(researchPlanSchema.safeParse({ ...legacy, schemaVersion: 3 }).success).toBe(false);
  });

  it('rejects cycles, self-dependencies, dangling references and duplicate IDs', () => {
    const plan = build();
    const alter = (id: string, dependsOn: string[]) => ({ ...plan, nodes: plan.nodes.map(node => node.id === id ? { ...node, dependsOn } : node) });
    expect(() => validatePlanGraph(alter('prepare-facts', ['income_profit-compare']))).toThrow('cycle');
    expect(() => validatePlanGraph(alter('prepare-facts', ['prepare-facts']))).toThrow('cycle');
    expect(() => validatePlanGraph(alter('cash_flow-retrieve', ['missing-node']))).toThrow('Dangling');
    expect(() => validatePlanGraph(alter('cash_flow-retrieve', ['prepare-facts', 'prepare-facts']))).toThrow('Duplicate plan dependencies');
    expect(() => validatePlanGraph({ ...plan, nodes: [...plan.nodes, plan.nodes[0]] })).toThrow('Duplicate plan node IDs');
    expect(researchPlanSchema.safeParse(alter('cash_flow-retrieve', ['missing-node'])).success).toBe(false);
  });

  it('rejects invalid tools, completion rules, roles, budgets and legacy projections', () => {
    const plan = build();
    const replace = (patch: object) => ({ ...plan, nodes: plan.nodes.map(node => node.id === 'risks-retrieve' ? { ...node, ...patch } : node) });
    expect(() => validatePlanGraph(replace({ allowedTools: ['execute_sql'] }))).toThrow();
    expect(() => validatePlanGraph(replace({ allowedTools: ['record_claim'] }))).toThrow('Tool not allowed');
    expect(() => validatePlanGraph(replace({ allowedTools: ['read_evidence', 'read_evidence'] }))).toThrow('Duplicate allowed tools');
    expect(() => validatePlanGraph(replace({ completion: 'report_submitted' }))).toThrow('Completion rule');
    expect(() => validatePlanGraph(replace({ role: 'income_profit' }))).toThrow('role/question');
    expect(() => validatePlanGraph(replace({ budgetShare: Number.NaN }))).toThrow();
    expect(() => validatePlanGraph(replace({ budgetShare: 1 }))).toThrow('budget shares');
    expect(() => validatePlanGraph({ ...plan, nodes: plan.nodes.map(node => ({ ...node, budgetShare: 0 })) })).toThrow('budget shares');
    expect(() => validatePlanGraph({ ...plan, steps: plan.steps.slice(1) })).toThrow('projection');
    expect(() => validatePlanGraph({ ...plan, steps: plan.steps.map(step => ({ ...step, title: '陈旧的计划视图' })) })).toThrow('projection');
    expect(() => validatePlanGraph({ ...plan, states: {} })).toThrow();
  });

  it('allows independent risk research while financial preparation is incomplete', () => {
    const plan = build();
    expect(readyNodes(plan, {}).map(node => node.id)).toEqual(['prepare-facts', 'risks-retrieve']);
    expect(readyNodes(plan, { 'prepare-facts': 'partial', 'risks-retrieve': 'completed' }).map(node => node.id)).toEqual(['risks-compare']);
    expect(readyNodes(plan, { 'prepare-facts': 'completed' }).map(node => node.id)).toEqual(['income_profit-retrieve', 'cash_flow-retrieve', 'risks-retrieve']);
    expect(invalidateDownstream(plan, 'prepare-facts')).not.toContain('risks-retrieve');
    for (const dependency of ['prepare-facts', 'income_profit-retrieve']) {
      expect(() => validatePlanGraph({ ...plan, nodes: plan.nodes.map(node => node.id === 'risks-retrieve' ? { ...node, dependsOn: [dependency] } : node) })).toThrow('Risk research cannot depend');
    }
  });

  it('only schedules pending or ready nodes whose dependencies are completed', () => {
    const plan = build();
    const statuses: PlanNodeState[] = ['pending', 'ready', 'running', 'waiting_input', 'completed', 'partial', 'failed', 'cancelled'];
    for (const status of statuses) {
      expect(planNodeStateSchema.parse(status)).toBe(status);
      const ids = readyNodes(plan, { 'prepare-facts': 'completed', 'income_profit-retrieve': status }).map(node => node.id);
      expect(ids.includes('income_profit-retrieve')).toBe(status === 'pending' || status === 'ready');
      expect(ids.includes('income_profit-compare')).toBe(status === 'completed');
    }
    expect(() => readyNodes(plan, { unknown: 'completed' })).toThrow('PLAN_NODE_STATE_UNKNOWN');
    expect(() => readyNodes(plan, { 'prepare-facts': 'unsupported' } as unknown as PlanNodeStates)).toThrow();
    expect(() => readyNodes(plan, { 'prepare-facts': 'completed' })).not.toThrow();
  });

  it('invalidates only a changed node and its transitive descendants', () => {
    const plan = build(), before = JSON.stringify(plan);
    expect(invalidateDownstream(plan, 'cash_flow-compare')).toEqual(['cash_flow-compare', 'cash_flow-verify', 'cash_flow-report']);
    expect(invalidateDownstream(plan, 'risks-report')).toEqual(['risks-report']);
    expect(invalidateDownstream(plan, 'prepare-facts')).toEqual(plan.nodes.filter(node => node.id === 'prepare-facts' || node.questionId === 'income_profit' || node.questionId === 'cash_flow').map(node => node.id));
    expect(() => invalidateDownstream(plan, 'unknown')).toThrow('PLAN_NODE_NOT_FOUND');
    expect(JSON.stringify(plan)).toBe(before);
  });

  it('retains unrelated completed nodes through a local request revision', () => {
    const original = build(), originalJson = JSON.stringify(original);
    const completed: PlanNodeStates = Object.fromEntries(original.nodes.map(node => [node.id, 'completed']));
    const revised = revisePlan(original, { changedNodeIds: ['cash_flow-compare'], requestRevision: 2, createdAt: '2026-10-25T07:00:00Z' });
    expect(revised.plan).toMatchObject({ revision: 2, requestRevision: 2, createdAt: '2026-10-25T07:00:00Z' });
    expect(revised.invalidated).toEqual(['cash_flow-compare', 'cash_flow-verify', 'cash_flow-report']);
    expect(revised.retained).toContain('income_profit-verify');
    expect(revised.retained).toContain('risks-report');
    const states = Object.fromEntries(revised.plan.nodes.map(node => [node.id, revised.retained.includes(node.id) ? completed[node.id] : 'pending'])) as PlanNodeStates;
    expect(states['income_profit-verify']).toBe('completed');
    expect(readyNodes(revised.plan, states).map(node => node.id)).toEqual(['cash_flow-compare']);
    expect(JSON.stringify(original)).toBe(originalJson);
    expect(completed['cash_flow-compare']).toBe('completed');
  });

  it('detects node changes automatically and rebuilds the compatibility view', () => {
    const original = build();
    const nodes = original.nodes.map(node => node.id === 'risks-compare' ? { ...node, title: '聚焦原文披露的风险变化' } : node);
    const revised = revisePlan(original, { nodes });
    expect(revised.invalidated).toEqual(['risks-compare', 'risks-verify', 'risks-report']);
    expect(revised.plan.steps.find(step => step.id === 'risks-compare')?.title).toBe('聚焦原文披露的风险变化');
    expect(revised.retained).toContain('cash_flow-verify');
    expect(researchPlanSchema.parse(revised.plan)).toEqual(revised.plan);
  });

  it('tracks additions, removals and rewiring against both graph versions', () => {
    const original = build();
    const removeReport = original.nodes.filter(node => node.id !== 'cash_flow-report');
    const removed = revisePlan(original, { nodes: removeReport });
    expect(removed.invalidated).toEqual(['cash_flow-report']);
    expect(removed.plan.steps.some(step => step.id === 'cash_flow-report')).toBe(false);
    const added = revisePlan(removed.plan, { nodes: original.nodes });
    expect(added.invalidated).toEqual(['cash_flow-report']);
    expect(added.retained).not.toContain('cash_flow-report');
    const rewired = revisePlan(original, { nodes: original.nodes.map(node => node.id === 'cash_flow-verify'
      ? { ...node, dependsOn: ['income_profit-compare'] } : node), changedNodeIds: ['income_profit-compare'] });
    expect(rewired.invalidated).toEqual(['income_profit-compare', 'income_profit-verify', 'income_profit-report', 'cash_flow-verify', 'cash_flow-report']);
    expect(rewired.retained).toContain('cash_flow-compare');
  });

  it('keeps no-op revisions stable and rejects invalid changes', () => {
    const original = build();
    expect(revisePlan(original, { nodes: original.nodes })).toEqual({ plan: original, retained: original.nodes.map(node => node.id), invalidated: [] });
    expect(revisePlan(original, { requestRevision: 2 }).invalidated).toHaveLength(13);
    expect(() => revisePlan(original, {})).toThrow('A plan change');
    expect(() => revisePlan(original, { changedNodeIds: ['unknown'] })).toThrow('PLAN_NODE_NOT_FOUND');
    expect(() => revisePlan(original, { changedNodeIds: ['risks-compare', 'risks-compare'] })).toThrow('PLAN_DUPLICATE_CHANGED_NODE');
    expect(() => revisePlan({ ...original, requestRevision: 2 }, { requestRevision: 1 })).toThrow('PLAN_REQUEST_REVISION_REGRESSION');
    expect(() => revisePlan(original, { nodes: original.nodes.filter(node => node.id !== 'prepare-facts') })).toThrow('Dangling');
  });

  it('bounds public text and rejects malformed builder metadata and questions', () => {
    const spec = specFixture(), long = { ...spec, questions: spec.questions.map(question => ({ ...question, text: '问'.repeat(1000) })) };
    expect(buildFinancialPlanV2(long, metadata).steps.every(step => step.title.length === 300)).toBe(true);
    expect(() => buildFinancialPlanV2(spec, { ...metadata, taskId: 'unbound' })).toThrow();
    expect(() => buildFinancialPlanV2(spec, { ...metadata, createdAt: 'yesterday' })).toThrow();
    expect(() => buildFinancialPlanV2({ ...spec, questions: [spec.questions[0], spec.questions[0], spec.questions[2]] }, metadata)).toThrow('PLAN_QUESTIONS_MISMATCH');
  });
});
