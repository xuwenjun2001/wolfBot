import type { PiAgentExecutionLane, PiAgentPhaseGraph } from '../agent/core/phase-graph';

type CustomLaneBudgets = Pick<
  PiAgentPhaseGraph['budgets'],
  | 'maxTurns'
  | 'maxToolCalls'
  | 'maxOutputTokens'
  | 'maxCacheMissInputTokens'
  | 'maxPreparedInputTokens'
  | 'maxCumulativePreparedInputTokens'
>;

interface ToolSummaryLike {
  total?: unknown;
  failed?: unknown;
  uncertain?: unknown;
  unexpectedFailureCount?: unknown;
  submitResultSucceeded?: unknown;
  succeededToolNames?: unknown;
}

interface RunEvidenceLike {
  id?: unknown;
  requestId?: unknown;
  status?: unknown;
  turns?: unknown;
  usage?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheMissInputTokens?: unknown;
  };
  tools?: ToolSummaryLike;
}

interface ExecutionEvidenceLike {
  provider?: unknown;
  model?: unknown;
  requestId?: unknown;
  turns?: unknown;
  usage?: {
    totalTokens?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    cachedInputTokens?: unknown;
    cacheMissInputTokens?: unknown;
    reasoningTokens?: unknown;
  };
  tools?: ToolSummaryLike;
  runs?: unknown;
  missionStatus?: unknown;
  acceptedReceiptId?: unknown;
  acceptedReceiptHash?: unknown;
  acceptedReceiptType?: unknown;
  acceptedReceiptVerdict?: unknown;
  acceptedSourceRunId?: unknown;
  acceptedSourceRequestId?: unknown;
  acceptedCandidateSource?: unknown;
}

interface ExpectedRuntimeLike {
  provider?: unknown;
  model?: unknown;
}

interface ExpectedLaneCaseLike {
  expectedExecutionLane?: unknown;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function succeededToolNames(run: RunEvidenceLike | undefined): string[] {
  return Array.isArray(run?.tools?.succeededToolNames)
    ? run.tools.succeededToolNames.filter((name): name is string => typeof name === 'string')
    : [];
}

function acceptedTerminalOvershoot(
  execution: ExecutionEvidenceLike,
  rootRun: RunEvidenceLike,
  budgets: CustomLaneBudgets,
): boolean {
  const cacheMissInputTokens = rootRun.usage?.cacheMissInputTokens;
  const terminalCacheMissCeiling =
    budgets.maxCacheMissInputTokens + budgets.maxPreparedInputTokens;

  return nonNegativeInteger(cacheMissInputTokens) &&
    cacheMissInputTokens > budgets.maxCacheMissInputTokens &&
    cacheMissInputTokens <= terminalCacheMissCeiling &&
    execution.missionStatus === 'completed' &&
    nonEmptyString(execution.acceptedReceiptId) &&
    nonEmptyString(execution.acceptedReceiptHash) &&
    execution.acceptedReceiptType === 'acceptance' &&
    execution.acceptedReceiptVerdict === 'accepted' &&
    execution.acceptedCandidateSource === 'pi_agent_submit_result' &&
    nonEmptyString(rootRun.id) &&
    rootRun.status === 'candidate_complete' &&
    rootRun.requestId === execution.requestId &&
    execution.acceptedSourceRunId === rootRun.id &&
    execution.acceptedSourceRequestId === rootRun.requestId &&
    rootRun.tools?.submitResultSucceeded === 1 &&
    rootRun.tools?.failed === 0 &&
    rootRun.tools?.uncertain === 0 &&
    rootRun.tools?.unexpectedFailureCount === 0 &&
    execution.tools?.submitResultSucceeded === 1 &&
    execution.tools?.failed === 0 &&
    execution.tools?.uncertain === 0 &&
    execution.tools?.unexpectedFailureCount === 0 &&
    succeededToolNames(rootRun).includes('submit_result');
}

function customLaneCacheMissWithinContract(
  execution: ExecutionEvidenceLike,
  rootRun: RunEvidenceLike,
  budgets: CustomLaneBudgets,
): boolean {
  const cacheMissInputTokens = rootRun.usage?.cacheMissInputTokens;
  return nonNegativeInteger(cacheMissInputTokens) &&
    (cacheMissInputTokens <= budgets.maxCacheMissInputTokens ||
      acceptedTerminalOvershoot(execution, rootRun, budgets));
}

export function expectedExecutionLaneFailures(
  testCase: ExpectedLaneCaseLike,
  execution: ExecutionEvidenceLike | null | undefined,
  expectedRuntime: ExpectedRuntimeLike,
  customLaneBudgets: CustomLaneBudgets,
): string[] {
  const expectedLane = testCase.expectedExecutionLane;
  if (!expectedLane) return [];

  const runs = Array.isArray(execution?.runs)
    ? execution.runs.filter((run): run is RunEvidenceLike =>
      typeof run === 'object' && run !== null)
    : [];
  const rootRun = runs.find((run) => run.requestId === execution?.requestId);
  const rootToolNames = succeededToolNames(rootRun);

  if (expectedLane === 'deterministic_standard') {
    return execution?.provider === 'pi-agent-trusted-renderer' &&
      execution?.model === 'pi-agent-deterministic-renderer-v1' &&
      execution?.turns === 2 &&
      execution?.usage?.totalTokens === 0 &&
      execution?.usage?.inputTokens === 0 &&
      execution?.usage?.outputTokens === 0 &&
      execution?.usage?.cachedInputTokens === 0 &&
      execution?.usage?.cacheMissInputTokens === 0 &&
      execution?.usage?.reasoningTokens === 0 &&
      rootRun?.turns === 2 &&
      rootRun?.tools?.unexpectedFailureCount === 0 &&
      rootToolNames.includes('apply_dashboard_spec') &&
      rootToolNames.includes('submit_result')
      ? []
      : ['期望 deterministic_standard 零模型 Token 路径，但实际运行身份不匹配。'];
  }

  if (expectedLane === 'model_custom') {
    if (!execution || !rootRun) {
      return ['期望 model_custom PI Agent 模型路径，但实际运行身份不匹配。'];
    }
    return execution.provider === expectedRuntime.provider &&
      execution?.model === expectedRuntime.model &&
      positiveInteger(rootRun.turns) &&
      rootRun.turns <= customLaneBudgets.maxTurns &&
      nonNegativeInteger(rootRun.usage?.inputTokens) &&
      rootRun.usage.inputTokens <= customLaneBudgets.maxCumulativePreparedInputTokens &&
      nonNegativeInteger(rootRun.usage?.outputTokens) &&
      rootRun.usage.outputTokens <= customLaneBudgets.maxOutputTokens &&
      customLaneCacheMissWithinContract(execution, rootRun, customLaneBudgets) &&
      nonNegativeInteger(rootRun.tools?.total) &&
      rootRun.tools.total <= customLaneBudgets.maxToolCalls &&
      rootRun.tools?.unexpectedFailureCount === 0 &&
      rootToolNames.includes('semantic_edit') &&
      !rootToolNames.includes('quant_api_get') &&
      !rootToolNames.includes('apply_dashboard_spec')
      ? []
      : ['期望 model_custom PI Agent 模型路径，但实际运行身份不匹配。'];
  }

  return [`未知 expectedExecutionLane：${String(expectedLane as PiAgentExecutionLane)}`];
}
