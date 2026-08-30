import { afterEach, describe, expect, it } from 'vitest';

import { createSidecarServer } from '../src/server.js';
import { SidecarRunEngine } from '../src/run-engine.js';
import { createGovernedTools } from '../src/tools.js';
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
      description: 'Read a deterministic value.',
      inputSchema: schema({ symbol: { type: 'string' } }, ['symbol']),
      execute: async (input) => {
        executeLog.push(`lookup:${String((input as { symbol: string }).symbol)}`);
        return { ok: true, data: { price: 123 } };
      },
    },
    {
      name: 'submit_analysis',
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

  it('rejects a terminal call mixed with another tool before execution', async () => {
    const executionLog: string[] = [];
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
    }).run(runRequest(), () => undefined);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('TERMINAL_TOOL_NOT_EXCLUSIVE');
    expect(executionLog).toEqual([]);
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
});

describe('governed market tools', () => {
  it('enforces the read-only allowlist and dedicated screener endpoint', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body as string | undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const tools = createGovernedTools({ fetchImpl });
    const quant = tools.find((tool) => tool.name === 'quant_api_get')!;
    const screen = tools.find((tool) => tool.name === 'screen_stocks')!;
    const context = { runId: 'allowlist-test', turn: 1, toolCallId: 'call', signal: new AbortController().signal };

    await expect(quant.execute({ path: '/api/v1/posts' }, context)).rejects.toThrow(/allowlist/);
    const quote = await quant.execute({ path: '/api/v1/quotes/realtime/sh600519' }, context);
    expect(quote.ok).toBe(true);
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:8787/api/v1/quotes/realtime/sh600519', method: 'GET' });

    await expect(screen.execute({
      universe_id: 'a-share',
      conditions: [{ field: 'close', op: 'gt', value: 1 }],
      sort: [{ field: 'close', direction: 'desc' }],
      limit: 10,
    }, context)).resolves.toMatchObject({ ok: true });
    expect(calls[1]).toMatchObject({ url: 'http://127.0.0.1:8787/api/v1/research/screeners/a-share/query', method: 'POST' });
    await expect(screen.execute({
      universe_id: 'a-share',
      conditions: [{ field: 'close', op: 'gt', value: 1, sql: 'DROP TABLE' }],
      sort: [{ field: 'close', direction: 'desc' }],
      limit: 10,
    }, context)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it('loads skill content and references through the local FastAPI API', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/v1/skills/wolf-investing/SKILL.md')) {
        return new Response(JSON.stringify({ content: '# Wolf Investing', version: '0.1.0' }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    const context = { runId: 'skill-test', turn: 1, toolCallId: 'call', signal: new AbortController().signal };
    const load = tools.find((tool) => tool.name === 'load_skill')!;
    const reference = tools.find((tool) => tool.name === 'read_skill_reference')!;

    await expect(load.execute({ skill_id: 'wolf-investing' }, context)).resolves.toMatchObject({ ok: true, data: { content: '# Wolf Investing' } });
    await expect(reference.execute({ skill_id: 'wolf-investing', path: 'references/market-fields.md' }, context)).resolves.toMatchObject({ ok: true, data: { content: '# Market fields' } });
    expect(calls).toEqual([
      'GET http://127.0.0.1:8787/api/v1/skills/wolf-investing/SKILL.md',
      'GET http://127.0.0.1:8787/api/v1/skills/wolf-investing/reference?path=references%2Fmarket-fields.md',
    ]);
  });
});

describe('sidecar HTTP contract', () => {
  let server: ReturnType<typeof createSidecarServer> | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
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
