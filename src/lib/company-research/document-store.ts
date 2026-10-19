import { z } from 'zod';
import { parsedReceiptSchema } from './parsed-document';
import { artifactDigest } from './artifact-store';
import { researchDocumentSchema, type ResearchDocument } from './document-contracts';
import { canonicalResearchJson } from './task-contracts';
import { isResearchEvidencePeriod } from './evidence-periods';
import { assertResearchAttempt, type ResearchAttemptToken } from './attempt-store';
import { defaultResearchContext, lockResearchTask, taskSpec, emitResearchEvent, assertActor, ResearchPersistenceError } from './repository-core';

// v1 stays readable. v2 binds page/block/table output to original bytes and parser configuration.
export const parsedPageReceiptSchema = parsedReceiptSchema;
export async function registerResearchDocument(actor: string, input: unknown, original: Buffer, parsed?: Buffer, ctx = defaultResearchContext, attempt?: ResearchAttemptToken) {
  const document = researchDocumentSchema.parse(input);
  if (artifactDigest(original) !== document.original.sha256 || original.length !== document.original.byteLength || (document.mediaType === 'application/pdf' && original.subarray(0, 5).toString() !== '%PDF-')) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Original content mismatch');
  if (!!document.parsed !== !!parsed || (parsed && (artifactDigest(parsed) !== document.parsed!.sha256 || parsed.length !== document.parsed!.byteLength))) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Parsed content mismatch');
  if (parsed) {
    const receipt = parsedPageReceiptSchema.parse(JSON.parse(parsed.toString('utf8')));
    if (!document.parser || !document.pageCount || receipt.pages.some(p => p.filePage > document.pageCount!)) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Parsed page metadata missing/invalid');
    if (receipt.schemaVersion === 2 && (receipt.originalSha256 !== document.bytesSha256 || receipt.pageCount !== document.pageCount || receipt.mediaType !== document.mediaType || receipt.status !== document.state || receipt.parser.name !== document.parser.name || receipt.parser.version !== document.parser.version || canonicalResearchJson(receipt.failedPages) !== canonicalResearchJson(document.parser.failedPages))) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Parsed receipt binding mismatch');
  }
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, document.taskId), spec = await taskSpec(tx, task);
    if (attempt) await assertResearchAttempt(tx, task, attempt);
    if (document.provenance?.evidence) {
      await ctx.artifacts.read(actor, document.provenance.evidence);
      if (document.disclosure.status === 'verified' && document.disclosure.evidenceSha256 !== document.provenance.evidence.sha256) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Disclosure evidence hash mismatch');
    }
    if (document.company.symbol !== spec.company.symbol || !isResearchEvidencePeriod(spec, document.period)) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Document task/company/period mismatch');
    const [prior] = await tx.$queryRaw<{metadata: unknown}[]>`SELECT metadata FROM company_research_documents WHERE task_id=${task.id} AND id=${document.id} AND version=${document.version}`;
    if (prior) {
      if (canonicalResearchJson(prior.metadata) !== canonicalResearchJson(document)) throw new ResearchPersistenceError('REVISION_CONFLICT');
      // An idempotent retry also checks that retained objects remain intact.
      await ctx.artifacts.read(actor, document.original); if (document.parsed) await ctx.artifacts.read(actor, document.parsed);
      return document;
    }
    const [latest] = await tx.$queryRaw<{version: number}[]>`SELECT version FROM company_research_documents WHERE task_id=${task.id} AND id=${document.id} ORDER BY version DESC LIMIT 1`;
    if (document.version !== (latest?.version || 0) + 1) throw new ResearchPersistenceError('REVISION_CONFLICT');
    await ctx.artifacts.put(actor, original); if (parsed) await ctx.artifacts.put(actor, parsed);
    // The lease can expire during artifact I/O; recheck inside the same locked transaction.
    if (attempt) await assertResearchAttempt(tx, task, attempt);
    await tx.$executeRaw`INSERT INTO company_research_documents(task_id,id,version,bytes_sha256,original_key,parsed_key,state,metadata)
      VALUES (${task.id},${document.id},${document.version},${document.bytesSha256},${document.original.key},${document.parsed?.key || null},${document.state},${JSON.stringify(document)}::jsonb)`;
    await emitResearchEvent(tx, task, { type: 'document.registered', documentId: document.id, version: document.version });
    return document;
  }, { timeout: 20000 });
}
export async function getResearchDocument(actor: string, taskId: string, id: string, version: number, ctx = defaultResearchContext): Promise<ResearchDocument | null> {
  assertActor(actor); z.number().int().min(1).parse(version);
  const [row] = await ctx.db.$queryRaw<{metadata: unknown}[]>`SELECT d.metadata FROM company_research_documents d JOIN company_research_tasks t ON t.id=d.task_id
    WHERE t.actor_id=${actor} AND d.task_id=${taskId} AND d.id=${id} AND d.version=${version}`;
  return row ? researchDocumentSchema.parse(row.metadata) : null;
}
export async function readResearchDocumentArtifact(actor: string, taskId: string, id: string, version: number, kind: 'original' | 'parsed', ctx = defaultResearchContext) {
  const doc = await getResearchDocument(actor, taskId, id, version, ctx), reference = doc?.[kind];
  if (!doc || !reference) throw new ResearchPersistenceError('NOT_FOUND');
  try { return { document: doc, bytes: await ctx.artifacts.read(actor, reference) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ResearchPersistenceError('NOT_FOUND'); throw error; }
}
