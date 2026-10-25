import { describe, expect, it } from 'vitest';
import { FinancialScheduler, upgradeFinancialCheckpoint } from './financial-scheduler';
import { buildFinancialPlanV2 } from './plan-graph';
import { checkpointSchema, emptyCheckpoint, rebindFinancialCheckpoint, type ResearchCheckpointV2 } from './execution-contracts';
import { claimReviewHash, type SemanticReview } from './claim-verification';
import { comparisonCompletion, disclosedResearchFact, projectFinancialWrite } from './financial-material';
import { reportFixture, specFixture } from './version-test-fixtures';

const spec = specFixture(), taskId = '00000000-0000-4000-8000-000000000001', createdAt = '2026-10-25T09:00:00Z';
const citation = reportFixture(taskId).claims[0].citations[0];
const claim = (id = 'income', questionId: 'income_profit' | 'cash_flow' | 'risks' = 'income_profit') => ({
  ...reportFixture(taskId).claims[0], id, questionId, factIds: [],
});
const factInput = (periodId = spec.periods[0].id, metric: 'revenue' | 'parent_net_profit' = 'revenue') => ({ periodId, metric, rawText: '100.00', unitLabel: '元', citations: [citation] });
const receipt = (state: ResearchCheckpointV2, id: string): SemanticReview => ({ version: 'claim-review-v1',
  claimHash: claimReviewHash({ taskId, requestRevision: state.requestRevision, planRevision: state.planRevision, asOf: spec.asOf, facts: state.facts }, state.claims.find(c => c.id === id)!),
  verdict: 'supported', reason: 'Synthetic regression receipt', method: 'human', independence: 'human', reviewer: 'fixture', calibration: 'fixture', reviewedAt: createdAt });
function setup(variant: 'B' | 'B2' = 'B') {
  const state = upgradeFinancialCheckpoint(emptyCheckpoint(1, 1), buildFinancialPlanV2(spec, { taskId, createdAt }), []);
  state.variant = variant;
  if (variant === 'B2') state.maxToolCallsPerTurn = 3;
  for (const id of Object.keys(state.nodes)) state.nodes[id] = id.endsWith('-report') ? 'pending' : 'partial';
  state.nodes['income_profit-retrieve'] = 'completed'; state.nodes['income_profit-compare'] = 'pending';
  return { state, scheduler: new FinancialScheduler({ taskId, spec, state, createdAt, reviews: [] }) };
}
function write(scheduler: FinancialScheduler, tool: string, input: unknown, remaining: number) {
  expect(scheduler.admit(tool, input, remaining)).toBeNull(); scheduler.started();
  const next = projectFinancialWrite(spec, scheduler.state, tool, input);
  scheduler.state.facts = next.facts; scheduler.state.claims = next.claims;
  return scheduler.observe(tool, input, { ok: true, data: {} }, remaining - 1);
}

