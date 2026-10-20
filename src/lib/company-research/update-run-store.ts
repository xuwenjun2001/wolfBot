import { assertResearchAttempt, type ResearchAttemptToken } from './attempt-store';
import { defaultResearchContext, lockResearchTask, type ResearchTaskRow, type ResearchTransaction } from './repository-core';
import type { ResearchTaskSpec } from './task-contracts';

/** Called under the task lock, once per genuinely new evidence update, never on retry/recovery/revision. */
export async function openResearchUpdateBudget(tx: ResearchTransaction, task: ResearchTaskRow, spec: ResearchTaskSpec) {
  const snapshot = { requestRevision: task.request_revision, planRevision: task.plan_revision, reportRevision: task.report_revision,
    budget: spec.budget, toolCalls: task.tool_calls - task.budget_tool_base,
    cumulative: { toolCalls: task.tool_calls, inputTokens: task.input_tokens, outputTokens: task.output_tokens, unknownModelRequests: task.unknown_model_requests },
    startedAt: task.started_at?.toISOString() || null, deadline: task.deadline?.toISOString() || null };
  await tx.$executeRaw`INSERT INTO company_research_budget_history(task_id,revision,snapshot)
    VALUES (${task.id},${task.budget_revision},${JSON.stringify(snapshot)}::jsonb)`;
  await tx.$executeRaw`UPDATE company_research_tasks SET budget_revision=budget_revision+1,budget_tool_base=tool_calls,started_at=NULL,deadline=NULL WHERE id=${task.id}`;
  task.budget_revision++; task.budget_tool_base = task.tool_calls; task.started_at = null; task.deadline = null;
}

/** Only the fenced tool that returned actual source text may record a read. Reads alone do not finish a check. */
export async function recordResearchUpdateRead(actor: string, token: ResearchAttemptToken, sourceHash: string, ctx = defaultResearchContext) {
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, token.taskId); await assertResearchAttempt(tx, task, token);
    await tx.$executeRaw`UPDATE company_research_update_sources SET read_at=clock_timestamp()
      WHERE task_id=${task.id} AND budget_revision=${task.budget_revision} AND source_hash=${sourceHash} AND checked_at IS NULL`;
  });
}
