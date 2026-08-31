import { afterEach, describe, expect, it } from 'vitest';

import { createSidecarServer } from '../src/server.js';
import { MAX_TOOL_CALLS_PER_TURN, SidecarRunEngine } from '../src/run-engine.js';
import { SCREEN_FIELDS, SCREEN_OPS, createGovernedTools } from '../src/tools.js';
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  RegisteredTool,
  RunRequest,
} from '../src/types.js';

function usage(input = 2, output = 1): ModelEvent {
  return {
    type: 'usage',
    usage: {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      cachedInputTokens: 0,
      cacheMissInputTokens: input,
    },
  };
}

function toolTurn(id: string, name: string, args: string): ModelEvent[] {
  return [
    { type: 'response_start', responseId: `response-${id}`, model: 'fake-model' },
    { type: 'tool_call_delta', index: 0, id, nameDelta: name, argumentsDelta: args },
    usage(),
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ];
}

function textTurn(text: string): ModelEvent[] {
  return [
    { type: 'response_start', responseId: `response-${text}`, model: 'fake-model' },
    { type: 'text_delta', delta: text },
    usage(),
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ];
}

class FakeProvider implements ModelProvider {
  readonly name = 'fake-provider';
  readonly requests: ModelRequest[] = [];
  private readonly scripts: ModelEvent[][];

  constructor(scripts: ModelEvent[][]) {
    this.scripts = scripts.map((script) => [...script]);
  }

  complete(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(request));
    const script = this.scripts.shift();
    return {
      async *[Symbol.asyncIterator]() {
        if (!script) throw new Error('No fake provider script remains.');
        for (const event of script) yield event;
      },
    };
  }
}

function schema(properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function testTools(executeLog: string[]): RegisteredTool[] {
  return [
    {
      name: 'lookup',
      category: 'market',
      description: 'Read a deterministic value.',
      inputSchema: schema({ symbol: { type: 'string' } }, ['symbol']),
      execute: async (input) => {
        executeLog.push(`lookup:${String((input as { symbol: string }).symbol)}`);
        return { ok: true, data: { price: 123 } };
      },
    },
    {
      name: 'submit_analysis',
      category: 'terminal',
      description: 'Submit a final analysis.',
      inputSchema: schema({ answer: { type: 'string' } }, ['answer']),
      terminal: true,
      execute: async (input) => {
        executeLog.push('submit');
        return { ok: true, data: { status: 'completed', answer: (input as { answer: string }).answer } };
      },
    },
  ];
}

function runRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: 'test-run',
    question: 'Analyze the supplied evidence.',
    ...overrides,
  };
}

