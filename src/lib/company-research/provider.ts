import { OpenAICompatibleProvider } from '@/lib/agent/providers/openai-compatible';
import { researchConfig } from './config';

/** Reuse the hardened SSE/tool-call parser, with the gateway's explicit reasoning wire format. */
export function createResearchProvider(control?: () => string, requiredTool?: () => string | undefined, options: { variant?: 'A' | 'B' | 'B2' } = {}) {
  const config = researchConfig();
  if (!config.apiKey) throw new Error('缺少 COMPANY_RESEARCH_API_KEY');
  return new OpenAICompatibleProvider({
    providerName: 'company-research-gateway', apiKey: config.apiKey, baseUrl: config.baseUrl,
    maxRetries: 0, // A retry must be visible as a new research attempt/step, never hidden.
    fetchImpl: (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      body.reasoning_effort = config.reasoning;
      // This controls model output only. PI still executes every tool sequentially.
      body.parallel_tool_calls = options.variant === 'B2';
      if (control && Array.isArray(body.messages)) body.messages.push({ role: 'user', content: control() });
      const tool = requiredTool?.();
      if (tool) body.tool_choice = { type: 'function', function: { name: tool } };
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
      return fetch(url, { ...init, body: JSON.stringify(body) });
    },
  });
}
