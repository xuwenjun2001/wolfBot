import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { artifactDigest } from './artifact-store';
import { canonicalResearchJson, researchTaskSpecSchema, researchRequestHash, researchPlanSchema, assertPlanForSpec } from './task-contracts';
import { researchReportRevisionSchema, type ResearchVersionEvent } from './revision-contracts';
import { defaultResearchContext, assertActor, lockResearchTask, emitResearchEvent, taskSpec, ResearchPersistenceError, type ResearchRepositoryContext, type ResearchTaskRow } from './repository-core';

export async function createResearchTask(actor: string, input: unknown, requestKey: string, ctx = defaultResearchContext) {
  assertActor(actor); z.string().min(8).max(100).parse(requestKey);
  const spec = researchTaskSpecSchema.parse(input);
  if (spec.requestRevision !== 1) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Initial request revision must be 1');
  const hash = researchRequestHash(spec), id = randomUUID();
  const savedId = await ctx.db.$transaction(async tx => {
    const [task] = await tx.$queryRaw<ResearchTaskRow[]>`INSERT INTO company_research_tasks(id,actor_id,request_key,payload_hash)
      VALUES (${id},${actor},${requestKey},${hash}) ON CONFLICT(actor_id,request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *`;
    if (task.payload_hash !== hash) throw new ResearchPersistenceError('IDEMPOTENCY_CONFLICT');
    if (task.id === id) {
      await tx.$executeRaw`INSERT INTO company_research_requests(task_id,revision,payload_hash,spec) VALUES (${id},1,${hash},${JSON.stringify(spec)}::jsonb)`;
      await emitResearchEvent(tx, task, { type: 'task.created' });
    }
    return task.id;
  });
  return getResearchTask(actor, savedId, ctx);
}
export async function getResearchTask(actor: string, id: string, ctx = defaultResearchContext) {
  assertActor(actor);
  return ctx.db.$transaction(async tx => {
    const [task] = await tx.$queryRaw<ResearchTaskRow[]>`SELECT * FROM company_research_tasks WHERE id=${id} AND actor_id=${actor}`;
    if (!task) return null;
    const spec = await taskSpec(tx, task);
    const [plan] = task.plan_revision ? await tx.$queryRaw<{plan: unknown}[]>`SELECT plan FROM company_research_plans WHERE task_id=${id} AND revision=${task.plan_revision}` : [];
    return { id: task.id, status: task.status, requestRevision: task.request_revision, planRevision: task.plan_revision, reportRevision: task.report_revision,
      generation: task.generation, sequence: task.sequence, createdAt: task.created_at.toISOString(),
      usage: { toolCalls: task.tool_calls, inputTokens: task.input_tokens, outputTokens: task.output_tokens, unknownModelRequests: task.unknown_model_requests,
        startedAt: task.started_at?.toISOString() || null, deadline: task.deadline?.toISOString() || null }, spec,
      plan: plan ? researchPlanSchema.parse(plan.plan) : null };
  });
}
export async function appendResearchPlan(actor: string, id: string, expectedRevision: number, requestKey: string, input: unknown, ctx = defaultResearchContext) {
  z.number().int().min(0).parse(expectedRevision); z.string().min(8).max(100).parse(requestKey);
  const plan = researchPlanSchema.parse(input), hash = artifactDigest(canonicalResearchJson({ expectedRevision, plan }));
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, id);
    const [prior] = await tx.$queryRaw<{ payload_hash: string; plan: unknown }[]>`SELECT payload_hash,plan FROM company_research_plans WHERE task_id=${id} AND request_key=${requestKey}`;
    if (prior) { if (prior.payload_hash !== hash) throw new ResearchPersistenceError('IDEMPOTENCY_CONFLICT'); return researchPlanSchema.parse(prior.plan); }
    if (task.active_attempt_id || ['running','completed','cancelled'].includes(task.status)) throw new ResearchPersistenceError('TASK_ACTIVE');
    if (task.plan_revision !== expectedRevision || plan.revision !== expectedRevision + 1 || plan.taskId !== id) throw new ResearchPersistenceError('REVISION_CONFLICT');
    assertPlanForSpec(plan, await taskSpec(tx, task));
    await tx.$executeRaw`INSERT INTO company_research_plans(task_id,revision,request_revision,request_key,payload_hash,plan)
      VALUES (${id},${plan.revision},${plan.requestRevision},${requestKey},${hash},${JSON.stringify(plan)}::jsonb)`;
    await tx.$executeRaw`UPDATE company_research_tasks SET plan_revision=${plan.revision} WHERE id=${id}`;
    task.plan_revision = plan.revision;
    await emitResearchEvent(tx, task, { type: 'plan.created' });
    return plan;
  });
}
export async function getResearchReportRevision(actor: string, id: string, revision: number, ctx = defaultResearchContext) {
  assertActor(actor); z.number().int().min(1).parse(revision);
  const [row] = await ctx.db.$queryRaw<{report: unknown}[]>`SELECT r.report FROM company_research_report_versions r
    JOIN company_research_tasks t ON t.id=r.task_id WHERE t.actor_id=${actor} AND r.task_id=${id} AND r.revision=${revision}`;
  return row ? researchReportRevisionSchema.parse(row.report) : null;
}
export async function researchVersionEventsAfter(actor: string, id: string, after: number, ctx: ResearchRepositoryContext = defaultResearchContext) {
  assertActor(actor); z.number().int().min(0).parse(after);
  const rows = await ctx.db.$queryRaw<{payload: ResearchVersionEvent}[]>`SELECT e.payload FROM company_research_version_events e
    JOIN company_research_tasks t ON t.id=e.task_id WHERE t.actor_id=${actor} AND e.task_id=${id} AND e.sequence>${after} ORDER BY e.sequence LIMIT 100`;
  return rows.map(r => r.payload);
}