describe('PI sidecar run engine', () => {
  it('uses the real PI loop for tool -> result -> terminal', async () => {
    const executionLog: string[] = [];
    const provider = new FakeProvider([
      toolTurn('lookup-call', 'lookup', '{"symbol":"sh600519"}'),
      toolTurn('submit-call', 'submit_analysis', '{"answer":"Evidence-backed result"}'),
    ]);
    const events: { type: string }[] = [];
    const result = await new SidecarRunEngine({
      provider,
      model: 'fake-model',
      tools: testTools(executionLog),
    }).run(runRequest(), (event) => { events.push(event); });

    expect(result.status).toBe('completed');
    expect(result.turns).toBe(2);
    expect(executionLog).toEqual(['lookup:sh600519', 'submit']);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].messages.some((message) => message.role === 'tool')).toBe(true);
    expect(events.map((event) => event.type)).toContain('terminal_submitted');
    expect(events.map((event) => event.type)).toContain('run_finished');
  });

  it('fails when the model stops without a terminal submission', async () => {
    const result = await new SidecarRunEngine({
      provider: new FakeProvider([textTurn('No terminal call')]),
      model: 'fake-model',
      tools: testTools([]),
    }).run(runRequest(), () => undefined);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('TERMINAL_TOOL_REQUIRED');
  });

  it('hides skill tools and descriptors completely in none mode', async () => {
    const skills = [{ id: 'wolf-investing', name: 'Wolf Investing', version: '0.1.0', description: 'Private run guidance.' }];
    const provider = new FakeProvider([textTurn('No tools needed')]);
    const events: { type: string; [key: string]: unknown }[] = [];
    await new SidecarRunEngine({
      provider,
      model: 'fake-model',
      tools: createGovernedTools({ skills, selectedSkill: 'none' }),
    }).run(runRequest({ skills, selectedSkill: 'none' }), (event) => { events.push(event as never); });

    const request = provider.requests[0];
    expect(request.tools?.map((tool) => tool.name)).not.toContain('load_skill');
    const system = request.messages.find((message) => message.role === 'system');
    expect(system?.content).not.toContain('wolf-investing');
    expect(events.find((event) => event.type === 'skill_selected')).toMatchObject({ skillId: null });
  });

  it('rejects a terminal call mixed with another tool before execution', async () => {
    const executionLog: string[] = [];
    const events: { type: string; [key: string]: unknown }[] = [];
    const provider = new FakeProvider([[
      { type: 'response_start', responseId: 'mixed-response', model: 'fake-model' },
      { type: 'tool_call_delta', index: 0, id: 'lookup-call', nameDelta: 'lookup', argumentsDelta: '{"symbol":"sh600519"}' },
      { type: 'tool_call_delta', index: 1, id: 'submit-call', nameDelta: 'submit_analysis', argumentsDelta: '{"answer":"bad batch"}' },
      usage(),
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
    ]]);
    const result = await new SidecarRunEngine({
      provider,
      model: 'fake-model',
      tools: testTools(executionLog),
    }).run(runRequest(), (event) => { events.push(event as never); });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('TERMINAL_TOOL_NOT_EXCLUSIVE');
    expect(executionLog).toEqual([]);
    const lifecycle = events.filter((event) => ['tool_started', 'tool_completed', 'tool_failed'].includes(event.type));
    expect(lifecycle.map((event) => `${event.type}:${(event.toolCall as { id: string }).id}`)).toEqual([
      'tool_started:lookup-call',
      'tool_failed:lookup-call',
      'tool_started:submit-call',
      'tool_failed:submit-call',
    ]);
    for (const event of lifecycle.filter((item) => item.type === 'tool_failed')) {
      expect(event.result).toMatchObject({ ok: false, error: { code: 'TERMINAL_TOOL_NOT_EXCLUSIVE' } });
    }
  });

  it('emits a lifecycle pair for an unknown tool before failing the run', async () => {
    const events: { type: string; [key: string]: unknown }[] = [];
    const result = await new SidecarRunEngine({
      provider: new FakeProvider([toolTurn('unknown-call', 'guessed_tool', '{}')]),
      model: 'fake-model',
      tools: testTools([]),
    }).run(runRequest(), (event) => { events.push(event as never); });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'UNKNOWN_TOOL' } });
    const lifecycle = events.filter((event) => ['tool_started', 'tool_completed', 'tool_failed'].includes(event.type));
    expect(lifecycle.map((event) => event.type)).toEqual(['tool_started', 'tool_failed']);
    expect(lifecycle[1].result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_TOOL' } });
  });

  it('reports cancellation and timeout/budget failures explicitly', async () => {
    const cancellation = new AbortController();
    const waitingProvider: ModelProvider = {
      name: 'waiting-provider',
      complete(request) {
        return {
          async *[Symbol.asyncIterator]() {
            if (request.signal?.aborted) throw request.signal.reason ?? new DOMException('aborted', 'AbortError');
            await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
            throw request.signal?.reason ?? new DOMException('aborted', 'AbortError');
          },
        };
      },
    };
    const promise = new SidecarRunEngine({
      provider: waitingProvider,
      model: 'fake-model',
      tools: testTools([]),
    }).run(runRequest({ signal: cancellation.signal }), () => undefined);
    cancellation.abort(new DOMException('cancelled', 'AbortError'));
    await expect(promise).resolves.toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });

    const timeoutProvider: ModelProvider = {
      name: 'timeout-provider',
      complete(request) {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => {
              if (request.signal?.aborted) resolve();
              else request.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            throw request.signal?.reason ?? new DOMException('timed out', 'TimeoutError');
          },
        };
      },
    };
    await expect(new SidecarRunEngine({
      provider: timeoutProvider,
      model: 'fake-model',
      tools: testTools([]),
      limits: { timeoutMs: 5 },
    }).run(runRequest({ runId: 'timeout-run' }), () => undefined)).resolves.toMatchObject({ status: 'timeout', error: { code: 'TIMEOUT' } });

    const budgetResult = await new SidecarRunEngine({
      provider: new FakeProvider([toolTurn('lookup-call', 'lookup', '{"symbol":"sh600519"}')]),
      model: 'fake-model',
      tools: testTools([]),
    }).run(runRequest({ maxTurns: 1 }), () => undefined);
    expect(budgetResult.status).toBe('failed');
    expect(budgetResult.error?.code).toBe('MAX_TURNS');
  });

  it('emits exactly one started/failed pair with a specific code for a rejected argument', async () => {
    const executionLog: string[] = [];
    const tools = testTools(executionLog);
    tools[0].parseInput = (value) => {
      const symbol = (value as { symbol?: unknown }).symbol;
      if (typeof symbol !== 'string' || !/^(?:sh|sz|bj)[0-9]{6}$/.test(symbol)) {
        throw new Error('symbol must use a canonical sh/sz/bj prefix');
      }
      return { symbol };
    };
    const events: { type: string; [key: string]: unknown }[] = [];
    const result = await new SidecarRunEngine({
      provider: new FakeProvider([
        toolTurn('bad-call', 'lookup', '{"symbol":"药明康德"}'),
        toolTurn('good-call', 'lookup', '{"symbol":"sh603259"}'),
        toolTurn('submit-call', 'submit_analysis', '{"answer":"Evidence-backed result"}'),
      ]),
      model: 'fake-model',
      tools,
    }).run(runRequest(), (event) => { events.push(event as never); });

    expect(result.status).toBe('completed');
    // The tool body never ran for the rejected call, so no market request was spent.
    expect(executionLog).toEqual(['lookup:sh603259', 'submit']);
    const lifecycle = events.filter((event) => ['tool_started', 'tool_completed', 'tool_failed'].includes(event.type));
    const badLifecycle = lifecycle.filter((event) => (event.toolCall as { id: string }).id === 'bad-call');
    expect(badLifecycle.map((event) => event.type)).toEqual(['tool_started', 'tool_failed']);
    expect((badLifecycle[0].toolCall as { arguments: unknown }).arguments).toMatchObject({ symbol: '药明康德' });
    expect(badLifecycle[1].result).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_INPUT' } });
    expect(String((badLifecycle[1].result as { error: { message: string } }).error.message)).toContain('canonical');
  });

  it('rejects malformed screener conditions through the real PI schema without a request', async () => {
    const requests: string[] = [];
    const events: { type: string; [key: string]: unknown }[] = [];
    await new SidecarRunEngine({
      provider: new FakeProvider([toolTurn(
        'bad-screen',
        'screen_stocks',
        '{"conditions":[{"field":"close","op":"gt"}],"sort":[{"field":"close","direction":"desc"}]}',
      )]),
      model: 'fake-model',
      tools: createGovernedTools({
        fetchImpl: async (input) => {
          requests.push(String(input));
          return new Response('{}', { status: 200 });
        },
      }),
      limits: { maxTurns: 1 },
    }).run(runRequest(), (event) => { events.push(event as never); });

    expect(requests).toEqual([]);
    const lifecycle = events.filter((event) => ['tool_started', 'tool_completed', 'tool_failed'].includes(event.type));
    expect(lifecycle.map((event) => event.type)).toEqual(['tool_started', 'tool_failed']);
    expect(lifecycle[1].result).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_INPUT' } });
  });

  it('does not persist raw arguments in PI schema rejection messages', async () => {
    const marker = 'PRIVATE_MODEL_OUTPUT_SHOULD_NOT_PERSIST';
    const events: { type: string; [key: string]: unknown }[] = [];
    await new SidecarRunEngine({
      provider: new FakeProvider([toolTurn(
        'bad-screen-extra-field',
        'screen_stocks',
        JSON.stringify({
          conditions: [{ field: 'close', op: 'gt', value: 10 }],
          sort: [{ field: 'close', direction: 'desc' }],
          unexpected_answer: marker,
        }),
      )]),
      model: 'fake-model',
      tools: createGovernedTools(),
      limits: { maxTurns: 1 },
    }).run(runRequest(), (event) => { events.push(event as never); });

    const failed = events.find((event) => event.type === 'tool_failed');
    const message = String((failed?.result as { error?: { message?: string } } | undefined)?.error?.message ?? '');
    expect(failed?.result).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_INPUT' } });
    expect(message).not.toContain(marker);
    expect(message).not.toContain('Received arguments:');
    expect(message.length).toBeLessThanOrEqual(400);
  });

  it('rejects an oversized tool batch whole and lets the next turn recover', async () => {
    const executionLog: string[] = [];
    const oversized: ModelEvent[] = [
      { type: 'response_start', responseId: 'batch-response', model: 'fake-model' },
      ...Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 1 }, (_, index): ModelEvent => ({
        type: 'tool_call_delta', index, id: `batch-${index}`, nameDelta: 'lookup', argumentsDelta: '{"symbol":"sh600519"}',
      })),
      usage(),
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
    ];
    const events: { type: string; [key: string]: unknown }[] = [];
    const result = await new SidecarRunEngine({
      provider: new FakeProvider([
        oversized,
        toolTurn('recovery-call', 'lookup', '{"symbol":"sh600519"}'),
        toolTurn('submit-call', 'submit_analysis', '{"answer":"Evidence-backed result"}'),
      ]),
      model: 'fake-model',
      tools: testTools(executionLog),
    }).run(runRequest(), (event) => { events.push(event as never); });

    expect(result.status).toBe('completed');
    expect(executionLog).toEqual(['lookup:sh600519', 'submit']);
    const failed = events.filter((event) => event.type === 'tool_failed');
    expect(failed).toHaveLength(MAX_TOOL_CALLS_PER_TURN + 1);
    for (const event of failed) {
      expect(event.result).toMatchObject({ ok: false, error: { code: 'TOOL_BATCH_LIMIT' } });
    }
  });

  it('stops with REPEATED_TOOL_FAILURE after three all-failing tool turns', async () => {
    const tools = testTools([]);
    tools[0].parseInput = () => { throw new Error('symbol must use a canonical sh/sz/bj prefix'); };
    const badTurn = (id: string) => toolTurn(id, 'lookup', '{"symbol":"bad"}');
    const result = await new SidecarRunEngine({
      provider: new FakeProvider([badTurn('a'), badTurn('b'), badTurn('c'), badTurn('d')]),
      model: 'fake-model',
      tools,
    }).run(runRequest(), () => undefined);

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('REPEATED_TOOL_FAILURE');
    expect(result.error?.message).toContain('INVALID_TOOL_INPUT');
    expect(result.turns).toBe(3);
  });

  it('does not count terminal input failures toward repeated non-terminal failures', async () => {
    const executionLog: string[] = [];
    const result = await new SidecarRunEngine({
      provider: new FakeProvider([
        toolTurn('bad-submit-1', 'submit_analysis', '{}'),
        toolTurn('bad-submit-2', 'submit_analysis', '{}'),
        toolTurn('bad-submit-3', 'submit_analysis', '{}'),
        toolTurn('lookup-after-submit-errors', 'lookup', '{"symbol":"sh600519"}'),
        toolTurn('good-submit', 'submit_analysis', '{"answer":"Recovered"}'),
      ]),
      model: 'fake-model',
      tools: testTools(executionLog),
    }).run(runRequest(), () => undefined);

    expect(result.status).toBe('completed');
    expect(result.turns).toBe(5);
    expect(executionLog).toEqual(['lookup:sh600519', 'submit']);
  });

  it('returns exact evidence ids to the model and recovers from a tool-name citation', async () => {
    const provider = new FakeProvider([
      toolTurn('resolve-call', 'resolve_symbol', '{"query":"药明康德"}'),
      toolTurn('bad-submit', 'submit_analysis', JSON.stringify({
        status: 'completed',
        answer: 'Evidence-backed result',
        evidence: [{ toolCallId: 'resolve_symbol', summary: 'Resolved the security.', asOf: '2026-08-31', source: 'local-catalog' }],
        dataAsOf: '2026-08-31',
        limitations: ['Only local catalog evidence was used.'],
        riskDisclaimer: 'For research only.',
      })),
      toolTurn('good-submit', 'submit_analysis', JSON.stringify({
        status: 'completed',
        answer: 'Evidence-backed result',
        evidence: [{ toolCallId: 'resolve-call', summary: 'Resolved the security.', asOf: '2026-08-31', source: 'local-catalog' }],
        dataAsOf: '2026-08-31',
        limitations: ['Only local catalog evidence was used.'],
        riskDisclaimer: 'For research only.',
      })),
    ]);
    const events: { type: string; [key: string]: unknown }[] = [];
    const result = await new SidecarRunEngine({
      provider,
      model: 'fake-model',
      tools: createGovernedTools({
        fetchImpl: async () => new Response(JSON.stringify({ status: 'resolved' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      }),
    }).run(runRequest(), (event) => { events.push(event as never); });

    expect(result).toMatchObject({ status: 'completed', turns: 3 });
    const successfulResult = provider.requests[1].messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'resolve-call',
    );
    expect(JSON.parse(successfulResult?.content ?? '{}')).toMatchObject({ ok: true, tool_call_id: 'resolve-call' });
    const retryResult = provider.requests[2].messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'bad-submit',
    );
    expect(JSON.parse(retryResult?.content ?? '{}')).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_EVIDENCE_REFERENCE',
        details: { available_tool_call_ids: ['resolve-call'] },
      },
    });
    const invalid = events.find(
      (event) => event.type === 'tool_failed' && (event.toolCall as { id?: string } | undefined)?.id === 'bad-submit',
    );
    expect(invalid?.result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_EVIDENCE_REFERENCE', details: { available_tool_call_ids: ['resolve-call'] } },
    });
  });

  it('counts only accepted calls against the tool and market budgets', async () => {
    const executionLog: string[] = [];
    const tools = testTools(executionLog);
    tools[0].category = 'market';
    tools[0].parseInput = (value) => {
      if ((value as { symbol?: unknown }).symbol !== 'sh600519') throw new Error('symbol must use a canonical sh/sz/bj prefix');
      return value;
    };
    const events: { type: string; [key: string]: unknown }[] = [];
    const result = await new SidecarRunEngine({
      provider: new FakeProvider([
        toolTurn('rejected-1', 'lookup', '{"symbol":"bad"}'),
        toolTurn('accepted-1', 'lookup', '{"symbol":"sh600519"}'),
        toolTurn('accepted-2', 'lookup', '{"symbol":"sh600519"}'),
      ]),
      model: 'fake-model',
      tools,
      limits: { maxMarketRequests: 2 },
    }).run(runRequest({ maxTurns: 3 }), (event) => { events.push(event as never); });

    // Two accepted market calls fit the budget even though a third call was attempted.
    expect(executionLog).toEqual(['lookup:sh600519', 'lookup:sh600519']);
    expect(result.error?.code).toBe('MAX_TURNS');
    expect(events.some((event) => event.type === 'tool_failed' && (event.result as { error: { code: string } }).error.code === 'MARKET_REQUEST_LIMIT')).toBe(false);
  });

  it('keeps lifecycle events complete when a later call reaches the real budget', async () => {
    const executionLog: string[] = [];
    const twoCalls: ModelEvent[] = [
      { type: 'response_start', responseId: 'budget-response', model: 'fake-model' },
      { type: 'tool_call_delta', index: 0, id: 'accepted-call', nameDelta: 'lookup', argumentsDelta: '{"symbol":"sh600519"}' },
      { type: 'tool_call_delta', index: 1, id: 'over-budget-call', nameDelta: 'lookup', argumentsDelta: '{"symbol":"sh600519"}' },
      usage(),
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
    ];
    const events: { type: string; [key: string]: unknown }[] = [];
    const result = await new SidecarRunEngine({
      provider: new FakeProvider([twoCalls]),
      model: 'fake-model',
      tools: testTools(executionLog),
      limits: { maxTotalToolCalls: 1 },
    }).run(runRequest(), (event) => { events.push(event as never); });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'TOOL_LIMIT' } });
    expect(executionLog).toEqual(['lookup:sh600519']);
    const lifecycle = events.filter((event) => ['tool_started', 'tool_completed', 'tool_failed'].includes(event.type));
    expect(lifecycle.map((event) => `${event.type}:${(event.toolCall as { id: string }).id}`)).toEqual([
      'tool_started:accepted-call',
      'tool_completed:accepted-call',
      'tool_started:over-budget-call',
      'tool_failed:over-budget-call',
    ]);
    expect(lifecycle[3].result).toMatchObject({ ok: false, error: { code: 'TOOL_LIMIT' } });
  });
});

