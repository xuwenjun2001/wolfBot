import { describe, expect, it } from 'vitest';
import type { PiAgentToolResult } from '@/lib/agent/types';
import { buildFinancialPlanV2 } from './plan-graph';
import { FinancialScheduler, upgradeFinancialCheckpoint } from './financial-scheduler';
import { checkpointSchema, emptyCheckpoint, rebindFinancialCheckpoint, type ResearchCheckpoint } from './execution-contracts';
import { claimReviewHash, type SemanticReview } from './claim-verification';
import { reportFixture, specFixture } from './version-test-fixtures';
import { financialContextState } from './financial-observation';

const taskId = '00000000-0000-4000-8000-000000000001', createdAt = '2026-10-25T07:00:00Z', spec = specFixture();
const documents = spec.periods.map((period, index) => ({ id: `annual-${index}`, version: 1, period }));
const plan = () => buildFinancialPlanV2(spec, { taskId, createdAt });
const claim = (questionId: 'income_profit' | 'cash_flow' | 'risks', id: string = questionId) => ({ ...reportFixture(taskId).claims[0], id, questionId, factIds: [] });
function receipt(state: Pick<ResearchCheckpoint, 'requestRevision' | 'planRevision' | 'facts' | 'claims'>, id: string, verdict: SemanticReview['verdict'] = 'supported'): SemanticReview {
  return { version: 'claim-review-v1', claimHash: claimReviewHash({ taskId, requestRevision: state.requestRevision, planRevision: state.planRevision, asOf: spec.asOf, facts: state.facts }, state.claims.find(claim => claim.id === id)!),
    verdict, reason: '合成协议测试，不能作为真实财报语义验收', method: 'human', reviewer: 'fixture', independence: 'human', calibration: 'fixture', reviewedAt: createdAt };
}
function setup(legacy = emptyCheckpoint(1, 1), reviews: SemanticReview[] = []) {
  const state = upgradeFinancialCheckpoint(legacy, plan(), documents);
  const scheduler = new FinancialScheduler({ taskId, spec, state, createdAt, reviews });
  const invoke = (tool: string, input: unknown, result: PiAgentToolResult, remaining = 40) => {
    expect(scheduler.admit(tool, input, remaining)).toBeNull(); scheduler.started();
    return scheduler.observe(tool, input, result, remaining - 1);
  };
  return { state, scheduler, invoke };
}
const hit = { sourceId: 'annual-0', documentVersion: 1, bytesSha256: 'a'.repeat(64), periodId: 'fy2023', locator: { kind: 'page', filePage: 5 }, snippet: '本期原文金额' };