describe.each(['B', 'B2'] as const)('%s review regressions', variant => {
  it('reopens closure on a submitted partial retry while retaining stopped repair and configuration', () => {
    const { state, scheduler } = setup(variant);
    for (let n = 0; n < 4; n++) write(scheduler, 'search_evidence', { query: `miss-${n}` }, 40 - n);
    for (const id of Object.keys(state.nodes)) state.nodes[id] = id.endsWith('-report') ? 'completed' : 'partial';
    state.claims = spec.questions.map(q => ({ ...claim(q.id, q.id), status: 'evidence_gap', reason: 'No evidence', citations: [] }));
    state.submitted = true; state.checkedHash = 'a'.repeat(64); state.modelTurns = 9;
    state.steps['income_profit-report'] = 'completed';
    const retry = rebindFinancialCheckpoint(checkpointSchema.parse(state), emptyCheckpoint(1, 2), true);
    expect(retry).toMatchObject({ schemaVersion: 2, variant, modelTurns: 9, gaps: state.gaps, nodeToolCalls: state.nodeToolCalls,
      steps: { 'income_profit-report': 'pending' } });
    if (retry.schemaVersion !== 2) throw new Error('Expected v2');
    if (variant === 'B2') expect(retry.maxToolCallsPerTurn).toBe(3);
    const resumed = new FinancialScheduler({ taskId, spec, state: retry, createdAt, reviews: [] });
    expect(resumed.nextAction(20)?.kind).toBe('report');
    expect(resumed.admit('search_evidence', { query: 'must not restart the stopped repair' }, 20)?.ok).toBe(false);
    write(resumed, 'check_coverage', {}, 20); retry.checkedHash = 'a'.repeat(64);
    expect(resumed.admit('submit_report', {}, 19)).toBeNull(); resumed.started(); retry.submitted = true;
    resumed.observe('submit_report', {}, { ok: true, data: { saved: true } }, 18);
    expect(retry.gaps).toEqual(state.gaps); expect(resumed.nextAction(18)).toBeNull();
  });

  it('persists a first claim, then amounts and a second claim before explicitly completing comparison', () => {
    const { scheduler, state } = setup(variant);
    write(scheduler, 'record_claim', claim('revenue'), 40);
    expect(state.nodes['income_profit-compare']).toBe('pending');
    expect(comparisonCompletion(spec, state, 'income_profit').status).toBe('incomplete');
    const parsed = checkpointSchema.parse(state); if (parsed.schemaVersion !== 2) throw new Error('Expected v2');
    const resumed = new FinancialScheduler({ taskId, spec, state: parsed, createdAt, reviews: [] });
    let remaining = 39;
    for (const period of spec.periods) for (const metric of ['revenue', 'parent_net_profit'] as const) write(resumed, 'record_fact', factInput(period.id, metric), remaining--);
    write(resumed, 'record_claim', claim('profit'), remaining--);
    expect(parsed.claims.map(c => c.id)).toEqual(['revenue', 'profit']); expect(parsed.facts).toHaveLength(4);
    expect(resumed.nextAction(remaining)?.kind).toBe('compare');
    expect(resumed.admit('complete_comparison', { questionId: 'risks' }, remaining)?.ok).toBe(false);
    write(resumed, 'complete_comparison', { questionId: 'income_profit' }, remaining--);
    for (const id of ['revenue', 'profit']) {
      expect(resumed.nextAction(remaining)?.claimId).toBe(id);
      expect(resumed.admit('verify_claim', { claimId: id }, remaining)).toBeNull(); resumed.started();
      resumed.observe('verify_claim', { claimId: id }, { ok: true, data: receipt(parsed, id) }, --remaining);
    }
    expect(parsed.nodes['income_profit-verify']).toBe('completed'); expect(resumed.nextAction(remaining)?.kind).toBe('report');
  });

  it('can close a missing-amount question with an explicit gap without blocking other work', () => {
    const { state, scheduler } = setup(variant);
    write(scheduler, 'record_claim', { ...claim(), status: 'evidence_gap', reason: 'Amounts not found', citations: [] }, 40);
    write(scheduler, 'complete_comparison', { questionId: 'income_profit' }, 39);
    expect(state.nodes['income_profit-compare']).toBe('partial'); expect(scheduler.nextAction(38)?.kind).toBe('report');
  });

  it('rejects a new supported claim at three remaining calls, then permits gap and successful closure', () => {
    const { state, scheduler } = setup(variant), before = structuredClone(state);
    expect(scheduler.admit('record_claim', claim(), 3)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_WRITE_RESERVE' } });
    expect(state.facts).toEqual(before.facts); expect(state.claims).toEqual(before.claims); expect(state.nodeToolCalls).toEqual({});
    write(scheduler, 'record_claim', { ...claim(), status: 'evidence_gap', reason: 'Insufficient verification budget', citations: [] }, 3);
    expect(scheduler.nextAction(2)?.kind).toBe('report');
    write(scheduler, 'check_coverage', {}, 2); state.checkedHash = 'a'.repeat(64);
    expect(scheduler.admit('submit_report', {}, 1)).toBeNull(); scheduler.started(); state.submitted = true;
    scheduler.observe('submit_report', {}, { ok: true, data: {} }, 0);
    expect(state.submitted).toBe(true);
  });

  it('accepts the exact four-call boundary and preserves enough for review, coverage and submission', () => {
    const { state, scheduler } = setup(variant);
    write(scheduler, 'record_claim', claim(), 4);
    expect(scheduler.nextAction(3)).toMatchObject({ kind: 'verify', claimId: 'income' });
    expect(scheduler.admit('verify_claim', { claimId: 'income' }, 3)).toBeNull(); scheduler.started();
    scheduler.observe('verify_claim', { claimId: 'income' }, { ok: true, data: receipt(state, 'income') }, 2);
    write(scheduler, 'check_coverage', {}, 2); state.checkedHash = 'a'.repeat(64);
    expect(scheduler.admit('submit_report', {}, 1)).toBeNull();
  });
});

it('preflights the whole batch against the final write obligation without touching real state', () => {
  const { state, scheduler } = setup('B2'), before = structuredClone(state);
  const calls = [{ id: 'read', name: 'read_evidence', input: {} }, { id: 'write', name: 'record_claim', input: claim() }];
  expect(scheduler.preflightBatch(calls, 4)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_WRITE_RESERVE' } });
  expect(scheduler.preflightBatch(calls, 5)).toBeNull(); expect(state).toEqual(before);
});

it('leaves derived fact validation errors to the tool instead of aborting admission', () => {
  const { state } = setup(), longPeriod = 'p'.repeat(100);
  const longSpec: typeof spec = { ...spec, periods: [{ ...spec.periods[0], id: longPeriod }, spec.periods[1]] };
  expect(() => disclosedResearchFact(longSpec, factInput(longPeriod))).toThrow();
  expect(projectFinancialWrite(longSpec, state, 'record_fact', factInput(longPeriod))).toBe(state);
});

it('reserves re-review of every claim invalidated by a changed fact, but accepts an identical write', () => {
  const { state } = setup(), input = factInput(), fact = disclosedResearchFact(spec, input);
  state.facts = [fact]; state.claims = ['first', 'second'].map(id => ({ ...claim(id), factIds: [fact.id] }));
  const reviews = state.claims.map(c => receipt(state, c.id));
  const scheduler = new FinancialScheduler({ taskId, spec, state, createdAt, reviews });
  const changed = { ...input, citations: [{ ...citation, quote: 'different verified original context' }] };
  expect(scheduler.admit('record_fact', changed, 3)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_WRITE_RESERVE' } });
  expect(scheduler.admit('record_fact', changed, 4)?.ok).toBe(false);
  expect(scheduler.admit('record_fact', changed, 5)).toBeNull();
  expect(scheduler.admit('record_fact', input, 3)).toBeNull();
  expect(state.facts).toEqual([fact]); expect(state.nodeToolCalls).toEqual({});
});

it('reopens only an incomplete legacy comparison at coverage, preserving unrelated reviewed questions', () => {
  const { state } = setup();
  state.claims = [claim(), claim('risk', 'risks')];
  state.nodes['income_profit-compare'] = 'completed'; state.nodes['risks-compare'] = 'completed';
  const scheduler = new FinancialScheduler({ taskId, spec, state, createdAt, reviews: state.claims.map(c => receipt(state, c.id)) });
  expect(scheduler.nextAction(20)?.kind).toBe('report');
  const revision = write(scheduler, 'check_coverage', {}, 20);
  expect(revision?.affectedNodeIds).toEqual(['income_profit-compare', 'income_profit-verify', 'income_profit-report']);
  expect(state.nodes['risks-verify']).toBe('completed'); expect(scheduler.nextAction(19)?.nodeId).toBe('income_profit-compare');
});
