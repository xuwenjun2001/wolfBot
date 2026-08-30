import { describe, expect, it } from 'vitest';

import { OpenAICompatibleProvider } from '../src/provider.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('OpenAI-compatible provider', () => {
  it('uses the streaming chat-completions contract and omits hidden reasoning', async () => {
    const payload = [
      {
        id: 'response-1', model: 'fake-model',
        choices: [{ index: 0, delta: { reasoning_content: 'private', content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'response-1',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'submit_analysis', arguments: '{"status":"' } }] }, finish_reason: null }],
      },
      {
        id: 'response-1',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'completed"}' } }] }, finish_reason: 'tool_calls' }],
      },
      {
        id: 'response-1', choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, prompt_tokens_details: { cached_tokens: 1 } },
      },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    let body = '';
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-secret',
      baseUrl: 'http://127.0.0.1:38082/v1',
      reasoningEffort: 'high',
      fetchImpl: async (_input, init) => {
        body = String(init?.body);
        return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const events = await collect(provider.complete({
      model: 'fake-model',
      messages: [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'question' },
      ],
      reasoning: { enabled: true, effort: 'high' },
    }));
    const request = JSON.parse(body) as Record<string, unknown>;
    expect(request.reasoning_effort).toBe('high');
    expect(request).not.toHaveProperty('thinking');
    expect(JSON.stringify(request)).not.toContain('private');
    expect(events).toContainEqual({ type: 'text_delta', delta: 'ok' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'finish', reason: 'tool_calls' }));
  });

  it('fails closed when credentials are missing', async () => {
    const provider = new OpenAICompatibleProvider({ apiKey: '', baseUrl: 'http://127.0.0.1:38082/v1' });
    await expect(collect(provider.complete({ model: 'fake-model', messages: [{ role: 'user', content: 'q' }] }))).rejects.toMatchObject({ code: 'NEEDS_CONFIGURATION' });
  });
});
