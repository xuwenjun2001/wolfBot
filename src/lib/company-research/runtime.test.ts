import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyReport } from './contracts';
import type { StoredRun } from './store';
import type { PiAgentModelEvent, PiAgentModelRequest } from '@/lib/agent/types';

const mocks = vi.hoisted(() => ({ checkpoint: vi.fn(), heartbeat: vi.fn(), provider: vi.fn() }));
vi.mock('./store', () => ({ checkpoint: mocks.checkpoint, heartbeat: mocks.heartbeat }));
vi.mock('./provider', () => ({ createResearchProvider: mocks.provider }));
vi.mock('./connectors', async (importOriginal) => ({
  ...await importOriginal<typeof import('./connectors')>(),
  readWebSource: vi.fn(async (url: string) => ({ id: 'web-proof', url, title: '公司年报', publishedAt: null, fetchedAt: new Date().toISOString(), content: '公司主营电池业务，上游采购原材料，下游服务新能源汽车客户。', hash: 'proof', kind: 'web' })),
}));
import { executeResearch } from './runtime';

function fixture(): StoredRun {
  return {
    id: 'test-recovery', actor_id: 'test', payload_hash: '', status: 'running',
    created_at: new Date(), started_at: new Date(), finished_at: null,
    lease_owner: 'worker-2', generation: 2, sequence: 4, cancel_requested: false, error: null,
    steps: [{ number: 1, tool: 'read_sources', title: '读取资料', input: {}, summary: '', status: 'running', startedAt: new Date().toISOString() }],
    state: { company: { symbol: '300750', name: '宁德时代' }, asOf: new Date().toISOString(), sources: [], draft: emptyReport('仍需核查'), supplementRounds: 1, coverageChecks: 2, lastCoverageHash: null, toolCalls: 9, inputTokens: 80000, outputTokens: 3000, submitted: false, notes: [] },
  };
}
beforeEach(() => { vi.clearAllMocks(); mocks.heartbeat.mockResolvedValue(false); mocks.checkpoint.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllEnvs());
describe('research recovery and terminal control', () => {
  it('aborts a hanging model at the hard deadline and saves a system report without a tool step', async () => {
    vi.stubEnv('COMPANY_RESEARCH_TIMEOUT_MS', '200');
    const run = fixture(); run.steps = []; run.state.draft = null;
    mocks.provider.mockReturnValue({ name: 'deadline', async *complete(request: PiAgentModelRequest): AsyncGenerator<PiAgentModelEvent> {
      yield { type: 'response_start', responseId: 'hanging', model: request.model };
      await new Promise<void>(resolve => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
      throw new Error('request aborted at deadline');
    } });
    await executeResearch(run);
    expect(run.state.phase).toBe('finalizing');
    expect(run.state.draft).not.toBeNull();
    expect(run.state.systemEvents?.some(e => e.id === 'auto-save')).toBe(true);
    expect(run.state.submitted).toBe(false); expect(run.steps).toHaveLength(0);
  }, 10000);
  it('recovers a submitted checkpoint without repeating the model or resetting budgets', async () => {
    const run = fixture(); run.state.submitted = true;
    await executeResearch(run);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(run.steps[0]).toMatchObject({ number: 1, status: 'failed' });
    expect(run.state.toolCalls).toBe(9);
    expect(run.state.inputTokens).toBe(80000);
    expect(mocks.checkpoint).toHaveBeenCalledWith(run, 'partial');
  });
  it('honors elapsed time across restart and retains the saved draft', async () => {
    const run = fixture(); run.started_at = new Date(Date.now() - 3600000);
    await executeResearch(run);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(run.state.draft?.business.gaps).toContain('仍需核查');
    expect(mocks.checkpoint).toHaveBeenCalledWith(run, 'partial', '已达到工具调用次数或运行时间上限');
  });
  it('charges the pending model reservation on recovery instead of resetting an interrupted request', async () => {
    const run = fixture(); run.state.submitted = true; run.state.pendingUsage = { input: 5000, output: 1000 };
    await executeResearch(run);
    expect(run.state.inputTokens).toBe(85000);
    expect(run.state.outputTokens).toBe(4000);
    expect(run.state.usageEstimated).toBe(true);
    expect(run.state.pendingUsage).toBeUndefined();
  });
  it('cancels without starting new network calls and keeps prior evidence', async () => {
    const run = fixture(); mocks.heartbeat.mockResolvedValue(true);
    await executeResearch(run);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.checkpoint).toHaveBeenCalledWith(run, 'cancelled');
    expect(run.state.draft).not.toBeNull();
  });
  it('never publishes a result after losing its worker fencing token', async () => {
    const run = fixture(); mocks.heartbeat.mockRejectedValue(new Error('RESEARCH_LEASE_LOST'));
    await executeResearch(run);
    expect(mocks.checkpoint).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it('continues beyond former token and round limits, preserving schema retry feedback', async () => {
    const run = fixture(); run.steps = []; run.state.toolCalls = 0; run.state.draft = null;
    run.state.inputTokens = 250000; run.state.outputTokens = 40000; run.state.coverageChecks = 10;
    let turn = 0; let sawValidationError = false;
    mocks.provider.mockReturnValue({ name: 'test', async *complete(request: PiAgentModelRequest): AsyncGenerator<PiAgentModelEvent> {
      turn++;
      if (turn === 2) sawValidationError = request.messages.some(m => m.role === 'tool' && /Validation|validation|maxItems|3 items|fewer/i.test(m.content));
      if (turn > 2) throw new Error('End of retry regression fixture');
      yield { type: 'response_start', responseId: `r${turn}`, model: request.model };
      yield { type: 'tool_call_delta', index: 0, id: `call${turn}`, nameDelta: 'read_sources', argumentsDelta: JSON.stringify({ urls: Array.from({ length: turn === 1 ? 4 : 1 }, (_, i) => `https://example.com/${i}`) }) };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
      yield { type: 'finish', reason: 'tool_calls' };
    } });
    await executeResearch(run);
    expect(sawValidationError).toBe(true);
    expect(run.steps.map(s => [s.number, s.status])).toEqual([[1, 'failed'], [2, 'completed']]);
    expect(run.state.toolCalls).toBe(2);
    expect(run.state.sources).toHaveLength(1);
  }, 20000);
});
