import { z } from 'zod';
import { defaultResearchContext, ResearchPersistenceError } from './repository-core';
import { documentAvailableAt, researchDocumentSchema, type ResearchDocument } from './document-contracts';
import { getResearchTask } from './version-store';
import { canonicalResearchJson } from './task-contracts';
import { isResearchEvidencePeriod, researchEvidencePeriods } from './evidence-periods';
import { buildLexicalIndex, lexicalIndexSchema, lexicalIndexVersion } from './lexical-index';

export async function scopedEvidenceDocuments(actor: string, taskId: string, filters: { periodIds?: string[]; documentIds?: string[] }, ctx = defaultResearchContext) {
  const task = await getResearchTask(actor, taskId, ctx); if (!task) throw new ResearchPersistenceError('NOT_FOUND');
  if (filters.periodIds?.some(id => !researchEvidencePeriods(task.spec).some(p => p.id === id))) throw new ResearchPersistenceError('INVALID_RESEARCH', '期间不属于任务');
  // Only metadata crosses this first boundary. Never load another actor's index or original to filter later.
  const rows = await ctx.db.$queryRaw<{ metadata: unknown }[]>`SELECT d.metadata FROM company_research_documents d JOIN company_research_tasks t ON t.id=d.task_id
    WHERE t.actor_id=${actor} AND d.task_id=${taskId} ORDER BY d.id,d.version LIMIT 5001`;
  if (rows.length > 5000) throw new ResearchPersistenceError('INVALID_RESEARCH', '资料版本过多，请缩小任务范围');
  const latest = new Map<string, ResearchDocument>();
  for (const row of rows) {
    const d = researchDocumentSchema.parse(row.metadata);
    if (d.company.symbol !== task.spec.company.symbol || !isResearchEvidencePeriod(task.spec, d.period) || !documentAvailableAt(d, task.spec.asOf)) continue;
    if (filters.periodIds?.length && !filters.periodIds.includes(d.period.id)) continue;
    if (filters.documentIds?.length && !filters.documentIds.includes(d.id)) continue;
    // Choose latest admissible snapshot even if unreadable: an older parser's success must not hide a newer failure.
    latest.set(d.id, d);
  }
  const documents = [...latest.values()].filter(d => d.parsed && ['ready', 'partial'].includes(d.state));
  if (documents.reduce((n, d) => n + (d.parsed?.byteLength || 0), 0) > 50_000_000) throw new ResearchPersistenceError('INVALID_RESEARCH', '解析语料超过 50 MB，请使用期间或文档筛选');
  return { task, documents };
}
export async function ensureEvidenceIndex(actor: string, doc: ResearchDocument, ctx = defaultResearchContext) {
  z.string().min(1).parse(actor);
  if (!doc.parsed) throw new ResearchPersistenceError('NOT_FOUND');
  const [owned] = await ctx.db.$queryRaw<{metadata: unknown}[]>`SELECT d.metadata FROM company_research_documents d JOIN company_research_tasks t ON t.id=d.task_id
    WHERE t.actor_id=${actor} AND d.task_id=${doc.taskId} AND d.id=${doc.id} AND d.version=${doc.version}`;
  if (!owned) throw new ResearchPersistenceError('NOT_FOUND');
  if (canonicalResearchJson(researchDocumentSchema.parse(owned.metadata)) !== canonicalResearchJson(doc)) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Index metadata/source mismatch');
  const [row] = await ctx.db.$queryRaw<{parsed_sha256: string; artifact_key: string; byte_length: number}[]>`SELECT i.parsed_sha256,i.artifact_key,i.byte_length
    FROM company_research_evidence_indexes i JOIN company_research_tasks t ON t.id=i.task_id WHERE t.actor_id=${actor}
    AND i.task_id=${doc.taskId} AND i.document_id=${doc.id} AND i.document_version=${doc.version} AND i.index_version=${lexicalIndexVersion}`;
  if (row) {
    if (row.parsed_sha256 !== doc.parsed?.sha256) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Index/source mismatch');
    const index = lexicalIndexSchema.parse(JSON.parse((await ctx.artifacts.read(actor, { store: 'local', key: row.artifact_key, sha256: row.artifact_key, byteLength: row.byte_length })).toString('utf8')));
    if (index.originalSha256 !== doc.bytesSha256 || index.parsedSha256 !== doc.parsed.sha256) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Index binding mismatch');
    return index;
  }
  const receipt = JSON.parse((await ctx.artifacts.read(actor, doc.parsed)).toString('utf8')), index = buildLexicalIndex(doc, receipt);
  const artifact = await ctx.artifacts.put(actor, Buffer.from(JSON.stringify(index)));
  await ctx.db.$executeRaw`INSERT INTO company_research_evidence_indexes(task_id,document_id,document_version,index_version,parsed_sha256,artifact_key,byte_length)
    VALUES (${doc.taskId},${doc.id},${doc.version},${lexicalIndexVersion},${doc.parsed.sha256},${artifact.key},${artifact.byteLength}) ON CONFLICT DO NOTHING`;
  return index;
}
