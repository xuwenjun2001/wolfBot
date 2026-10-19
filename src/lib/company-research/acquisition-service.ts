import { z } from 'zod';
import { acquireFiling, discoverResearchFilings, documentEligibility, type FilingCandidate } from './filing-acquisition';
import { artifactDigest } from './artifact-store';
import { researchDocumentSchema } from './document-contracts';
import { getResearchTask } from './version-store';
import { registerResearchDocument } from './document-store';
import { defaultResearchContext, assertActor, ResearchPersistenceError } from './repository-core';
import { canonicalResearchJson } from './task-contracts';
import type { ResearchAttemptToken } from './attempt-store';

export async function listResearchDocuments(actor: string, taskId: string, ctx = defaultResearchContext) {
  assertActor(actor);
  const rows = await ctx.db.$queryRaw<{metadata: unknown}[]>`SELECT d.metadata FROM company_research_documents d JOIN company_research_tasks t ON t.id=d.task_id
    WHERE t.actor_id=${actor} AND d.task_id=${taskId} ORDER BY d.id,d.version`;
  return rows.map(r => researchDocumentSchema.parse(r.metadata));
}
export const filingImportSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('cninfo'), candidateId: z.string().regex(/^cninfo-\d+$/), page: z.number().int().min(1).max(100).default(1) }).strict(),
  z.object({ provider: z.literal('manual'), url: z.url().max(2048), title: z.string().min(1).max(500), periodId: z.string().min(1).max(100) }).strict(),
]);
export async function discoverTaskFilings(actor: string, taskId: string, page: number, signal: AbortSignal, ctx = defaultResearchContext) {
  const task = await getResearchTask(actor, taskId, ctx); if (!task) throw new ResearchPersistenceError('NOT_FOUND');
  const result = await discoverResearchFilings(task.spec, AbortSignal.any([signal, AbortSignal.timeout(60000)]), page);
  return { ...result, candidates: result.candidates.map(({ evidence, ...candidate }) => ({ ...candidate, evidenceSha256: artifactDigest(evidence), eligibility: documentEligibility(candidate, task.spec.asOf) })) };
}
export async function importTaskFiling(actor: string, taskId: string, input: unknown, signal: AbortSignal, ctx = defaultResearchContext, attempt?: ResearchAttemptToken) {
  const request = filingImportSchema.parse(input), task = await getResearchTask(actor, taskId, ctx);
  if (!task) throw new ResearchPersistenceError('NOT_FOUND');
  let candidate: FilingCandidate;
  if (request.provider === 'cninfo') {
    const result = await discoverResearchFilings(task.spec, AbortSignal.any([signal, AbortSignal.timeout(60000)]), request.page);
    const match = result.candidates.find(c => c.provider === 'cninfo' && c.id === request.candidateId);
    if (!match) throw new ResearchPersistenceError('INVALID_RESEARCH', '官方公告候选不存在，请重新发现资料');
    candidate = match;
  } else {
    const evidence = Buffer.from(canonicalResearchJson(request));
    candidate = { id: `manual-${artifactDigest(request.url).slice(0, 24)}`, ...request, evidence, evidenceUrl: request.url,
      disclosure: { status: 'unknown', reason: '手动链接没有已核实披露依据' }, dateClaims: [], warnings: ['disclosure_unverified', 'issuer_identity_requires_content_check'] };
  }
  const documents = await listResearchDocuments(actor, taskId, ctx);
  const history = documents.filter(d => d.id === candidate.id);
  const existing = history.at(-1);
  const acquired = await acquireFiling(taskId, task.spec, candidate, (existing?.version || 0) + 1, signal);
  const identicalSource = documents.find(document => document.id !== candidate.id && document.period.id === acquired.document.period.id
    && document.bytesSha256 === acquired.document.bytesSha256 && canonicalResearchJson(document.disclosure) === canonicalResearchJson(acquired.document.disclosure));
  if (identicalSource) {
    await ctx.artifacts.read(actor, identicalSource.original);
    return { document: identicalSource, eligibility: documentEligibility(identicalSource, task.spec.asOf), reused: true, duplicateSource: true };
  }
  if (history.some(d => d.bytesSha256 !== acquired.document.bytesSha256)) {
    // An old announcement date does not prove when replacement PDF bytes became public.
    // Keep quarantine across retries; fetching a replacement cannot backdate it.
    acquired.document.disclosure = { status: 'unknown', reason: '同一来源原件已修订，修订内容的公开时点未核实' };
    acquired.document.provenance!.warnings = [...candidate.warnings, 'replacement_disclosure_unverified'];
    acquired.eligibility = 'date_unverified';
  }
  // Byte-identical retries keep the original fetchedAt and parsed version. Changed provenance also gets an immutable revision.
  if (existing && existing.bytesSha256 === acquired.document.bytesSha256 && canonicalResearchJson(existing.disclosure) === canonicalResearchJson(acquired.document.disclosure) && canonicalResearchJson(existing.provenance) === canonicalResearchJson(acquired.document.provenance)) {
    await ctx.artifacts.read(actor, existing.original);
    return { document: existing, eligibility: documentEligibility(existing, task.spec.asOf), reused: true };
  }
  await ctx.artifacts.put(actor, acquired.evidence);
  try { await registerResearchDocument(actor, acquired.document, acquired.original, undefined, ctx, attempt); }
  catch (error) {
    if (!(error instanceof ResearchPersistenceError) || error.code !== 'REVISION_CONFLICT') throw error;
    const latest = (await listResearchDocuments(actor, taskId, ctx)).filter(d => d.id === candidate.id).at(-1);
    if (!latest || latest.bytesSha256 !== acquired.document.bytesSha256 || canonicalResearchJson(latest.disclosure) !== canonicalResearchJson(acquired.document.disclosure) || canonicalResearchJson(latest.provenance) !== canonicalResearchJson(acquired.document.provenance)) throw error;
    return { document: latest, eligibility: documentEligibility(latest, task.spec.asOf), reused: true };
  }
  return { document: acquired.document, eligibility: acquired.eligibility, reused: false };
}
