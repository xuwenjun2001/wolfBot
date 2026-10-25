import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResearchProvider } from './provider';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('research provider batched output opt-in', () => {
  it.each([undefined, 'A', 'B', 'B2'] as const)('opts into multiple tool output only for variant %s', async variant => {
    vi.stubEnv('COMPANY_RESEARCH_API_KEY', 'fixture-only');
    vi.stubEnv('COMPANY_RESEARCH_BASE_URL', 'https://research.invalid/v1');
    vi.stubEnv('COMPANY_RESEARCH_REASONING', 'max');
    const payload = [
      { id: 'fixture', model: 'fixture', choices: [{ index: 0, delta: { content: 'fixture' }, finish_reason: 'stop' }] },
      { id: 'fixture', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const fetchMock = vi.fn(async () => new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createResearchProvider(() => 'trusted control', () => 'search_evidence', { variant });
    for await (const event of provider.complete({ model: 'fixture', messages: [{ role: 'user', content: 'fixture' }], maxTokens: 100 })) expect(event).toHaveProperty('type');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.parallel_tool_calls).toBe(variant === 'B2');
    expect(body.reasoning_effort).toBe('max');
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'search_evidence' } });
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'trusted control' });
    expect(body.max_completion_tokens).toBe(100); expect(body).not.toHaveProperty('max_tokens');
  });
});