describe('financial checkpoint v2 and revisions', () => {
  it('upgrades materialized v1 drafts without trusting question-level verification flags', () => {
    const legacy = emptyCheckpoint(1, 1); legacy.facts = reportFixture(taskId).facts; legacy.claims = [claim('cash_flow')]; legacy.steps['cash_flow-verify'] = 'completed'; legacy.modelTurns = 7;
    const before = structuredClone(legacy), { state, scheduler } = setup(legacy);
    expect(state).toMatchObject({ schemaVersion: 2, variant: 'B', requestRevision: 1, planRevision: 1, planVersion: 1, modelTurns: 7 });
    expect(state.facts).toEqual(legacy.facts); expect(state.claims).toEqual(legacy.claims);
    expect(state.nodes['cash_flow-verify']).toBe('pending');
    expect(state.closureReserve).toBe(3); expect(scheduler.nextAction(3)?.claimId).toBe('cash_flow');
    expect(legacy).toEqual(before); expect(checkpointSchema.parse(emptyCheckpoint(1, 1))).toEqual(emptyCheckpoint(1, 1));
    expect(checkpointSchema.parse(state)).toEqual(state);
  });
  it('rebinds variant/model turns and either resets local work or preserves a retry ledger', () => {
    const { state, invoke } = setup(); invoke('search_evidence', { query: '收入' }, { ok: true, data: { hits: [] } }); state.modelTurns = 9;
    const base = emptyCheckpoint(2, 3), reset = rebindFinancialCheckpoint(state, base);
    expect(reset).toMatchObject({ schemaVersion: 2, variant: 'B', modelTurns: 9, requestRevision: 2, planRevision: 3, planVersion: 3, gaps: [], nodeToolCalls: {}, facts: [] });
    if (reset.schemaVersion !== 2) throw new Error('Expected v2');
    expect(Object.values(reset.nodes).every(status => status === 'pending')).toBe(true);
    state.submitted = true; state.stopReason = '旧停止'; state.checkedHash = 'b'.repeat(64); state.planVersion = 5;
    const retry = rebindFinancialCheckpoint(state, base, true);
    expect(retry).toMatchObject({ schemaVersion: 2, planVersion: 6, modelTurns: 9, submitted: false, stopReason: null, checkedHash: null, gaps: state.gaps, nodeToolCalls: state.nodeToolCalls });
    expect(rebindFinancialCheckpoint({ ...emptyCheckpoint(1, 1), modelTurns: 4 }, base)).toMatchObject({ schemaVersion: 1, modelTurns: 4 });
    const legacy = emptyCheckpoint(1, 1); legacy.claims = [claim('risks')]; legacy.stalledCalls = 4;
    expect(rebindFinancialCheckpoint(legacy, base, true)).toMatchObject({ schemaVersion: 1, claims: legacy.claims, stalledCalls: 0, requestRevision: 2, planRevision: 3 });
    base.steps = { 'risks-retrieve': 'completed', 'risks-compare': 'completed', 'risks-verify': 'pending' };
    expect(rebindFinancialCheckpoint(state, base)).toMatchObject({ schemaVersion: 2, nodes: { 'risks-retrieve': 'completed', 'risks-compare': 'completed', 'risks-verify': 'pending' } });
  });
  it('rejects unknown node identities, malformed state and invalid resolved gaps', () => {
    const { state } = setup();
    expect(() => upgradeFinancialCheckpoint({ ...state, nodes: { ...state.nodes, rogue: 'pending' } }, plan(), [])).toThrow('SCHEDULER_NODE_BINDING');
    expect(checkpointSchema.safeParse({ ...state, currentNodeId: 'rogue' }).success).toBe(false);
    expect(checkpointSchema.safeParse({ ...state, resolvedGapIds: ['a'.repeat(64)] }).success).toBe(false);
    expect(checkpointSchema.safeParse({ ...state, variant: 'C2' }).success).toBe(false);
    expect(checkpointSchema.safeParse({ ...state, planVersion: 0 }).success).toBe(false);
  });
});

