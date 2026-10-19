import { z } from 'zod';
import { artifactDigest } from './artifact-store';
import { documentAvailableAt, researchDocumentSchema } from './document-contracts';
import { checkpointSchema, initialFinancialPlan } from './execution-contracts';
import { buildResearchReportDiff, researchReportEvidenceHashes } from './report-diff';
import { researchReportDiffSchema, researchReportRevisionSchema } from './revision-contracts';
import { canonicalResearchJson, researchRequestHash, researchTaskSpecSchema, timestampSchema } from './task-contracts';
import { defaultResearchContext, assertActor, emitResearchEvent, lockResearchTask, taskSpec, ResearchPersistenceError, type ResearchRepositoryContext } from './repository-core';

const updateInputSchema = z.object({
  expectedRequestRevision: z.number().int().min(1), expectedPlanRevision: z.number().int().min(1), expectedReportRevision: z.number().int().min(1),
  asOf: timestampSchema,
}).strict();
export type ResearchReportHistoryEntry = { revision: number; requestRevision: number; planRevision: number; status: string; asOf: string; generatedAt: string; hash: string };

export async function listResearchReportHistory(actor: string, id: string, ctx = defaultResearchContext): Promise<ResearchReportHistoryEntry[]> {
  assertActor(actor);
  const rows = await ctx.db.$queryRaw<{report: unknown}[]>`SELECT v.report FROM company_research_report_versions v
    JOIN company_research_tasks t ON t.id=v.task_id WHERE t.actor_id=${actor} AND v.task_id=${id} ORDER BY v.revision DESC LIMIT 50`;
  return rows.map(row => {
    const report = researchReportRevisionSchema.parse(row.report);
    return { revision: report.revision, requestRevision: report.requestRevision, planRevision: report.planRevision, status: report.status,
      asOf: report.asOf, generatedAt: report.generatedAt, hash: artifactDigest(canonicalResearchJson(report)) };
  }).reverse();
}

export async function getResearchReportSnapshot(actor: string, id: string, revision: number, ctx = defaultResearchContext) {
  assertActor(actor); z.number().int().min(1).parse(revision);
  const [row] = await ctx.db.$queryRaw<{report: unknown; spec: unknown}[]>`SELECT v.report,r.spec FROM company_research_report_versions v
    JOIN company_research_tasks t ON t.id=v.task_id JOIN company_research_requests r ON r.task_id=v.task_id AND r.revision=v.request_revision
    WHERE t.actor_id=${actor} AND v.task_id=${id} AND v.revision=${revision}`;
  return row ? { report: researchReportRevisionSchema.parse(row.report), spec: researchTaskSpecSchema.parse(row.spec) } : null;
}

export async function getResearchReportDiff(actor: string, id: string, revision: number, ctx = defaultResearchContext) {
  assertActor(actor); z.number().int().min(2).parse(revision);
  const rows = await ctx.db.$queryRaw<{report: unknown}[]>`SELECT v.report FROM company_research_report_versions v
    JOIN company_research_tasks t ON t.id=v.task_id WHERE t.actor_id=${actor} AND v.task_id=${id} AND v.revision IN (${revision - 1},${revision}) ORDER BY v.revision`;
  if (rows.length !== 2) return null;
  return researchReportDiffSchema.parse(buildResearchReportDiff(researchReportRevisionSchema.parse(rows[0].report), researchReportRevisionSchema.parse(rows[1].report)));
}

