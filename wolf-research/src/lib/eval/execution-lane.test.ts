import { describe, expect, it } from 'vitest';

import { createPiAgentPhaseGraph } from '../agent/core/phase-graph';
import { expectedExecutionLaneFailures } from './execution-lane';

const budgets = createPiAgentPhaseGraph({
  profile: 'generation',
  platformPrepared: true,
  preparedIntent: 'custom',
  hasAttachments: false,
  dashboardSpecReady: false,
}).budgets;

const expectedRuntime = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
};

function execution(cacheMissInputTokens: number) {
  const requestId = 'benchmark-custom-run';
  const runId = 'pi-custom-run';
  const tools = {
    total: 4,
    failed: 0,
    uncertain: 0,
    unexpectedFailureCount: 0,
    submitResultSucceeded: 1,
    succeededToolNames: ['query_json', 'semantic_edit', 'submit_result'],
  };
  return {
    provider: expectedRuntime.provider,
    model: expectedRuntime.model,
    requestId,
    turns: 3,
    usage: {
      totalTokens: 41_000,
      inputTokens: 40_000,
      outputTokens: 1_000,
      cachedInputTokens: Math.max(0, 40_000 - cacheMissInputTokens),
      cacheMissInputTokens,
      reasoningTokens: 0,
    },
    tools,
    runs: [{
      id: runId,
      requestId,
      status: 'candidate_complete',
      turns: 3,
      usage: {
        inputTokens: 40_000,
        outputTokens: 1_000,
        cacheMissInputTokens,
      },
      tools,
    }],
    missionStatus: 'completed',
    acceptedReceiptId: 'receipt-1',
    acceptedReceiptHash: 'a'.repeat(64),
    acceptedReceiptType: 'acceptance',
    acceptedReceiptVerdict: 'accepted',
    acceptedSourceRunId: runId,
    acceptedSourceRequestId: requestId,
    acceptedCandidateSource: 'pi_agent_submit_result',
  };
}

function failures(candidate: ReturnType<typeof execution>) {
  return expectedExecutionLaneFailures(
    { expectedExecutionLane: 'model_custom' },
    candidate,
    expectedRuntime,
    budgets,
  );
}

describe('expectedExecutionLaneFailures', () => {
  it('accepts a custom model run within the ordinary cache-miss budget', () => {
    expect(failures(execution(24_000))).toEqual([]);
  });

  it('accepts one bounded cache-miss overshoot from an accepted terminal turn', () => {
    expect(failures(execution(29_614))).toEqual([]);
    expect(failures(execution(48_000))).toEqual([]);
  });

  it('rejects a terminal overshoot beyond one prepared-request allowance', () => {
    expect(failures(execution(48_001))).not.toEqual([]);
  });

  it.each([
    ['without a terminal submission', (candidate: ReturnType<typeof execution>) => {
      candidate.runs[0].tools.submitResultSucceeded = 0;
      candidate.tools.submitResultSucceeded = 0;
      candidate.runs[0].tools.succeededToolNames = ['query_json', 'semantic_edit'];
      candidate.tools.succeededToolNames = ['query_json', 'semantic_edit'];
    }],
    ['with a failed tool', (candidate: ReturnType<typeof execution>) => {
      candidate.runs[0].tools.failed = 1;
      candidate.tools.failed = 1;
    }],
    ['with an uncertain tool', (candidate: ReturnType<typeof execution>) => {
      candidate.runs[0].tools.uncertain = 1;
      candidate.tools.uncertain = 1;
    }],
    ['before Mission acceptance', (candidate: ReturnType<typeof execution>) => {
      candidate.missionStatus = 'running';
    }],
    ['with acceptance from another run', (candidate: ReturnType<typeof execution>) => {
      candidate.acceptedSourceRunId = 'pi-other-run';
    }],
  ])('rejects a cache-miss overshoot %s', (_label, mutate) => {
    const candidate = execution(29_614);
    mutate(candidate);
    expect(failures(candidate)).not.toEqual([]);
  });
});
