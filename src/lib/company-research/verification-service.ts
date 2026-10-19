import { listResearchDocuments } from './acquisition-service';
import { parsedReceiptSchema, type ParsedDocument } from './parsed-document';
import { locatedCitationText } from './citation-locator';
import type { VersionedCitation } from './document-contracts';
import type { ResearchReportRevision } from './revision-contracts';
import { reportBindingErrors } from './revision-contracts';
import { numericFactErrors, semanticReviewSchema } from './claim-verification';
import type { ResearchTaskSpec } from './task-contracts';
import { defaultResearchContext } from './repository-core';

export async function researchVerificationContext(actor: string, taskId: string, ctx = defaultResearchContext) {
  const documents = await listResearchDocuments(actor, taskId, ctx);
  const receipts = new Map<string, ReturnType<typeof parsedReceiptSchema.parse>>();
  // Receipts are loaded lazily at the call site through the exact cited versions.
  async function load(citations: VersionedCitation[]) {
    for (const c of citations) {
      const key = `${c.documentId}:${c.documentVersion}`, doc = documents.find(d => d.id === c.documentId && d.version === c.documentVersion);
      if (!receipts.has(key) && doc?.parsed) receipts.set(key, parsedReceiptSchema.parse(JSON.parse((await ctx.artifacts.read(actor, doc.parsed)).toString())));
    }
  }
  const page = (c: VersionedCitation) => {
    const r = receipts.get(`${c.documentId}:${c.documentVersion}`), loc = c.locator;
    return loc.kind === 'html' ? r?.pages.map(p => p.text).join('\n') : r?.pages.find(p => p.filePage === loc.filePage)?.text;
  };
  const located = (c: VersionedCitation) => {
    const r = receipts.get(`${c.documentId}:${c.documentVersion}`);
    return r?.schemaVersion === 2 ? locatedCitationText(r as ParsedDocument, c) : c.locator.kind === 'page' ? page(c) : undefined;
  };
  return { documents, receipts, load, page, located };
}
export async function deterministicReportErrors(actor: string, spec: ResearchTaskSpec, report: ResearchReportRevision, ctx = defaultResearchContext) {
  const evidence = await researchVerificationContext(actor, report.taskId, ctx);
  const citations = [...report.facts.flatMap(f => [...f.citations, ...(f.periodEvidence || [])]), ...report.claims.flatMap(c => c.citations)];
  await evidence.load(citations);
  const errors = reportBindingErrors(report, spec, evidence.documents, (id, version, filePage) => evidence.page({ documentId: id, documentVersion: version, locator: { kind: 'page', filePage }, bytesSha256: '', quote: '' }), evidence.located);
  for (const fact of report.facts) errors.push(...numericFactErrors(fact, evidence.documents, evidence.page).map(e => `${fact.id}:${e}`));
  return { errors: [...new Set(errors)], evidence };
}
export async function readClaimReviews(actor: string, taskId: string, ctx = defaultResearchContext) {
  const rows = await ctx.db.$queryRaw<{review: unknown}[]>`SELECT r.review FROM company_research_claim_reviews r JOIN company_research_tasks t ON t.id=r.task_id WHERE t.actor_id=${actor} AND r.task_id=${taskId}`;
  return rows.map(r => semanticReviewSchema.parse(r.review));
}
