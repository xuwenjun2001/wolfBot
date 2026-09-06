import { describe, expect, it } from 'vitest';

import { createPiAgentPhaseGraph } from '../core/phase-graph';
import { getProjectLlmConfig } from '@/lib/config/llm';
import {
  PI_AGENT_DETERMINISTIC_MODEL,
  PI_AGENT_DETERMINISTIC_PROVIDER,
  PiAgentProviderSelectionError,
  selectPiAgentProvider,
} from './selection';

function preparedGraph(executionMode: 'production' | 'contract') {
  return createPiAgentPhaseGraph({
    profile: 'generation',
    executionMode,
    platformPrepared: true,
    preparedIntent: 'standard',
    hasAttachments: false,
    dashboardSpecReady: true,
  });
}

describe('PI Agent provider selection', () => {
  it('preserves the selected official provider and model for production research', () => {
    const model = 'deepseek-v4-flash';
    const config = getProjectLlmConfig(model);

    expect(selectPiAgentProvider({
      phaseGraph: preparedGraph('production'),
      llmConfig: config,
      model,
      executionMode: 'production',
    })).toEqual({
      providerMode: 'model',
      provider: 'deepseek',
      model,
    });
  });

  it('preserves the selected local ModelPort provider and model', () => {
    const model = 'local_qwen:qwen3.5-9b-q5km';
    const config = getProjectLlmConfig(model);

    expect(selectPiAgentProvider({
      phaseGraph: preparedGraph('production'),
      llmConfig: config,
      model,
      executionMode: 'production',
    })).toEqual({
      providerMode: 'model',
      provider: 'openai',
      model,
    });
  });

  it('rejects a deterministic graph when the provider boundary is production', () => {
    expect(() => selectPiAgentProvider({
      phaseGraph: preparedGraph('contract'),
      llmConfig: getProjectLlmConfig('deepseek-v4-flash'),
      model: 'deepseek-v4-flash',
      executionMode: 'production',
    })).toThrowError(PiAgentProviderSelectionError);
    try {
      selectPiAgentProvider({
        phaseGraph: preparedGraph('contract'),
        llmConfig: getProjectLlmConfig('deepseek-v4-flash'),
        model: 'deepseek-v4-flash',
        executionMode: 'production',
      });
    } catch (error) {
      expect(error).toMatchObject({ code: 'LLM-010' });
    }
  });

  it('keeps the deterministic renderer identity explicit in contract mode', () => {
    expect(selectPiAgentProvider({
      phaseGraph: preparedGraph('contract'),
      llmConfig: getProjectLlmConfig('deepseek-v4-flash'),
      model: 'deepseek-v4-flash',
      executionMode: 'contract',
    })).toEqual({
      providerMode: 'deterministic',
      provider: PI_AGENT_DETERMINISTIC_PROVIDER,
      model: PI_AGENT_DETERMINISTIC_MODEL,
    });
  });
});