describe('governed market tools', () => {
  const context = { runId: 'contract-test', turn: 1, toolCallId: 'call', signal: new AbortController().signal };

  function recordingFetch(calls: Array<{ url: string; method: string; body?: string }>): typeof fetch {
    return async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body as string | undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  }

  it('no longer exposes a generic path/query market entry point', () => {
    const names = createGovernedTools().map((tool) => tool.name);
    expect(names).not.toContain('quant_api_get');
    for (const tool of createGovernedTools()) {
      const properties = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(properties).not.toContain('path');
      expect(properties).not.toContain('url');
      expect(properties).not.toContain('query_params');
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it('maps each dedicated tool to one fixed FastAPI request', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const tools = createGovernedTools({ fetchImpl: recordingFetch(calls) });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    await byName.get('resolve_symbol')!.execute({ query: '药明康德' }, context);
    await byName.get('get_realtime_quote')!.execute({ symbol: 'sh603259' }, context);
    await byName.get('get_price_history')!.execute({ symbol: 'sh603259', adjustment: 'qfq', limit: 10 }, context);
    await byName.get('get_technical_indicators')!.execute({ symbol: 'sh603259', limit: 20 }, context);
    await byName.get('get_universe_summary')!.execute({}, context);
    await byName.get('get_universe_members')!.execute({ page: 2, page_size: 50 }, context);
    await byName.get('get_preset_candidates')!.execute({ mode: 'short_term', limit: 5 }, context);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET http://127.0.0.1:8787/api/v1/symbols/resolve?query=%E8%8D%AF%E6%98%8E%E5%BA%B7%E5%BE%B7',
      'GET http://127.0.0.1:8787/api/v1/quotes/realtime/sh603259',
      'GET http://127.0.0.1:8787/api/v1/quotes/history/sh603259?period=daily&adjustment=qfq&limit=10',
      'GET http://127.0.0.1:8787/api/v1/indicators/technical/sh603259?period=daily&adjustment=qfq&limit=20',
      'GET http://127.0.0.1:8787/api/v1/research/universes/summary?universe_id=a-share',
      'GET http://127.0.0.1:8787/api/v1/research/universes/a-share/members?page=2&page_size=50',
      'GET http://127.0.0.1:8787/api/v1/research/screeners/a-share/short-term-candidates?universe_id=a-share&mode=short_term&limit=5',
    ]);
  });

  it('rejects non-canonical symbols, unknown fields and out-of-range arguments', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const byName = new Map(createGovernedTools({ fetchImpl: recordingFetch(calls) }).map((tool) => [tool.name, tool]));

    await expect(byName.get('get_price_history')!.execute({ symbol: '药明康德' }, context)).rejects.toThrow(/resolve_symbol/);
    await expect(byName.get('get_price_history')!.execute({ symbol: '603259' }, context)).rejects.toThrow(/canonical symbol/);
    await expect(byName.get('get_price_history')!.execute({ symbol: 'sh603259', adjustment: 'raw' }, context)).rejects.toThrow(/adjustment/);
    await expect(byName.get('get_price_history')!.execute({ symbol: 'sh603259', limit: 5_000 }, context)).rejects.toThrow(/between 1 and 800/);
    await expect(byName.get('get_price_history')!.execute({ symbol: 'sh603259', path: '/api/v1/posts' }, context)).rejects.toThrow(/does not accept the field/);
    await expect(byName.get('get_preset_candidates')!.execute({ mode: 'guessed' }, context)).rejects.toThrow(/mode must be one of/);
    await expect(byName.get('get_preset_candidates')!.execute({ mode: 'short_term', as_of: 'last week' }, context)).rejects.toThrow(/as_of/);
    await expect(byName.get('resolve_symbol')!.execute({ query: '' }, context)).rejects.toThrow(/1 to 80/);
    expect(calls).toHaveLength(0);
  });

  it('publishes screener enums in the schema and keeps the runtime guard', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const screen = createGovernedTools({ fetchImpl: recordingFetch(calls) }).find((tool) => tool.name === 'screen_stocks')!;
    const schema = screen.inputSchema as {
      properties: { conditions: { items: { properties: Record<string, { enum?: string[] }> } }; sort: { items: { properties: Record<string, { enum?: string[] }> } } };
    };
    expect(schema.properties.conditions.items.properties.field.enum).toEqual([...SCREEN_FIELDS]);
    expect(schema.properties.conditions.items.properties.right_field.enum).toEqual([...SCREEN_FIELDS]);
    expect(schema.properties.conditions.items.properties.op.enum).toEqual([...SCREEN_OPS]);
    expect(schema.properties.sort.items.properties.field.enum).toEqual([...SCREEN_FIELDS]);

    await expect(screen.execute({
      conditions: [{ field: 'close', op: 'gt', value: 1 }],
      sort: [{ field: 'close', direction: 'desc' }],
      limit: 10,
    }, context)).resolves.toMatchObject({ ok: true });
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:8787/api/v1/research/screeners/a-share/query', method: 'POST' });
    expect(JSON.parse(calls[0].body as string)).toMatchObject({ universe_id: 'a-share' });

    await expect(screen.execute({
      conditions: [{ field: 'close', op: 'gt', value: 1, sql: 'DROP TABLE' }],
      sort: [{ field: 'close', direction: 'desc' }],
    }, context)).rejects.toThrow();
    await expect(screen.execute({
      conditions: [{ field: 'is_st', op: 'eq', value: 1 }],
      sort: [{ field: 'close', direction: 'desc' }],
    }, context)).rejects.toThrow(/must be boolean/);
    await expect(screen.execute({
      conditions: [{ field: 'is_st', op: 'gt', value: true }],
      sort: [{ field: 'close', direction: 'desc' }],
    }, context)).rejects.toThrow(/only supports the eq operator/);
    await expect(screen.execute({
      conditions: [{ field: 'exchange', op: 'between', value: [1, 2] }],
      sort: [{ field: 'close', direction: 'desc' }],
    }, context)).rejects.toThrow(/only supports the eq operator/);
    await expect(screen.execute({
      conditions: [{ field: 'close', op: 'between', value: [20, 10] }],
      sort: [{ field: 'close', direction: 'desc' }],
    }, context)).rejects.toThrow(/lower bound/);
    await expect(screen.execute({
      as_of: '2026-02-30',
      conditions: [{ field: 'close', op: 'gt', value: 1 }],
      sort: [{ field: 'close', direction: 'desc' }],
    }, context)).rejects.toThrow(/valid ISO calendar date/);
    await expect(screen.execute({
      universe_id: 'a-share',
      conditions: [{ field: 'close', op: 'gt', value: 1 }],
      sort: [{ field: 'close', direction: 'desc' }],
    }, context)).rejects.toThrow(/does not accept the field/);
    expect(calls).toHaveLength(1);
  });

  it('preserves fixed FastAPI HTTP and timeout failures', async () => {
    const unavailable = createGovernedTools({
      fetchImpl: async () => new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 }),
    }).find((tool) => tool.name === 'get_realtime_quote')!;
    await expect(unavailable.execute({ symbol: 'sh603259' }, context)).resolves.toMatchObject({
      ok: false,
      error: { code: 'FASTAPI_HTTP_ERROR', details: { status: 503 } },
    });

    const timeoutFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const timedOut = createGovernedTools({ fetchImpl: timeoutFetch, requestTimeoutMs: 5 })
      .find((tool) => tool.name === 'get_realtime_quote')!;
    await expect(timedOut.execute({ symbol: 'sh603259' }, context)).resolves.toMatchObject({
      ok: false,
      error: { code: 'FASTAPI_TIMEOUT' },
    });
  });

  it('exposes skill tools only when a skill is actually usable', () => {
    const skills = [{ id: 'wolf-investing', name: 'Wolf Investing', version: '0.1.0' }];
    const names = (options: Parameters<typeof createGovernedTools>[0]) => createGovernedTools(options).map((tool) => tool.name);

    expect(names({ skills, selectedSkill: 'none' })).not.toContain('load_skill');
    expect(names({ skills, selectedSkill: null })).not.toContain('load_skill');
    expect(names({ skills: [] })).not.toContain('load_skill');
    expect(names({ skills: [{ ...skills[0], enabled: false }] })).not.toContain('load_skill');
    expect(names({ skills })).toEqual(expect.arrayContaining(['load_skill', 'read_skill_reference']));
    expect(names({ skills, selectedSkill: 'wolf-investing' })).toEqual(expect.arrayContaining(['load_skill', 'read_skill_reference']));
    // The terminal and market tools stay available in every mode.
    expect(names({ skills, selectedSkill: 'none' })).toEqual(expect.arrayContaining(['resolve_symbol', 'submit_analysis']));
  });

  it('loads skill content with an exact reference index and refuses guessed paths', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/v1/skills/wolf-investing/SKILL.md')) {
        return new Response(JSON.stringify({
          content: '# Wolf Investing',
          version: '0.1.0',
          available_references: ['references/market-fields.md', '../secrets.md'],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/v1/skills/wolf-investing/reference?path=references%2Fmarket-fields.md')) {
        return new Response(JSON.stringify({ content: '# Market fields' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unexpected path' }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    const tools = createGovernedTools({
      skills: [{ id: 'wolf-investing', name: 'Wolf Investing', version: '0.1.0', description: 'Market research.' }],
      fetchImpl,
    });
    const load = tools.find((tool) => tool.name === 'load_skill')!;
    const reference = tools.find((tool) => tool.name === 'read_skill_reference')!;

    await expect(load.execute({ skill_id: 'wolf-investing' }, context)).resolves.toMatchObject({
      ok: true,
      data: { content: '# Wolf Investing', available_references: ['references/market-fields.md'] },
    });
    await expect(reference.execute({ skill_id: 'wolf-investing', path: 'references/guessed.md' }, context))
      .resolves.toMatchObject({ ok: false, error: { code: 'REFERENCE_NOT_AVAILABLE' } });
    await expect(reference.execute({ skill_id: 'wolf-investing', path: 'references/market-fields.md' }, context))
      .resolves.toMatchObject({ ok: true, data: { content: '# Market fields' } });
    expect(calls).toEqual([
      'GET http://127.0.0.1:8787/api/v1/skills/wolf-investing/SKILL.md',
      'GET http://127.0.0.1:8787/api/v1/skills/wolf-investing/reference?path=references%2Fmarket-fields.md',
    ]);
  });

  it('fails closed when a loaded skill offers no references', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/SKILL.md')) {
        return new Response(JSON.stringify({ content: '# No references', available_references: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ content: 'must not be read' }), { status: 200 });
    };
    const tools = createGovernedTools({
      skills: [{ id: 'wolf-investing', name: 'Wolf Investing', version: '0.1.0' }],
      fetchImpl,
    });
    const load = tools.find((tool) => tool.name === 'load_skill')!;
    const reference = tools.find((tool) => tool.name === 'read_skill_reference')!;

    await expect(load.execute({ skill_id: 'wolf-investing' }, context)).resolves.toMatchObject({
      ok: true,
      data: { available_references: [] },
    });
    await expect(reference.execute({ skill_id: 'wolf-investing', path: 'references/guessed.md' }, context))
      .resolves.toMatchObject({ ok: false, error: { code: 'REFERENCE_NOT_AVAILABLE' } });
    expect(calls).toHaveLength(1);
  });
});

