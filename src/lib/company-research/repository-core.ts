import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { ResearchArtifactStore } from './artifact-store';
import { researchEventSchema, type ResearchVersionEvent } from './revision-contracts';
import { researchTaskSpecSchema } from './task-contracts';
import { ResearchPersistenceError } from './repository-errors';
export { ResearchPersistenceError } from './repository-errors';
export interface ResearchRepositoryContext { db: PrismaClient; artifacts: ResearchArtifactStore }
export const defaultResearchContext: ResearchRepositoryContext = { db: prisma, artifacts: new ResearchArtifactStore() };
export type ResearchTransaction = Prisma.TransactionClient;
export interface ResearchTaskRow {
  id: string; actor_id: string; payload_hash: string; status: string; request_revision: number; plan_revision: number; report_revision: number;
  generation: number; sequence: number; active_attempt_id: string | null; cancel_requested: boolean; tool_calls: number;
  input_tokens: number | null; output_tokens: number | null; unknown_model_requests: number;
  created_at: Date; started_at: Date | null; deadline: Date | null;
}
export function assertActor(actor: string) { if (!actor?.trim() || actor.length > 200) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Trusted actor required'); }
export async function lockResearchTask(tx: ResearchTransaction, actor: string, id: string) {
  assertActor(actor);
  const [task] = await tx.$queryRaw<ResearchTaskRow[]>`SELECT * FROM company_research_tasks WHERE id=${id} AND actor_id=${actor} FOR UPDATE`;
  if (!task) throw new ResearchPersistenceError('NOT_FOUND');
  return task;
}
export async function taskSpec(tx: ResearchTransaction, task: ResearchTaskRow) {
  const [request] = await tx.$queryRaw<{ spec: unknown }[]>`SELECT spec FROM company_research_requests WHERE task_id=${task.id} AND revision=${task.request_revision}`;
  if (!request) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Request snapshot missing');
  return researchTaskSpecSchema.parse(request.spec);
}
export async function emitResearchEvent(tx: ResearchTransaction, task: ResearchTaskRow, event: ResearchVersionEvent['event'], attemptId: string | null = null) {
  const [updated] = await tx.$queryRaw<{ sequence: number }[]>`UPDATE company_research_tasks SET sequence=sequence+1 WHERE id=${task.id} RETURNING sequence`;
  task.sequence = updated.sequence;
  const envelope = researchEventSchema.parse({ schemaVersion: 1, id: randomUUID(), taskId: task.id, sequence: task.sequence, at: new Date().toISOString(),
    requestRevision: task.request_revision, planRevision: task.plan_revision || null, reportRevision: task.report_revision || null, attemptId, generation: task.generation, event });
  await tx.$executeRaw`INSERT INTO company_research_version_events(task_id,sequence,payload) VALUES (${task.id},${task.sequence},${JSON.stringify(envelope)}::jsonb)`;
  return envelope;
}
