import type { ProjectLlmConfig } from '@/lib/config/llm';
import {
  isDeterministicPiAgentExecutionMode,
  type PiAgentExecutionMode,
  type PiAgentPhaseGraph,
} from '../core/phase-graph';

export const PI_AGENT_DETERMINISTIC_PROVIDER = 'pi-agent-trusted-renderer' as const;
export const PI_AGENT_DETERMINISTIC_MODEL = 'pi-agent-deterministic-renderer-v1' as const;

export type PiAgentProviderSelection =
  | {
      providerMode: 'deterministic';
      provider: typeof PI_AGENT_DETERMINISTIC_PROVIDER;
      model: typeof PI_AGENT_DETERMINISTIC_MODEL;
    }
  | {
      providerMode: 'model';
      provider: ProjectLlmConfig['provider'];
      model: string;
    };

export class PiAgentProviderSelectionError extends Error {
  readonly code = 'LLM-010';

  constructor() {
    super('Deterministic PI Agent provider is only available in contract or test execution.');
    this.name = 'PiAgentProviderSelectionError';
  }
}

export function selectPiAgentProvider(input: {
  phaseGraph: Pick<PiAgentPhaseGraph, 'providerMode'>;
  llmConfig: Pick<ProjectLlmConfig, 'provider'>;
  model: string;
  executionMode: PiAgentExecutionMode;
}): PiAgentProviderSelection {
  if (input.phaseGraph.providerMode === 'deterministic') {
    if (!isDeterministicPiAgentExecutionMode(input.executionMode)) {
      throw new PiAgentProviderSelectionError();
    }
    return {
      providerMode: 'deterministic',
      provider: PI_AGENT_DETERMINISTIC_PROVIDER,
      model: PI_AGENT_DETERMINISTIC_MODEL,
    };
  }

  return {
    providerMode: 'model',
    provider: input.llmConfig.provider,
    model: input.model,
  };
}