describe('sidecar HTTP contract', () => {
  let server: ReturnType<typeof createSidecarServer> | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('accepts metadata-only skill descriptors and rejects inline skill content', async () => {
    server = createSidecarServer({ provider: new FakeProvider([]), model: 'fake-model', port: 0 });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind.');
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        run_id: 'inline-skill-content',
        question: 'reject inline content',
        skills: [{ id: 'wolf-investing', name: 'Wolf Investing', version: '0.1.0', content: '# injected' }],
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('exposes health identity and rejects a second active run', async () => {
    const provider: ModelProvider = {
      name: 'blocking-provider',
      complete(request) {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
            throw request.signal?.reason ?? new DOMException('aborted', 'AbortError');
          },
        };
      },
    };
    server = createSidecarServer({ provider, model: 'fake-model', port: 0 });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind.');
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/healthz`);
    const identity = await health.json() as { agent: { version: string }; sdk: { core: string; ai: string } };
    expect(health.status).toBe(200);
    expect(identity.agent.version).toBe('0.82.1');
    expect(identity.sdk.core).toContain('pi-agent-core');
    expect(identity.sdk.ai).toContain('pi-ai');

    const first = await fetch(`${base}/internal/v1/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        run_id: 'active-run',
        question: 'wait',
        skills: [{
          id: 'wolf-investing',
          name: 'Wolf Investing',
          version: '0.1.0',
          description: 'Market research skill.',
          scope: 'market-analysis',
          applicable_scope: 'stocks, indices, ETFs',
          source: 'builtin',
          content_sha256: 'a'.repeat(64),
        }],
      }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/internal/v1/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 'second-run', question: 'reject' }),
    });
    expect(second.status).toBe(409);
    await fetch(`${base}/internal/v1/runs/active-run/cancel`, { method: 'POST' });
    await first.body?.cancel();
  });
});
