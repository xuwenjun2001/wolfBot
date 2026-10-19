import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executionAttemptSchema, type ResearchExecutionAttempt } from './task-contracts';
import { defaultResearchContext, lockResearchTask, taskSpec, emitResearchEvent, ResearchPersistenceError, type ResearchTaskRow, type ResearchTransaction } from './repository-core';

export type ResearchAttemptToken = Pick<ResearchExecutionAttempt, 'id' | 'taskId' | 'requestRevision' | 'planRevision' | 'generation' | 'worker'>;
export async function assertResearchAttempt(tx: ResearchTransaction, task: ResearchTaskRow, token: ResearchAttemptToken) {
  const [live] = await tx.$queryRaw<{id: string}[]>`SELECT id FROM company_research_attempts WHERE id=${token.id} AND task_id=${task.id}
    AND request_revision=${token.requestRevision} AND plan_revision=${token.planRevision} AND generation=${token.generation}
    AND worker=${token.worker} AND status='running' AND lease_until>clock_timestamp()`;
  if (!live || token.taskId !== task.id || task.status !== 'running' || task.cancel_requested || task.active_attempt_id !== token.id || task.generation !== token.generation || task.request_revision !== token.requestRevision || task.plan_revision !== token.planRevision) throw new ResearchPersistenceError('LEASE_LOST');
}
export async function startResearchAttempt(actor: string, id: string, expectedPlanRevision: number, worker: string, ctx = defaultResearchContext) {
  z.number().int().min(1).parse(expectedPlanRevision); z.string().min(1).max(200).parse(worker);
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, id);
    return startResearchAttemptInTransaction(tx, task, expectedPlanRevision, worker);
  });
}
export async function startResearchAttemptInTransaction(tx: ResearchTransaction, task: ResearchTaskRow, expectedPlanRevision: number, worker: string, allowExhausted = false) {
    z.string().min(1).max(200).parse(worker);
    const id = task.id, spec = await taskSpec(tx, task);
    if (task.cancel_requested || ['completed','cancelled'].includes(task.status)) throw new ResearchPersistenceError('LEASE_LOST');
    if (task.plan_revision !== expectedPlanRevision) throw new ResearchPersistenceError('REVISION_CONFLICT');
    const [{ now }] = await tx.$queryRaw<{now: Date}[]>`SELECT clock_timestamp() AS now`;
    const started = task.started_at || now, deadline = task.deadline || new Date(started.getTime() + spec.budget.timeoutMs);
    // Dispatch may take an exhausted stale attempt only to seal an honest partial report.
    if (!allowExhausted && (task.tool_calls >= spec.budget.maxToolCalls || deadline <= now)) throw new ResearchPersistenceError('BUDGET_EXHAUSTED');
    if (task.active_attempt_id) {
      const [prior] = await tx.$queryRaw<{lease_until: Date; status: string}[]>`SELECT lease_until,status FROM company_research_attempts WHERE id=${task.active_attempt_id} AND task_id=${id}`;
      if (prior?.status === 'running' && prior.lease_until > now) throw new ResearchPersistenceError('TASK_ACTIVE');
      if (prior?.status === 'running') {
        await tx.$executeRaw`UPDATE company_research_attempts SET status='superseded',finished_at=clock_timestamp() WHERE id=${task.active_attempt_id}`;
        await emitResearchEvent(tx, task, { type: 'attempt.finished', status: 'superseded' }, task.active_attempt_id);
      }
    }
    const attemptId = randomUUID(), generation = task.generation + 1, until = new Date(now.getTime() + 60000);
    await tx.$executeRaw`INSERT INTO company_research_attempts(id,task_id,request_revision,plan_revision,generation,worker,status,lease_until)
      VALUES (${attemptId},${id},${task.request_revision},${task.plan_revision},${generation},${worker},'running',${until})`;
    await tx.$executeRaw`UPDATE company_research_tasks SET status='running',generation=${generation},active_attempt_id=${attemptId},started_at=${started},deadline=${deadline} WHERE id=${id}`;
    task.generation = generation; task.active_attempt_id = attemptId; task.status = 'running';
    await emitResearchEvent(tx, task, { type: 'attempt.started' }, attemptId);
    return executionAttemptSchema.parse({ schemaVersion: 1, id: attemptId, taskId: id, requestRevision: task.request_revision, planRevision: task.plan_revision,
      generation, worker, status: 'running', leaseUntil: until.toISOString(), startedAt: now.toISOString(), finishedAt: null });
}
export async function heartbeatResearchAttempt(actor: string, token: ResearchAttemptToken, ctx = defaultResearchContext) {
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, token.taskId); await assertResearchAttempt(tx, task, token);
    const [row] = await tx.$queryRaw<{lease_until: Date}[]>`UPDATE company_research_attempts SET lease_until=clock_timestamp()+INTERVAL '60 seconds' WHERE id=${token.id} AND lease_until>clock_timestamp() AND status='running' RETURNING lease_until`;
    if (!row) throw new ResearchPersistenceError('LEASE_LOST');
    return row.lease_until.toISOString();
  });
}
/** Reserve before an external tool. A repeated call costs another slot, never free replay. */
export async function reserveResearchToolCall(actor: string, token: ResearchAttemptToken, ctx = defaultResearchContext) {
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, token.taskId); await assertResearchAttempt(tx, task, token);
    const spec = await taskSpec(tx, task);
    const [row] = await tx.$queryRaw<{tool_calls: number}[]>`UPDATE company_research_tasks SET tool_calls=tool_calls+1
      WHERE id=${task.id} AND tool_calls<${spec.budget.maxToolCalls} AND deadline>clock_timestamp()
        AND EXISTS (SELECT 1 FROM company_research_attempts WHERE id=${token.id} AND status='running' AND lease_until>clock_timestamp()) RETURNING tool_calls`;
    if (!row) throw new ResearchPersistenceError('BUDGET_EXHAUSTED');
    return row.tool_calls;
  });
}
export async function cancelResearchTask(actor: string, id: string, ctx = defaultResearchContext) {
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, id);
    if (['completed','partial','failed','cancelled'].includes(task.status) && !task.active_attempt_id) return;
    if (task.active_attempt_id) {
      await tx.$executeRaw`UPDATE company_research_attempts SET status='cancelled',finished_at=clock_timestamp() WHERE id=${task.active_attempt_id} AND status='running'`;
      await emitResearchEvent(tx, task, { type: 'attempt.finished', status: 'cancelled' }, task.active_attempt_id);
    }
    await tx.$executeRaw`UPDATE company_research_tasks SET status='cancelled',cancel_requested=true,generation=generation+1,active_attempt_id=NULL WHERE id=${id}`;
    task.generation++; await emitResearchEvent(tx, task, { type: 'task.cancelled' });
  });
}
