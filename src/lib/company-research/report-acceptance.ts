import { z } from 'zod';
import { defaultResearchContext, lockResearchTask, ResearchPersistenceError } from './repository-core';
import { canonicalResearchJson } from './task-contracts';
import { artifactDigest } from './artifact-store';
import { researchReportRevisionSchema } from './revision-contracts';
/** Explicit authenticated human attestation. This action is never registered as a model tool. */
export async function acceptResearchReport(actor: string, taskId: string, input: unknown, ctx = defaultResearchContext) {
  const body = z.object({ reportRevision: z.number().int().min(1), reportHash: z.string().regex(/^[a-f0-9]{64}$/), checkedNumbersAndExplanations: z.literal(true) }).strict().parse(input);
  return ctx.db.$transaction(async tx => {
    await lockResearchTask(tx, actor, taskId);
    const [row] = await tx.$queryRaw<{report: unknown}[]>`SELECT report FROM company_research_report_versions WHERE task_id=${taskId} AND revision=${body.reportRevision}`;
    if (!row) throw new ResearchPersistenceError('NOT_FOUND');
    const report = researchReportRevisionSchema.parse(row.report);
    if (report.status !== 'completed' || artifactDigest(canonicalResearchJson(report)) !== body.reportHash) throw new ResearchPersistenceError('REVISION_CONFLICT');
    await tx.$executeRaw`INSERT INTO company_research_report_acceptances(task_id,report_revision,report_hash) VALUES (${taskId},${body.reportRevision},${body.reportHash}) ON CONFLICT DO NOTHING`;
    return { accepted: true, reportRevision: body.reportRevision };
  });
}
