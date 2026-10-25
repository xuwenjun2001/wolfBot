import { describe, expect, it } from 'vitest';
import type { PiAgentTool, PiAgentToolCall } from '@/lib/agent/types';
import { financialBatchLimit, validateFinancialBatch } from './financial-batch';
import { FinancialScheduler, upgradeFinancialCheckpoint } from './financial-scheduler';
import { buildFinancialPlanV2 } from './plan-graph';
import { emptyCheckpoint } from './execution-contracts';
import { specFixture } from './version-test-fixtures';

const schema = { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false };
const tool = (name: string, terminal = false): PiAgentTool => ({ name, description: 'Protocol fixture', inputSchema: schema, terminal, effect: 'read', execute() { throw new Error('Preflight must never execute'); } });
const tools = ['search_evidence', 'read_evidence', 'record_fact', 'record_claim', 'verify_claim', 'check_coverage', 'import_filing', 'parse_document'].map(name => tool(name));
tools.push(tool('submit_report', true));
const call = (name: string, id = name, input: unknown = { query: '原文' }): PiAgentToolCall => ({ id, name, arguments: JSON.stringify(input) });
const policy = { maxToolCallsPerTurn: 3, remaining: 40, reserve: 2 };

describe('financial B2 complete-turn preflight', () => {
  it('accepts three readonly calls and validates all arguments without execution or mutation', async () => {
    const calls = [call('search_evidence', 'a'), call('read_evidence', 'b'), call('search_evidence', 'c')];
    const before = structuredClone(calls);
    expect(await validateFinancialBatch(calls, tools, policy)).toMatchObject({ ok: true, data: calls.map(c => ({ id: c.id, name: c.name, input: { query: '原文' } })) });
    expect(calls).toEqual(before);
  });

  it.each(['record_fact', 'record_claim', 'verify_claim', 'check_coverage', 'import_filing', 'parse_document'])('allows exactly one %s after readonly calls', async name => {
    expect(await validateFinancialBatch([call('search_evidence'), call(name)], tools, policy)).toMatchObject({ ok: true });
    expect(await validateFinancialBatch([call(name), call('search_evidence')], tools, policy)).toMatchObject({ ok: false, error: { code: 'FINANCIAL_BATCH_STATE_ORDER' } });
    expect(await validateFinancialBatch([call('record_fact', 'first'), call(name, 'last')], tools, policy)).toMatchObject({ ok: false, error: { code: 'FINANCIAL_BATCH_STATE_COUNT' } });
  });

  it('requires submission to occupy a separate turn', async () => {
    expect(await validateFinancialBatch([call('search_evidence'), call('submit_report')], tools, policy)).toMatchObject({ ok: false, error: { code: 'FINANCIAL_BATCH_TERMINAL_EXCLUSIVE' } });
    expect(await validateFinancialBatch([call('submit_report')], tools, policy)).toMatchObject({ ok: true });
  });

  it('rejects the whole batch for a later invalid argument, unknown tool or duplicate id', async () => {
    const scenarios = [
      { calls: [call('search_evidence'), call('read_evidence', 'invalid', {})], code: 'FINANCIAL_BATCH_ARGUMENTS' },
      { calls: [call('search_evidence'), call('unknown')], code: 'FINANCIAL_BATCH_UNKNOWN_TOOL' },
      { calls: [call('search_evidence', 'same'), call('read_evidence', 'same')], code: 'FINANCIAL_BATCH_DUPLICATE_ID' },
      { calls: [call('search_evidence'), call('read_evidence', 'invalid', [])], code: 'FINANCIAL_BATCH_ARGUMENTS' },
    ];
    for (const scenario of scenarios) expect(await validateFinancialBatch(scenario.calls, tools, policy)).toMatchObject({ ok: false, error: { code: scenario.code, details: { charged: false } } });
  });

  it('prevents a later readonly call from entering the closure reserve before any call runs', async () => {
    const calls = [call('search_evidence'), call('read_evidence')];
    expect(await validateFinancialBatch(calls, tools, { ...policy, remaining: 3 })).toMatchObject({ ok: false, error: { code: 'FINANCIAL_BATCH_CLOSURE_RESERVED', details: { index: 1, charged: false } } });
    expect(await validateFinancialBatch(calls, tools, { ...policy, remaining: 4 })).toMatchObject({ ok: true });
    expect(await validateFinancialBatch([call('verify_claim')], tools, { ...policy, remaining: 1, reserve: 5 })).toMatchObject({ ok: true });
    expect(await validateFinancialBatch([call('submit_report')], tools, { ...policy, remaining: 0 })).toMatchObject({ ok: false, error: { code: 'FINANCIAL_BATCH_BUDGET' } });
  });

  it('rejects oversized turns and invalid budget inputs with structured feedback', async () => {
    expect(await validateFinancialBatch(Array.from({ length: 4 }, (_, i) => call('search_evidence', `q-${i}`)), tools, policy)).toMatchObject({ ok: false, error: { code: 'FINANCIAL_BATCH_LIMIT' } });
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await validateFinancialBatch([], tools, { ...policy, remaining: value })).toMatchObject({ ok: false, error: { code: 'FINANCIAL_BATCH_BUDGET_INVALID' } });
      expect(await validateFinancialBatch([], tools, { ...policy, reserve: value })).toMatchObject({ ok: false });
    }
  });
});

describe('B2 configuration and scheduler preview', () => {
  it('defaults to 3, inherits a bound value and rejects a silent change', () => {
    expect(financialBatchLimit()).toBe(3);
    expect(financialBatchLimit(undefined, 5)).toBe(5);
    expect(financialBatchLimit(5, 5)).toBe(5);
    expect(() => financialBatchLimit(3, 5)).toThrow('FINANCIAL_BATCH_LIMIT_MISMATCH');
    for (const value of [0, -1, 1.5, 9, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) expect(() => financialBatchLimit(value)).toThrow('FINANCIAL_BATCH_LIMIT_INVALID');
    expect(financialBatchLimit(1)).toBe(1); expect(financialBatchLimit(8)).toBe(8);
  });

  it('rejects a later cross-question write on detached state without advancing or charging the real scheduler', () => {
    const spec = specFixture(), taskId = '00000000-0000-4000-8000-000000000001', createdAt = '2026-10-25T07:00:00Z';
    const plan = buildFinancialPlanV2(spec, { taskId, createdAt }), state = upgradeFinancialCheckpoint(emptyCheckpoint(1, 1), plan, []);
    for (const id of ['prepare-facts', 'income_profit-retrieve', 'cash_flow-retrieve', 'risks-retrieve']) state.nodes[id] = 'completed';
    const scheduler = new FinancialScheduler({ taskId, spec, state, createdAt, reviews: [] }), before = structuredClone(state);
    expect(scheduler.preflightBatch([{ id: 'a', name: 'search_evidence', input: {} }, { id: 'b', name: 'record_claim', input: { id: 'wrong', questionId: 'cash_flow' } }], 40)).toMatchObject({ ok: false, error: { code: 'SCHEDULER_NODE_MISMATCH' } });
    expect(state).toEqual(before);
    expect(scheduler.preflightBatch([{ id: 'a', name: 'read_evidence', input: {} }, { id: 'b', name: 'record_claim', input: { id: 'right', questionId: 'income_profit' } }], 40)).toBeNull();
    expect(state).toEqual(before);
  });
});
