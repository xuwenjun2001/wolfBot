import { describe, expect, it } from 'vitest';

import { runStartupPreflight } from './preflight';

const validEnvironment = {
  DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/wolf_research',
  WOLF_RESEARCH_MARKET_DATA_URL: 'http://127.0.0.1:8001',
  WOLF_RESEARCH_AUTH_MODE: 'disabled',
  WOLF_RESEARCH_QUOTA_MODE: 'disabled',
  WOLF_RESEARCH_MEMORY_MODE: 'disabled',
  WOLF_RESEARCH_KNOWLEDGE_MODE: 'disabled',
  WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE: '0',
};

describe('runStartupPreflight', () => {
  it('accepts the fixed disabled facades', () => {
    const report = runStartupPreflight(validEnvironment);

    expect(report).toMatchObject({
      ok: true,
      authMode: 'disabled',
      quotaMode: 'disabled',
      memoryMode: 'disabled',
      knowledgeMode: 'disabled',
      previewEnabled: false,
      loopbackMutationsEnabled: false,
      sandboxMode: 'windows-unsandboxed',
    });
  });

  it('reports each missing required variable', () => {
    const report = runStartupPreflight({});

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.variable)).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'WOLF_RESEARCH_MARKET_DATA_URL',
        'WOLF_RESEARCH_AUTH_MODE',
        'WOLF_RESEARCH_QUOTA_MODE',
        'WOLF_RESEARCH_MEMORY_MODE',
        'WOLF_RESEARCH_KNOWLEDGE_MODE',
      ]),
    );
  });

  it('only enables unsandboxed preview for the exact value 1', () => {
    expect(
      runStartupPreflight({
        ...validEnvironment,
        WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE: '1',
      }).previewEnabled,
    ).toBe(true);
    expect(
      runStartupPreflight({
        ...validEnvironment,
        WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE: 'true',
      }).ok,
    ).toBe(false);
    expect(
      runStartupPreflight({
        ...validEnvironment,
        WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS: '1',
      }).loopbackMutationsEnabled,
    ).toBe(true);
  });
});
