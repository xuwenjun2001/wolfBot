import { PiAgentRunEngine } from '@/lib/agent/pi/run-engine';
import { PiAgentContextManager, PiAgentContextError } from '@/lib/agent/context';
import type { PiAgentEvent, PiAgentModelProvider } from '@/lib/agent/types';
import { createResearchProvider } from './provider';
import { researchConfig, safeError } from './config';
import { checkpointSchema, emptyCheckpoint, financialResearchPrompt, researchSkillVersion, type FinancialResearchSkill } from './execution-contracts';
import { financialResearchTools, checkpointEvidenceHash } from './financial-tools';
import { artifactDigest } from './artifact-store';
import { canonicalResearchJson } from './task-contracts';
import { financialObservation, financialContextState, financialChangeSummary, nextFinancialAction } from './financial-observation';
import { getResearchTask } from './version-store';
import { heartbeatResearchAttempt, reserveResearchToolCall, type ResearchAttemptToken } from './attempt-store';
import { reserveResearchModelRequest, saveResearchCheckpoint, settleResearchModelUsage } from './execution-store';
import { assembleFinancialReport, financialChanges } from './report-assembly';
import { readClaimReviews } from './verification-service';
import { commitResearchReport } from './report-store';
import { defaultResearchContext, ResearchPersistenceError } from './repository-core';
import { researchObserver, researchToolStage, type ResearchObservationSink } from './observability';

