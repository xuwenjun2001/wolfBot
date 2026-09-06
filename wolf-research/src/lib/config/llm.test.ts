import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProjectLlmConfig, resolvePiAgentExecutionMode } from './llm';

describe('project LLM configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps official DeepSeek reasoning off by default within the bounded Agent budget', () => {
    expect(getProjectLlmConfig('deepseek-v4-flash').agent).toMatchObject({
      enabled: true,
      reasoningEnabled: false,
    });
    expect(getProjectLlmConfig('local_qwen:qwen3.5-9b-q5km').agent.reasoningEnabled).toBe(true);
  });

  it('allows an explicit reasoning override without changing the locked provider', () => {
    vi.stubEnv('PI_AGENT_REASONING', '1');
    const enabled = getProjectLlmConfig('deepseek-v4-flash');
    expect(enabled.agent.reasoningEnabled).toBe(true);
    expect(enabled.provider).toBe('deepseek');

    vi.stubEnv('PI_AGENT_REASONING', '0');
    expect(getProjectLlmConfig('local_qwen:qwen3.5-9b-q5km').agent.reasoningEnabled).toBe(false);
  });

  it('recognizes only explicit process evaluation boundaries for deterministic execution', () => {
    expect(resolvePiAgentExecutionMode({ NODE_ENV: 'production' })).toBe('production');
    expect(resolvePiAgentExecutionMode({
      NODE_ENV: 'production',
      WOLF_RESEARCH_EVAL_MODE: 'e2e',
    })).toBe('production');
    expect(resolvePiAgentExecutionMode({
      NODE_ENV: 'production',
      WOLF_RESEARCH_EVAL_MODE: 'contract',
    })).toBe('contract');
    expect(resolvePiAgentExecutionMode({
      NODE_ENV: 'test',
      WOLF_RESEARCH_EVAL_MODE: 'arbitrary-request-value',
    })).toBe('test');
    expect(resolvePiAgentExecutionMode({
      NODE_ENV: 'production',
      WOLF_RESEARCH_EVAL_MODE: 'arbitrary-request-value',
    })).toBe('production');
  });
});