export async function queueResearchReportUpdate(actor: string, id: string, key: string, input: unknown, ctx = defaultResearchContext) {
  assertActor(actor); z.string().min(8).max(100).parse(key);
  const parsed = updateInputSchema.parse(input), payloadHash = artifactDigest(canonicalResearchJson(parsed));
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, id);
    const [prior] = await tx.$queryRaw<{payload_hash: string; revision: number; request_revision: number}[]>`SELECT payload_hash,revision,request_revision FROM company_research_plans WHERE task_id=${id} AND request_key=${key}`;
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new ResearchPersistenceError('IDEMPOTENCY_CONFLICT');
      return { queued: true as const, idempotent: true, requestRevision: prior.request_revision, planRevision: prior.revision };
    }
    if (task.cancel_requested || task.active_attempt_id || !['completed', 'partial', 'failed'].includes(task.status)) throw new ResearchPersistenceError('TASK_ACTIVE');
    if (task.request_revision !== parsed.expectedRequestRevision || task.plan_revision !== parsed.expectedPlanRevision || task.report_revision !== parsed.expectedReportRevision) throw new ResearchPersistenceError('REVISION_CONFLICT');

    const [oldRow] = await tx.$queryRaw<{report: unknown}[]>`SELECT report FROM company_research_report_versions WHERE task_id=${id} AND revision=${task.report_revision}`;
    if (!oldRow) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Current report snapshot missing');
    const oldReport = researchReportRevisionSchema.parse(oldRow.report);
    if (oldReport.requestRevision !== task.request_revision) throw new ResearchPersistenceError('REVISION_CONFLICT');
    const currentSpec = await taskSpec(tx, task), requestedAsOf = new Date(parsed.asOf), now = Date.now();
    if (requestedAsOf.getTime() < new Date(currentSpec.asOf).getTime() || requestedAsOf.getTime() > now) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Update cutoff must be between the current cutoff and now');
    if (requestedAsOf.getTime() < new Date(oldReport.asOf).getTime()) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Update cutoff cannot precede the previous report');

    const documentRows = await tx.$queryRaw<{metadata: unknown}[]>`SELECT metadata FROM company_research_documents WHERE task_id=${id}`;
    const documents = documentRows.map(row => researchDocumentSchema.parse(row.metadata));
    const priorHashes = researchReportEvidenceHashes(oldReport);
    const priorAsOf = Date.parse(oldReport.asOf);
    const newDocuments = documents.filter(document => !priorHashes.has(document.bytesSha256)
      && documentAvailableAt(document, parsed.asOf) && ['acquired', 'parse_pending', 'ready', 'partial'].includes(document.state)
      && (Date.parse(document.fetchedAt) > Date.parse(oldReport.generatedAt)
        || document.disclosure.status === 'verified' && document.disclosure.precision === 'date' && Date.parse(`${document.disclosure.on}T23:59:59.999+08:00`) > priorAsOf
        || document.disclosure.status === 'verified' && document.disclosure.precision === 'instant' && Date.parse(document.disclosure.at) > priorAsOf));
    if (!newDocuments.length) return { queued: false as const, reason: 'no_new_evidence' as const };

    const requestRevision = requestedAsOf.getTime() === new Date(currentSpec.asOf).getTime() ? currentSpec.requestRevision : currentSpec.requestRevision + 1;
    const spec = researchTaskSpecSchema.parse({ ...currentSpec, asOf: parsed.asOf, requestRevision });
    const plan = { ...initialFinancialPlan(id, spec), revision: task.plan_revision + 1 };
    if (requestRevision !== currentSpec.requestRevision) {
      await tx.$executeRaw`INSERT INTO company_research_requests(task_id,revision,payload_hash,spec)
        VALUES (${id},${requestRevision},${researchRequestHash(spec)},${JSON.stringify(spec)}::jsonb)`;
    }
    await tx.$executeRaw`INSERT INTO company_research_plans(task_id,revision,request_revision,request_key,payload_hash,plan)
      VALUES (${id},${plan.revision},${requestRevision},${key},${payloadHash},${JSON.stringify(plan)}::jsonb)`;

    const affectedPeriods = [...new Set(newDocuments.map(document => document.period.id))].sort();
    const affectedPeriodSet = new Set(affectedPeriods), removedFactIds = new Set(oldReport.facts.filter(fact => affectedPeriodSet.has(fact.period.id)).map(fact => fact.id));
    const documentPeriods = new Map(documents.map(document => [`${document.id}:${document.version}`, document.period.id]));
    const affectedClaims = oldReport.claims.filter(claim => claim.factIds.some(factId => removedFactIds.has(factId))
      || claim.citations.some(citation => affectedPeriodSet.has(documentPeriods.get(`${citation.documentId}:${citation.documentVersion}`) || ''))
      || affectedPeriodSet.size > 0 && (claim.questionId === 'income_profit' || claim.questionId === 'cash_flow'));
    const affectedClaimIds = new Set(affectedClaims.map(claim => claim.id));
    const retainedFacts = oldReport.facts.filter(fact => !affectedPeriodSet.has(fact.period.id));
    const retainedClaims = oldReport.claims.filter(claim => !affectedClaimIds.has(claim.id));
    const affectedQuestions = new Set(affectedClaims.map(claim => claim.questionId));
    if (affectedPeriods.length) { affectedQuestions.add('income_profit'); affectedQuestions.add('cash_flow'); }
    const steps = Object.fromEntries(spec.questions.flatMap(question => {
      const state = affectedQuestions.has(question.id) ? 'pending' : 'completed';
      return [[`${question.id}-retrieve`, state], [`${question.id}-compare`, state], [`${question.id}-verify`, 'pending'], [`${question.id}-report`, 'pending']];
    }));
    const checkpoint = checkpointSchema.parse({ schemaVersion: 1, requestRevision, planRevision: plan.revision, phase: 'researching',
      facts: retainedFacts, claims: retainedClaims, observations: [{ tool: 'update', key: payloadHash,
        summary: canonicalResearchJson({ sourceHashes: [...new Set(newDocuments.map(document => document.bytesSha256))], affectedPeriods, invalidatedClaimIds: [...affectedClaimIds], asOf: parsed.asOf }) }],
      steps, stalledCalls: 0, stopReason: null, submitted: false, checkedHash: null, lastCallKey: null, lastEvidenceHash: null });
    const generation = task.generation + 1;
    await tx.$executeRaw`UPDATE company_research_tasks SET request_revision=${requestRevision},plan_revision=${plan.revision},status='queued',
      generation=${generation},active_attempt_id=NULL,checkpoint=${JSON.stringify(checkpoint)}::jsonb WHERE id=${id}`;
    task.request_revision = requestRevision; task.plan_revision = plan.revision; task.status = 'queued'; task.generation = generation; task.active_attempt_id = null;
    await emitResearchEvent(tx, task, { type: 'report.update.queued', fromReportRevision: oldReport.revision,
      sourceHashes: [...new Set(newDocuments.map(document => document.bytesSha256))], affectedPeriods });
    await emitResearchEvent(tx, task, { type: 'plan.created' });
    await emitResearchEvent(tx, task, { type: 'task.queued' });
    return { queued: true as const, idempotent: false, requestRevision, planRevision: plan.revision,
      affectedPeriods, sourceHashes: [...new Set(newDocuments.map(document => document.bytesSha256))] };
  }, { timeout: 20000 });
}