/** Optional diagnostic sink contains tool data only, never model reasoning or credentials. */
export type FinancialExecutionTrace = { at: string; type: 'tool_calls' | 'tool_result' | 'tool_feedback'; data: unknown };
export async function executeFinancialResearch(actor: string, token: ResearchAttemptToken, shutdown?: AbortSignal, ctx = defaultResearchContext, testProvider?: PiAgentModelProvider, fixedDocuments = false, trace?: (record: FinancialExecutionTrace) => Promise<void>, observationSink?: ResearchObservationSink, skill: FinancialResearchSkill = { version: researchSkillVersion, prompt: financialResearchPrompt }) {
  const task = await getResearchTask(actor, token.taskId, ctx);
  if (!task || task.status !== 'running' || task.generation !== token.generation || !task.plan) return;
  const config = researchConfig(), state = task.checkpoint ? checkpointSchema.parse(task.checkpoint) : emptyCheckpoint(token.requestRevision, token.planRevision);
  const observer = researchObserver(token, task.reportRevision, observationSink);
  let outcome = 'interrupted', deliveredRevision = task.reportRevision;
  observer.emit('attempt.started', { stage: 'worker', pid: process.pid, rssBytes: process.memoryUsage().rss, toolCalls: task.usage.toolCalls,
    unknownModelRequests: task.usage.unknownModelRequests });
  if (state.requestRevision !== token.requestRevision || state.planRevision !== token.planRevision) throw new Error('Checkpoint version mismatch');
  const controller = new AbortController(), signal = shutdown ? AbortSignal.any([controller.signal, shutdown]) : controller.signal;
  const deadline = Date.parse(task.usage.deadline!), remaining = Math.max(0, deadline - Date.now());
  let calls = task.usage.toolCalls, heartbeatBusy = false, materializedCallId: string | null = null;
  const save = (tool: string) => saveResearchCheckpoint(actor, token, state, tool, ctx);
  const heartbeatTimer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void heartbeatResearchAttempt(actor, token, ctx).catch(() => { observer.emit('attempt.fenced', { stage: 'worker', outcome: 'lease_lost_or_cancelled' }); controller.abort(new Error('执行权失效或已取消')); }).finally(() => { heartbeatBusy = false; });
  }, 10000);
  heartbeatTimer.unref();
  const deadlineTimer = setTimeout(() => { state.stopReason = '已达到任务原始截止时间'; observer.emit('attempt.deadline', { stage: 'worker' }); controller.abort(new Error(state.stopReason)); }, Math.max(1, remaining)); deadlineTimer.unref();
  const charged = new Set<string>();
  const onEvent = async (event: PiAgentEvent) => {
    if (event.type === 'assistant_message' && event.message.toolCalls?.length) await trace?.({ at: new Date().toISOString(), type: 'tool_calls', data: event.message.toolCalls });
    if (event.type === 'assistant_message') for (const call of event.message.toolCalls || []) {
      if (!charged.has(call.id)) { calls = await reserveResearchToolCall(actor, token, ctx); charged.add(call.id); }
      const key = artifactDigest(canonicalResearchJson({ tool: call.name, arguments: call.arguments })), evidenceHash = checkpointEvidenceHash(state);
      state.stalledCalls = key === state.lastCallKey && evidenceHash === state.lastEvidenceHash ? Math.min(100, state.stalledCalls + 1) : 0;
      state.lastCallKey = key; state.lastEvidenceHash = evidenceHash;
      if (state.stalledCalls >= 4) state.stopReason = '连续四次重复调用没有新证据，已停止补查';
      await save(call.name);
    }
    if (event.type === 'tool_started') {
      await heartbeatResearchAttempt(actor, token, ctx);
      observer.emit('tool.started', { stage: researchToolStage(event.toolCall.name), tool: event.toolCall.name });
    }
    if (event.type === 'tool_failed' || event.type === 'tool_completed') {
      materializedCallId = event.type === 'tool_completed' ? event.toolCall.id : null;
      observer.emit('tool.finished', { stage: researchToolStage(event.toolCall.name), tool: event.toolCall.name,
        outcome: event.result.ok ? 'succeeded' : 'failed', durationMs: event.durationMs });
      await trace?.({ at: new Date().toISOString(), type: 'tool_result', data: { toolCall: event.toolCall, result: event.result, durationMs: event.durationMs } });
      const key = artifactDigest(canonicalResearchJson({ tool: event.toolCall.name, result: event.result }));
      state.observations = [...state.observations.filter(o => o.key !== key), { tool: event.toolCall.name, key, summary: event.result.ok ? financialObservation(event.toolCall.name, event.result.data) : safeError(new Error(event.result.error.message)) }].slice(-8);
      await save(event.toolCall.name);
    }
    if (state.stopReason) controller.abort(new Error(state.stopReason));
  };
  try {
    await heartbeatResearchAttempt(actor, token, ctx);
    if (!state.submitted && !state.stopReason && remaining > 0 && calls < task.spec.budget.maxToolCalls) {
      const source = testProvider || createResearchProvider(
        () => `剩余工具 ${task.spec.budget.maxToolCalls - calls}；剩余秒 ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}；先保存事实和三问结论，逐条 verify_claim，然后 check_coverage 与 submit_report。`,
        () => state.checkedHash && state.phase === 'ready' ? 'submit_report' : task.spec.budget.maxToolCalls - calls <= 2 ? state.checkedHash ? 'submit_report' : 'check_coverage' : undefined,
      );
      const provider: PiAgentModelProvider = { name: source.name, async *complete(request) {
        await trace?.({ at: new Date().toISOString(), type: 'tool_feedback', data: request.messages.filter(m => m.role === 'tool') });
        signal.throwIfAborted(); await reserveResearchModelRequest(actor, token, ctx);
        const started = performance.now();
        observer.emit('model.started', { stage: 'model', usageKnown: false });
        let usage: {inputTokens: number; outputTokens: number; usageSource?: string} | undefined;
        try {
          for await (const event of source.complete(request)) { if (event.type === 'usage') usage = event.usage; yield event; }
        } finally {
          if (usage) await settleResearchModelUsage(actor, token, usage.inputTokens, usage.outputTokens, usage.usageSource === 'estimated' || usage.usageSource === 'mixed', ctx);
          observer.emit('model.finished', { stage: 'model', durationMs: Math.round(performance.now() - started), usageKnown: !!usage,
            ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}) });
        }
      } };
      const manager = new PiAgentContextManager({ contextWindowTokens: 128000, reservedOutputTokens: 6000, maxInputTokens: 32000 });
      const engine = new PiAgentRunEngine({ provider, model: config.model, tools: financialResearchTools(actor, token, task.spec, state, config.model, save, ctx, fixedDocuments, skill),
        requireWorkspaceWriteBeforeTerminal: false, requireTerminalTool: true, maxTurns: task.spec.budget.maxToolCalls - calls + 1,
        maxTotalToolCalls: task.spec.budget.maxToolCalls - calls, maxToolCallsPerTurn: 1, maxTokens: Number.MAX_SAFE_INTEGER, maxTokensPerTurn: 6000,
        timeoutMs: remaining, eventHandlerTimeoutMs: 20000, preWriteReadOnlyTurnThreshold: Number.MAX_SAFE_INTEGER, postWriteReadOnlyTurnThreshold: Number.MAX_SAFE_INTEGER, progressStallTurns: Number.MAX_SAFE_INTEGER,
        contextManager: { prepare(messages, tools) {
          const index = messages.findLastIndex(m => m.role === 'assistant' && !!m.toolCalls?.length);
          const active = index >= 0 ? messages[index] : undefined;
          const representedInState = active?.role === 'assistant' && active.toolCalls?.every(c => c.id === materializedCallId && ['record_fact', 'record_claim', 'verify_claim', 'check_coverage'].includes(c.name));
          const prepare = (compact: boolean) => manager.prepare([
            { role: 'system', content: skill.prompt },
            { role: 'user', content: JSON.stringify({ spec: task.spec, plan: task.plan?.steps.map(({id, questionId, kind}) => ({id, questionId, kind})),
              documents: task.documents.map(({id, version, period, state, bytesSha256, disclosure}) => ({id, version, period, state, bytesSha256, disclosure})),
              changes: financialChangeSummary(financialChanges({ facts: state.facts, periodIds: [task.spec.periods[0].id, task.spec.periods[1].id] })),
              checkpoint: financialContextState(state, compact), nextAction: nextFinancialAction(task.spec, state), remainingCalls: task.spec.budget.maxToolCalls - calls }) },
            ...(index >= 0 && !representedInState ? messages.slice(index) : []),
          ], tools, { inputBudgetTokens: 32000 });
          try { return prepare(false); }
          catch (error) { if (!(error instanceof PiAgentContextError) || error.code !== 'CONTEXT_BUDGET_EXCEEDED') throw error; return prepare(true); }
        } },
      });
      const result = await engine.run({ runId: token.id, signal, reasoning: { enabled: true, effort: config.reasoning }, messages: [{ role: 'system', content: skill.prompt }, { role: 'user', content: JSON.stringify(task.spec) }] }, { durableSink: onEvent });
      if (!state.submitted && !state.stopReason) state.stopReason = safeError(new Error(result.error?.message || `研究提前停止：${result.status}`));
    } else if (!state.submitted && !state.stopReason) state.stopReason = remaining <= 0 ? '已达到任务原始截止时间' : '工具调用预算已耗尽';
    if (shutdown?.aborted) { outcome = 'shutdown'; return; } // Lease expires; the next attempt reconstructs only public state.
    await heartbeatResearchAttempt(actor, token, ctx);
    await save('finalize');
    const report = assembleFinancialReport(token.taskId, task.spec, token.planRevision, task.reportRevision + 1, state, config.model, await readClaimReviews(actor, token.taskId, ctx), skill);
    const committed = await commitResearchReport(actor, token, task.reportRevision, report, ctx);
    outcome = committed.status; deliveredRevision = committed.revision;
    observer.reportCommitted(deliveredRevision, outcome);
    return committed;
  } catch (error) {
    if (shutdown?.aborted || error instanceof ResearchPersistenceError && error.code === 'LEASE_LOST') { outcome = shutdown?.aborted ? 'shutdown' : 'fenced'; return; }
    state.stopReason = safeError(error);
    try {
      await heartbeatResearchAttempt(actor, token, ctx); await save('interrupted');
      const committed = await commitResearchReport(actor, token, task.reportRevision, assembleFinancialReport(token.taskId, task.spec, token.planRevision, task.reportRevision + 1, state, config.model, await readClaimReviews(actor, token.taskId, ctx), skill), ctx);
      outcome = committed.status; deliveredRevision = committed.revision;
      observer.reportCommitted(deliveredRevision, outcome);
      return committed;
    } catch (publishError) {
      if (publishError instanceof ResearchPersistenceError && publishError.code === 'LEASE_LOST') { outcome = 'fenced'; return; }
      throw publishError;
    }
  } finally { clearInterval(heartbeatTimer); clearTimeout(deadlineTimer); observer.finish(outcome, deliveredRevision); }
}