describe('financial scheduler admission and closure', () => {
  it('binds mutations to the selected node before charging any call', () => {
    const { state, scheduler } = setup();
    expect(scheduler.nextAction(40)?.nodeId).toBe('income_profit-retrieve');
    expect(scheduler.admit('record_claim', claim('cash_flow'), 40)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_TOOL_NOT_ALLOWED' } });
    for (const id of ['income_profit-retrieve', 'cash_flow-retrieve', 'risks-retrieve']) state.nodes[id] = 'completed';
    expect(scheduler.nextAction(40)?.nodeId).toBe('income_profit-compare');
    expect(scheduler.admit('record_claim', claim('cash_flow'), 40)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_NODE_MISMATCH' } });
    expect(scheduler.admit('record_fact', { metric: 'operating_cash_flow' }, 40)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_NODE_MISMATCH' } });
    expect(scheduler.admit('record_claim', claim('income_profit'), 40)).toBeNull();
    expect(state.nodeToolCalls).toEqual({});
  });
  it('rejects another question reusing a reviewed claim id without changing its claim or receipt', () => {
    const legacy = emptyCheckpoint(1, 1); legacy.claims = [claim('income_profit', 'stable-income')];
    const review = receipt(legacy, 'stable-income'), { state, scheduler } = setup(legacy, [review]);
    for (const id of ['cash_flow-retrieve', 'risks-retrieve']) state.nodes[id] = 'completed';
    expect(scheduler.nextAction(40)?.nodeId).toBe('cash_flow-compare');
    expect(state.nodes['income_profit-verify']).toBe('completed');
    const saved = structuredClone(state.claims);
    expect(scheduler.admit('record_claim', claim('cash_flow', 'stable-income'), 40)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_NODE_MISMATCH' } });
    expect(state.claims).toEqual(saved); expect(scheduler.claimReviews).toEqual([review]);
    expect(state.nodes['income_profit-verify']).toBe('completed'); expect(state.nodeToolCalls).toEqual({});
    expect(scheduler.admit('record_claim', claim('cash_flow'), 40)).toBeNull();
  });
  it('reserves each current unreviewed claim even when a sibling claim and question are completed', () => {
    const legacy = emptyCheckpoint(1, 1); legacy.claims = [claim('cash_flow', 'first'), claim('cash_flow', 'second')]; legacy.steps['cash_flow-verify'] = 'completed';
    const first = receipt(legacy, 'first'), { state, scheduler, invoke } = setup(legacy, [first]);
    expect(state.closureReserve).toBe(3); expect(scheduler.nextAction(3)).toMatchObject({ nodeId: 'cash_flow-verify', claimId: 'second' });
    expect(scheduler.admit('search_evidence', { query: '新关键词' }, 3)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_CLOSURE_RESERVED' } });
    expect(scheduler.admit('verify_claim', { claimId: 'first' }, 3)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_NODE_MISMATCH' } });
    invoke('verify_claim', { claimId: 'second' }, { ok: true, data: receipt(legacy, 'second') }, 3);
    expect(state.nodes['cash_flow-verify']).toBe('completed'); expect(state.closureReserve).toBe(2);
    expect(scheduler.nextAction(2)?.kind).toBe('report');
    expect(scheduler.admit('submit_report', {}, 2)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_COVERAGE_REQUIRED' } });
    expect(scheduler.admit('check_coverage', {}, 2)).toBeNull();
    expect(scheduler.admit('submit_report', {}, 0)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_CLOSURE_RESERVED' } });
  });
  it('does not trust stale semantic receipts after referenced facts change', () => {
    const legacy = emptyCheckpoint(1, 1); legacy.facts = reportFixture(taskId).facts; legacy.claims = [{ ...claim('cash_flow'), factIds: [legacy.facts[0].id] }];
    const oldReview = receipt(legacy, 'cash_flow'); legacy.facts[0] = { ...legacy.facts[0], citations: legacy.facts[0].citations.map(citation => ({ ...citation, quote: '修订的来源金额' })) };
    const { state, scheduler } = setup(legacy, [oldReview]);
    expect(state.closureReserve).toBe(3); expect(scheduler.nextAction(3)?.claimId).toBe('cash_flow');
  });
});

describe('durable evidence gain and bounded repair', () => {
  it('distinguishes search snippets, real reads and new read chunks at the same locator', () => {
    const { state, invoke } = setup();
    invoke('search_evidence', { query: '收入' }, { ok: true, data: { hits: [hit] } });
    expect(state.gaps[0]).toMatchObject({ stalledAttempts: 0, attempts: 1 });
    invoke('search_evidence', { query: '换词但同页' }, { ok: true, data: { hits: [hit] } });
    expect(state.gaps[0]).toMatchObject({ stalledAttempts: 1, queryChanged: true, attempts: 2 });
    const read = { sourceId: hit.sourceId, documentVersion: hit.documentVersion, bytesSha256: hit.bytesSha256, locator: hit.locator, text: '真实读取的本期原文', offset: 0, nextOffset: 10, asOf: spec.asOf };
    invoke('read_evidence', { documentId: hit.sourceId }, { ok: true, data: read });
    expect(state.gaps[0].stalledAttempts).toBe(0);
    invoke('read_evidence', { documentId: hit.sourceId }, { ok: true, data: read });
    expect(state.gaps[0].stalledAttempts).toBe(1);
    invoke('read_evidence', { documentId: hit.sourceId, offset: 10 }, { ok: true, data: { ...read, offset: 10, text: '另一块真实原文' } });
    expect(state.gaps[0].stalledAttempts).toBe(0);
    expect(state.evidenceLedger['income_profit-retrieve'].locatorKeys).toHaveLength(1);
    expect(state.evidenceLedger['income_profit-retrieve'].evidenceHashes).toHaveLength(3);
    const view = financialContextState(state, true);
    expect(JSON.stringify(view)).not.toContain(state.evidenceLedger['income_profit-retrieve'].locatorKeys[0]);
  });
  it('retains the full evidence ledger and retry count through checkpoint compaction and resume', () => {
    const { state, invoke } = setup();
    invoke('search_evidence', { query: '第一次' }, { ok: true, data: { hits: [hit] } });
    state.observations = [];
    const parsed = checkpointSchema.parse(state); if (parsed.schemaVersion !== 2) throw new Error('Expected v2');
    const resumed = new FinancialScheduler({ taskId, spec, state: parsed, createdAt, reviews: [] });
    expect(resumed.admit('search_evidence', { query: '重新措辞' }, 39)).toBeNull(); resumed.started();
    resumed.observe('search_evidence', { query: '重新措辞' }, { ok: true, data: { hits: [hit] } }, 38);
    expect(parsed.gaps[0]).toMatchObject({ attempts: 2, stalledAttempts: 1, newLocatorKeys: [], newEvidenceHashes: [] });
  });
  it('finishes no-evidence search attempts as partial and continues the other questions', () => {
    const { state, scheduler, invoke } = setup();
    for (let index = 0; index < 4; index++) invoke('search_evidence', { query: `不同检索词${index}` }, { ok: true, data: { hits: [] } }, 40 - index);
    expect(state.gaps[0]).toMatchObject({ type: 'retrieval_miss', status: 'partial', stalledAttempts: 4, stopReason: 'no_new_evidence' });
    expect(state.nodes['income_profit-retrieve']).toBe('partial'); expect(scheduler.nextAction(36)?.nodeId).toBe('cash_flow-retrieve');
    expect(state.gaps.every(gap => gap.status !== 'not_disclosed')).toBe(true);
  });
  it('also bounds changed-query misses during compare and gives saved facts real progress', () => {
    const { state, scheduler, invoke } = setup();
    for (const id of ['income_profit-retrieve', 'cash_flow-retrieve', 'risks-retrieve']) state.nodes[id] = 'completed';
    invoke('search_evidence', { query: '比较补证1' }, { ok: true, data: { hits: [] } });
    invoke('search_evidence', { query: '比较补证2' }, { ok: true, data: { hits: [] } }, 39);
    expect(state.gaps[0].stalledAttempts).toBe(2);
    expect(scheduler.admit('record_fact', { metric: 'revenue' }, 38)).toBeNull(); scheduler.started();
    state.facts.push({ ...reportFixture(taskId).facts[0], metric: 'revenue' });
    scheduler.observe('record_fact', { metric: 'revenue' }, { ok: true, data: { saved: state.facts[0].id } }, 37);
    expect(state.gaps[0].stalledAttempts).toBe(0);
    for (let index = 0; index < 4; index++) {
      // Keep unrelated stages terminal to inspect this repair independently of soft-share yielding.
      for (const question of ['cash_flow', 'risks']) for (const kind of ['compare', 'verify']) state.nodes[`${question}-${kind}`] = 'partial';
      invoke('search_evidence', { query: `比较补证无增量${index}` }, { ok: true, data: { hits: [] } }, 37 - index);
    }
    expect(state.nodes['income_profit-compare']).toBe('partial'); expect(state.gaps[0]).toMatchObject({ stalledAttempts: 4, status: 'partial' });
  });
  it('bounds repeated no-progress reads during verify without promoting a review attempt to support', () => {
    const legacy = emptyCheckpoint(1, 1); legacy.claims = [claim('cash_flow')];
    const { state, scheduler, invoke } = setup(legacy);
    for (const question of ['income_profit', 'risks']) for (const kind of ['retrieve', 'compare', 'verify']) state.nodes[`${question}-${kind}`] = 'partial';
    expect(scheduler.nextAction(40)?.kind).toBe('verify');
    for (let index = 0; index < 4; index++) invoke('read_evidence', { documentId: 'annual-0' }, { ok: true, data: { sourceId: hit.sourceId, documentVersion: hit.documentVersion, bytesSha256: hit.bytesSha256, locator: hit.locator, text: '', offset: 0, nextOffset: null, asOf: spec.asOf } }, 40 - index);
    expect(state.nodes['cash_flow-verify']).toBe('partial'); expect(state.gaps[0]).toMatchObject({ stalledAttempts: 4, status: 'partial' });
    expect(scheduler.claimReviews).toHaveLength(0); expect(scheduler.nextAction(36)?.kind).toBe('report');
  });
  it('repairs only the failed question and preserves unrelated current verified claims', () => {
    const legacy = emptyCheckpoint(1, 1); legacy.claims = [claim('income_profit'), claim('cash_flow'), claim('risks')];
    const { state, scheduler, invoke } = setup(legacy, [receipt(legacy, 'income_profit'), receipt(legacy, 'risks')]);
    expect(scheduler.nextAction(40)?.claimId).toBe('cash_flow');
    const revision = invoke('verify_claim', { claimId: 'cash_flow' }, { ok: true, data: receipt(legacy, 'cash_flow', 'insufficient') });
    expect(revision).toMatchObject({ planVersion: 2, affectedNodeIds: ['cash_flow-retrieve', 'cash_flow-compare', 'cash_flow-verify', 'cash_flow-report'] });
    expect(revision?.retainedNodeIds).toContain('income_profit-verify'); expect(state.nodes['income_profit-verify']).toBe('completed'); expect(state.nodes['risks-verify']).toBe('completed');
    expect(scheduler.nextAction(39)).toMatchObject({ nodeId: 'cash_flow-retrieve', repair: { action: 'search_evidence' } });
    for (let index = 0; index < 3; index++) invoke('search_evidence', { query: `原因说明${index}` }, { ok: true, data: { hits: [] } }, 39 - index);
    const gap = state.gaps.find(gap => gap.subjectId === 'cash_flow');
    expect(gap).toMatchObject({ status: 'partial', stalledAttempts: 4, attempts: 4 });
    expect(scheduler.nextAction(36)?.nodeId).toBe('cash_flow-compare');
    state.claims = state.claims.map(claim => claim.id === 'cash_flow' ? { ...claim, status: 'evidence_gap', reason: '定向补查未获支持' } : claim);
    invoke('record_claim', state.claims.find(claim => claim.id === 'cash_flow'), { ok: true, data: { saved: 'cash_flow' } }, 36);
    invoke('complete_comparison', { questionId: 'cash_flow' }, { ok: true, data: {} }, 35);
    expect(scheduler.nextAction(34)?.kind).toBe('report'); expect(state.nodeToolCalls['income_profit-verify']).toBeUndefined(); expect(state.nodeToolCalls['risks-verify']).toBeUndefined();
    expect(state.gaps.every(gap => gap.status !== 'not_disclosed')).toBe(true);
  });
  it('does not reopen exhausted retrieval repair when only the claim text was rewritten', () => {
    const legacy = emptyCheckpoint(1, 1); legacy.claims = [claim('income_profit'), claim('cash_flow'), claim('risks')];
    legacy.facts = spec.periods.map(period => ({ ...reportFixture(taskId).facts[0], id: `${period.id}-operating_cash_flow`, period }));
    const { state, scheduler, invoke } = setup(legacy, [receipt(legacy, 'income_profit'), receipt(legacy, 'risks')]);
    invoke('verify_claim', { claimId: 'cash_flow' }, { ok: true, data: receipt(state, 'cash_flow', 'insufficient') });
    for (let index = 0; index < 3; index++) invoke('search_evidence', { query: `无新证据${index}` }, { ok: true, data: { hits: [] } }, 39 - index);
    expect(state.gaps.find(gap => gap.subjectId === 'cash_flow')).toMatchObject({ status: 'partial', attempts: 4, stalledAttempts: 4 });
    expect(scheduler.nextAction(36)?.nodeId).toBe('cash_flow-compare');
    const planVersion = state.planVersion, rewritten = { ...state.claims.find(claim => claim.id === 'cash_flow')!, text: '仅改写文字，原始证据保持不变' };
    expect(scheduler.admit('record_claim', rewritten, 36)).toBeNull(); scheduler.started();
    state.claims = state.claims.map(claim => claim.id === rewritten.id ? rewritten : claim);
    scheduler.observe('record_claim', rewritten, { ok: true, data: { saved: rewritten.id } }, 35);
    invoke('complete_comparison', { questionId: 'cash_flow' }, { ok: true, data: {} }, 35);
    expect(scheduler.nextAction(34)).toMatchObject({ nodeId: 'cash_flow-verify', claimId: 'cash_flow' });
    expect(invoke('verify_claim', { claimId: 'cash_flow' }, { ok: true, data: receipt(state, 'cash_flow', 'insufficient') }, 34)).toBeNull();
    expect(state.gaps.find(gap => gap.subjectId === 'cash_flow')).toMatchObject({ status: 'partial', attempts: 5, stalledAttempts: 5 });
    expect(state.planVersion).toBe(planVersion);
    expect(state.nodes).toMatchObject({ 'cash_flow-retrieve': 'partial', 'cash_flow-compare': 'completed', 'cash_flow-verify': 'partial', 'income_profit-verify': 'completed', 'risks-verify': 'completed' });
    expect(34).toBeGreaterThan(state.closureReserve); expect(scheduler.nextAction(34)?.kind).toBe('report');
    expect(scheduler.admit('search_evidence', { query: '不能再重开补查' }, 34)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_TOOL_NOT_ALLOWED' } });
  });
  it('keeps transient retry counters and local plan versions across recovery', () => {
    const { state, invoke } = setup();
    const error: PiAgentToolResult = { ok: false, error: { code: 'READ_TIMEOUT', message: '暂时超时' } };
    expect(invoke('search_evidence', { query: '收入' }, error)?.planVersion).toBe(2);
    const resumed = new FinancialScheduler({ taskId, spec, state, createdAt, reviews: [] });
    for (let index = 0; index < 2; index++) { expect(resumed.admit('search_evidence', { query: `收入${index}` }, 39 - index)).toBeNull(); resumed.started(); resumed.observe('search_evidence', { query: `收入${index}` }, error, 38 - index); }
    expect(state.gaps[0]).toMatchObject({ attempts: 3, status: 'partial' }); expect(state.planVersion).toBe(4);
    expect(state.nodeToolCalls['income_profit-retrieve']).toBe(3); expect(state.nodes['income_profit-retrieve']).toBe('partial');
  });
  it('allows the required six facts and three reviewed questions to finish beyond a node soft share', () => {
    const { state, scheduler, invoke } = setup(), template = reportFixture(taskId).facts[0];
    let remaining = 40, completed = false;
    for (let turn = 0; turn < 35; turn++) {
      const action = scheduler.nextAction(remaining); expect(action).not.toBeNull();
      if (!action) break;
      if (action.kind === 'retrieve') {
        const period = spec.periods.find(period => !state.nodeReadPeriods[action.nodeId]?.includes(period.id))!;
        const index = spec.periods.indexOf(period), read = { sourceId: `annual-${index}`, documentVersion: 1, bytesSha256: hit.bytesSha256, locator: hit.locator, text: `两期原文 ${period.id}`, offset: 0, nextOffset: null, asOf: spec.asOf };
        invoke('read_evidence', { documentId: read.sourceId }, { ok: true, data: read }, remaining--);
      } else if (action.kind === 'compare') {
        const metrics = action.questionId === 'income_profit' ? ['revenue', 'parent_net_profit'] : action.questionId === 'cash_flow' ? ['operating_cash_flow'] : [];
        const missing = spec.periods.flatMap(period => metrics.map(metric => ({ period, metric }))).find(target => !state.facts.some(fact => fact.period.id === target.period.id && fact.metric === target.metric));
        if (missing) {
          const fact = { ...template, id: `${missing.period.id}-${missing.metric}`, period: missing.period, metric: missing.metric as typeof template.metric };
          expect(scheduler.admit('record_fact', { metric: fact.metric }, remaining)).toBeNull(); scheduler.started(); state.facts.push(fact);
          scheduler.observe('record_fact', { metric: fact.metric }, { ok: true, data: { saved: fact.id } }, --remaining);
        } else if (!state.claims.some(c => c.questionId === action.questionId)) {
          const saved = claim(action.questionId!); expect(scheduler.admit('record_claim', saved, remaining)).toBeNull(); scheduler.started(); state.claims.push(saved);
          scheduler.observe('record_claim', saved, { ok: true, data: { saved: saved.id } }, --remaining);
        } else invoke('complete_comparison', { questionId: action.questionId }, { ok: true, data: {} }, remaining--);
      } else if (action.kind === 'verify') invoke('verify_claim', { claimId: action.claimId }, { ok: true, data: receipt(state, action.claimId!) }, remaining--);
      else if (action.kind === 'report' && !state.checkedHash) { expect(scheduler.admit('check_coverage', {}, remaining)).toBeNull(); scheduler.started(); state.checkedHash = 'a'.repeat(64); scheduler.observe('check_coverage', {}, { ok: true, data: { status: 'completed' } }, --remaining); }
      else if (action.kind === 'report') { expect(scheduler.admit('submit_report', {}, remaining)).toBeNull(); scheduler.started(); state.submitted = true; scheduler.observe('submit_report', {}, { ok: true, data: { saved: true } }, --remaining); completed = true; break; }
      else throw new Error(`Unexpected node ${action.kind}`);
    }
    expect(completed).toBe(true); expect(state.facts).toHaveLength(6); expect(state.claims).toHaveLength(3);
    for (const question of spec.questions) { expect(state.nodes[`${question.id}-retrieve`]).toBe('completed'); expect(state.nodes[`${question.id}-verify`]).toBe('completed'); }
    expect(state.nodeToolCalls['income_profit-compare']).toBe(6); expect(remaining).toBeGreaterThanOrEqual(0);
  });
});
