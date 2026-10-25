import { z } from 'zod';
import { canonicalResearchJson } from './task-contracts';
import { artifactDigest } from './artifact-store';
import { checkpointSchema, initialFinancialPlan, type ResearchCheckpoint } from './execution-contracts';
import { startResearchAttemptInTransaction, assertResearchAttempt, type ResearchAttemptToken } from './attempt-store';
import { defaultResearchContext, assertActor, lockResearchTask, emitResearchEvent, taskSpec, ResearchPersistenceError, type ResearchTaskRow } from './repository-core';

export async function queueFinancialResearch(actor: string, id: string, expectedPlanRevision: number, ctx = defaultResearchContext) {
  z.number().int().min(0).parse(expectedPlanRevision);
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, id);
    if (['queued', 'running'].includes(task.status) && (expectedPlanRevision === task.plan_revision || expectedPlanRevision === 0 && task.plan_revision === 1)) return;
    if (task.status !== 'draft' || task.plan_revision !== expectedPlanRevision) throw new ResearchPersistenceError('REVISION_CONFLICT');
    if (!task.plan_revision) {
      const plan = initialFinancialPlan(id, await taskSpec(tx, task));
      await tx.$executeRaw`INSERT INTO company_research_plans(task_id,revision,request_revision,request_key,payload_hash,plan)
        VALUES (${id},1,${task.request_revision},'initial-financial-plan',${artifactDigest(canonicalResearchJson(plan))},${JSON.stringify(plan)}::jsonb)`;
      await tx.$executeRaw`UPDATE company_research_tasks SET plan_revision=1 WHERE id=${id}`;
      task.plan_revision = 1; await emitResearchEvent(tx, task, { type: 'plan.created' });
    }
    await tx.$executeRaw`UPDATE company_research_tasks SET status='queued' WHERE id=${id}`;
    await emitResearchEvent(tx, task, { type: 'task.queued' });
  });
}
export async function claimFinancialResearch(worker: string, ctx = defaultResearchContext) {
  return ctx.db.$transaction(async tx => {
    const [task] = await tx.$queryRaw<ResearchTaskRow[]>`SELECT t.* FROM company_research_tasks t
      LEFT JOIN company_research_attempts a ON a.id=t.active_attempt_id
      WHERE t.plan_revision>0 AND t.cancel_requested=false AND (t.status='queued' OR (t.status='running' AND (a.id IS NULL OR a.lease_until<=clock_timestamp())))
      ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1`;
    if (!task) return null;
    const attempt = await startResearchAttemptInTransaction(tx, task, task.plan_revision, worker, true);
    return { actor: task.actor_id, attempt };
  });
}
export type FinancialPlanRevisionEvent = { planVersion: number; reason: string; affectedNodeIds: string[]; retainedNodeIds: string[] };
function boundCheckpoint(input: ResearchCheckpoint, token: ResearchAttemptToken) {
  const checkpoint = checkpointSchema.parse(input);
  if (checkpoint.requestRevision !== token.requestRevision || checkpoint.planRevision !== token.planRevision || JSON.stringify(checkpoint).length > 160000) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Checkpoint binding/size');
  return checkpoint;
}
function assertCheckpointTransition(previous: ResearchCheckpoint | null, checkpoint: ResearchCheckpoint, token: ResearchAttemptToken, revision?: FinancialPlanRevisionEvent) {
  if (previous?.schemaVersion === 2 && (checkpoint.schemaVersion !== 2 || checkpoint.variant !== previous.variant)) {
    throw new ResearchPersistenceError('INVALID_RESEARCH', 'Checkpoint scheduler binding');
  }
  if (checkpoint.schemaVersion === 2) {
    const previousVersion = previous?.schemaVersion === 2 ? previous.planVersion : token.planRevision;
    if (checkpoint.planVersion !== previousVersion + (revision ? 1 : 0)) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Local plan revision binding');
  }
  if (revision) {
    const ids = new Set(checkpoint.schemaVersion === 2 ? Object.keys(checkpoint.nodes) : []);
    if (checkpoint.schemaVersion !== 2 || checkpoint.planVersion !== revision.planVersion
      || [...revision.affectedNodeIds, ...revision.retainedNodeIds].some(id => !ids.has(id))
      || new Set([...revision.affectedNodeIds, ...revision.retainedNodeIds]).size !== revision.affectedNodeIds.length + revision.retainedNodeIds.length) {
      throw new ResearchPersistenceError('INVALID_RESEARCH', 'Local plan revision binding');
    }
  }
  if ((checkpoint.modelTurns || 0) < (previous?.modelTurns || 0)) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Model round count cannot decrease');
}
export async function saveResearchCheckpoint(actor: string, token: ResearchAttemptToken, input: ResearchCheckpoint, tool?: string, ctx = defaultResearchContext, revision?: FinancialPlanRevisionEvent) {
  const checkpoint = boundCheckpoint(input, token);
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, token.taskId); await assertResearchAttempt(tx, task, token);
    const previous = task.checkpoint ? checkpointSchema.parse(task.checkpoint) : null;
    assertCheckpointTransition(previous, checkpoint, token, revision);
    await tx.$executeRaw`UPDATE company_research_tasks SET checkpoint=${JSON.stringify(checkpoint)}::jsonb WHERE id=${task.id}`;
    if (revision) await emitResearchEvent(tx, task, { type: 'plan.revised', ...revision }, token.id);
    await emitResearchEvent(tx, task, { type: 'research.progress', phase: checkpoint.phase, tool: tool?.slice(0, 80) || null, message: checkpoint.stopReason || '已保存公开研究状态' }, token.id);
  });
}
/** Reserve before the request, including failed/aborted requests. Unresolved usage stays unknown across takeover. */
export async function reserveResearchModelRequest(actor: string, token: ResearchAttemptToken, ctx = defaultResearchContext, generationCheckpoint?: ResearchCheckpoint) {
  const checkpoint = generationCheckpoint ? boundCheckpoint(generationCheckpoint, token) : null;
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, token.taskId); await assertResearchAttempt(tx, task, token);
    const previous = task.checkpoint ? checkpointSchema.parse(task.checkpoint) : null;
    const modelTurns = (previous?.modelTurns || 0) + (checkpoint ? 1 : 0);
    if (checkpoint) {
      assertCheckpointTransition(previous, checkpoint, token);
      const next = boundCheckpoint({ ...checkpoint, modelTurns }, token);
      await tx.$executeRaw`UPDATE company_research_tasks SET checkpoint=${JSON.stringify(next)}::jsonb,unknown_model_requests=unknown_model_requests+1 WHERE id=${task.id}`;
    } else await tx.$executeRaw`UPDATE company_research_tasks SET unknown_model_requests=unknown_model_requests+1 WHERE id=${task.id}`;
    return modelTurns;
  });
}
export async function settleResearchModelUsage(actor: string, token: ResearchAttemptToken, input: number, output: number, estimated: boolean, ctx = defaultResearchContext) {
  z.number().int().min(0).parse(input); z.number().int().min(0).parse(output);
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, token.taskId); await assertResearchAttempt(tx, task, token);
    await tx.$executeRaw`UPDATE company_research_tasks SET input_tokens=COALESCE(input_tokens,0)+${input},output_tokens=COALESCE(output_tokens,0)+${output},
      unknown_model_requests=GREATEST(0,unknown_model_requests-${estimated ? 0 : 1}) WHERE id=${task.id}`;
  });
}
export async function listFinancialResearchTasks(actor: string, ctx = defaultResearchContext) {
  assertActor(actor);
  return ctx.db.$queryRaw<{id: string; status: string; spec: unknown; createdAt: Date}[]>`SELECT t.id,t.status,r.spec,t.created_at AS "createdAt"
    FROM company_research_tasks t JOIN company_research_requests r ON r.task_id=t.id AND r.revision=t.request_revision
    WHERE t.actor_id=${actor} ORDER BY t.created_at DESC LIMIT 30`;
}
