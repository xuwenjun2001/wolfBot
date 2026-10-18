import { z } from 'zod';
import { canonicalResearchJson } from './task-contracts';
import { researchDocumentSchema } from './document-contracts';
import { researchReportRevisionSchema, reportBindingErrors } from './revision-contracts';
import { parsedPageReceiptSchema } from './document-store';
import { locatedCitationText } from './citation-locator';
import type { ParsedDocument } from './parsed-document';
import { assertResearchAttempt, type ResearchAttemptToken } from './attempt-store';
import { defaultResearchContext, lockResearchTask, taskSpec, emitResearchEvent, ResearchPersistenceError } from './repository-core';

export async function commitResearchReport(actor: string, token: ResearchAttemptToken, expectedRevision: number, input: unknown, ctx = defaultResearchContext) {
  z.number().int().min(0).parse(expectedRevision);
  const report = researchReportRevisionSchema.parse(input);
  if (report.revision !== expectedRevision + 1) throw new ResearchPersistenceError('REVISION_CONFLICT');
  return ctx.db.$transaction(async tx => {
    const task = await lockResearchTask(tx, actor, token.taskId);
    const [prior] = await tx.$queryRaw<{report: unknown; attempt_id: string; generation: number}[]>`SELECT report,attempt_id,generation FROM company_research_report_versions WHERE task_id=${task.id} AND revision=${report.revision}`;
    if (prior) {
      if (prior.attempt_id !== token.id || prior.generation !== token.generation || canonicalResearchJson(prior.report) !== canonicalResearchJson(report)) throw new ResearchPersistenceError('REVISION_CONFLICT');
      return researchReportRevisionSchema.parse(prior.report);
    }
    await assertResearchAttempt(tx, task, token);
    if (task.report_revision !== expectedRevision || report.revision !== expectedRevision + 1 || report.taskId !== task.id || report.requestRevision !== token.requestRevision || report.planRevision !== token.planRevision) throw new ResearchPersistenceError('REVISION_CONFLICT');
    const spec = await taskSpec(tx, task);
    const rows = await tx.$queryRaw<{metadata: unknown}[]>`SELECT metadata FROM company_research_documents WHERE task_id=${task.id}`;
    const documents = rows.map(r => researchDocumentSchema.parse(r.metadata)), text = new Map<string, string>(), rich = new Map<string, ParsedDocument>();
    const citations = [...report.facts.flatMap(f => f.citations), ...report.claims.flatMap(c => c.citations)];
    for (const doc of documents) if (citations.some(c => c.documentId === doc.id && c.documentVersion === doc.version)) {
      if (!doc.parsed) throw new ResearchPersistenceError('INVALID_RESEARCH', 'Verified parsed receipt required');
      const receipt = parsedPageReceiptSchema.parse(JSON.parse((await ctx.artifacts.read(actor, doc.parsed)).toString('utf8')));
      if (receipt.schemaVersion === 2) rich.set(`${doc.id}:${doc.version}`, receipt);
      for (const page of receipt.pages) if (!doc.parser?.failedPages.includes(page.filePage)) text.set(`${doc.id}:${doc.version}:${page.filePage}`, page.text);
    }
    for (const fact of report.facts.filter(f => f.value.status === 'known')) for (const c of fact.citations) {
      const receipt = rich.get(`${c.documentId}:${c.documentVersion}`), loc = c.locator;
      if (!receipt) continue;
      const blocks = receipt.pages.flatMap(p => p.blocks).filter(b => loc.kind === 'html' || loc.kind === 'block' ? b.id === loc.blockId : loc.kind === 'table' ? b.table?.id === loc.tableId : b.locator.kind !== 'html' && b.locator.filePage === loc.filePage);
      if (blocks.some(b => b.quality !== 'native')) throw new ResearchPersistenceError('INVALID_RESEARCH', 'FACT_SOURCE_NEEDS_REVIEW');
    }
    const errors = reportBindingErrors(report, spec, documents, (id, version, page) => text.get(`${id}:${version}:${page}`), citation => {
      const receipt = rich.get(`${citation.documentId}:${citation.documentVersion}`);
      // Legacy receipts can prove a page quote only; they cannot prove invented block/table IDs.
      return receipt ? locatedCitationText(receipt, citation) : citation.locator.kind === 'page' ? text.get(`${citation.documentId}:${citation.documentVersion}:${citation.locator.filePage}`) : undefined;
    });
    if (errors.length) throw new ResearchPersistenceError('INVALID_RESEARCH', errors.join('; '));
    // Artifact I/O can outlive a nearly expired lease. Fence again at publication.
    await assertResearchAttempt(tx, task, token);
    await tx.$executeRaw`INSERT INTO company_research_report_versions(task_id,revision,request_revision,plan_revision,attempt_id,generation,report)
      VALUES (${task.id},${report.revision},${report.requestRevision},${report.planRevision},${token.id},${token.generation},${JSON.stringify(report)}::jsonb)`;
    await tx.$executeRaw`UPDATE company_research_attempts SET status=${report.status},finished_at=clock_timestamp() WHERE id=${token.id}`;
    await tx.$executeRaw`UPDATE company_research_tasks SET report_revision=${report.revision},status=${report.status},active_attempt_id=NULL WHERE id=${task.id}`;
    task.report_revision = report.revision;
    await emitResearchEvent(tx, task, { type: 'report.created', status: report.status }, token.id);
    await emitResearchEvent(tx, task, { type: 'attempt.finished', status: report.status }, token.id);
    return report;
  }, { timeout: 20000 });
}
