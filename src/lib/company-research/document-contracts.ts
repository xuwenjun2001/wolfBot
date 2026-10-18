import { z } from 'zod';
import { companyIdentitySchema, researchIdSchema, researchPeriodSchema, revisionSchema, sha256Schema, timestampSchema } from './task-contracts';

const boxSchema = z.object({ x0: z.number().min(0).max(1), y0: z.number().min(0).max(1), x1: z.number().min(0).max(1), y1: z.number().min(0).max(1) }).strict()
  .refine(b => b.x0 < b.x1 && b.y0 < b.y1, 'Empty or inverted bounding box');
const pageFields = { filePage: z.number().int().min(1), printedPage: z.string().max(30).optional(), box: boxSchema.optional() };
export const researchLocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), ...pageFields }).strict(),
  z.object({ kind: z.literal('block'), ...pageFields, blockId: researchIdSchema }).strict(),
  z.object({ kind: z.literal('table'), ...pageFields, tableId: researchIdSchema, row: z.number().int().min(0), column: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('html'), blockId: researchIdSchema, selector: z.string().min(1).max(500) }).strict(),
]);
export const artifactReferenceSchema = z.object({
  store: z.literal('local'), key: sha256Schema, sha256: sha256Schema, byteLength: z.number().int().min(1).max(50_000_000),
}).strict().refine(v => v.key === v.sha256, 'Artifact key must be its content digest');
export const disclosureSchema = z.union([
  z.object({ status: z.literal('unknown'), reason: z.string().min(1).max(500) }).strict(),
  z.object({ status: z.literal('verified'), precision: z.literal('instant'), at: timestampSchema, evidenceUrl: z.url(), evidenceSha256: sha256Schema }).strict(),
  z.object({ status: z.literal('verified'), precision: z.literal('date'), on: z.iso.date(), timezone: z.literal('Asia/Shanghai'), evidenceUrl: z.url(), evidenceSha256: sha256Schema }).strict(),
]);
export const researchDocumentSchema = z.object({
  schemaVersion: z.literal(1), id: researchIdSchema, taskId: z.uuid(), version: revisionSchema,
  company: companyIdentitySchema, period: researchPeriodSchema, title: z.string().min(1).max(500), url: z.url(),
  mediaType: z.enum(['application/pdf', 'text/html']), bytesSha256: sha256Schema, fetchedAt: timestampSchema,
  disclosure: disclosureSchema, original: artifactReferenceSchema,
  state: z.enum(['acquired', 'parse_pending', 'ready', 'partial', 'unreadable']), pageCount: z.number().int().min(1).max(10000).optional(),
  parsed: artifactReferenceSchema.optional(), parser: z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(100), failedPages: z.array(z.number().int().min(1)).max(10000), warnings: z.array(z.string().max(500)).max(100) }).strict().optional(),
  provenance: z.object({ provider: z.enum(['cninfo', 'market', 'deepseek', 'manual']), finalUrl: z.url(),
    evidence: artifactReferenceSchema.optional(), dateClaims: z.array(z.object({ source: z.string().max(100), on: z.iso.date() }).strict()).max(10),
    warnings: z.array(z.string().max(500)).max(20) }).strict().optional(),
}).strict().refine(v => v.bytesSha256 === v.original.sha256, 'Original bytes/hash mismatch')
  .refine(v => v.state !== 'ready' || !!(v.parsed && v.parser), 'Ready documents need parsed artifact and parser metadata');
export type ResearchDocument = z.infer<typeof researchDocumentSchema>;
export const researchCitationSchema = z.object({
  documentId: researchIdSchema, documentVersion: revisionSchema, bytesSha256: sha256Schema,
  locator: researchLocatorSchema, quote: z.string().min(1).max(2000),
}).strict();
export type VersionedCitation = z.infer<typeof researchCitationSchema>;
const amountSchema = z.object({
  status: z.literal('known'), raw: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/).max(100),
  unit: z.enum(['yuan', 'thousand_yuan', 'ten_thousand_yuan', 'hundred_million_yuan']), currency: z.literal('CNY'), decimals: z.number().int().min(0).max(12),
}).strict().refine(v => (v.raw.split('.')[1]?.length || 0) <= v.decimals, 'Raw value exceeds declared precision');
export const financialFactSchema = z.object({
  id: researchIdSchema, companySymbol: companyIdentitySchema.shape.symbol, period: researchPeriodSchema,
  metric: z.enum(['revenue', 'total_operating_income', 'parent_net_profit', 'operating_cash_flow']),
  scope: z.enum(['consolidated', 'parent']), restatement: z.enum(['original', 'restated']),
  value: z.discriminatedUnion('status', [amountSchema, z.object({ status: z.literal('missing'), reason: z.string().min(1).max(500) }).strict(),
    z.object({ status: z.literal('conflict'), alternatives: z.array(amountSchema).min(2).max(5), reason: z.string().min(1).max(500) }).strict()]),
  citations: z.array(researchCitationSchema).max(10),
}).strict().refine(f => f.value.status === 'missing' || f.citations.length > 0, 'Known/conflicting facts need citations');
export type FinancialFact = z.infer<typeof financialFactSchema>;

export function documentAvailableAt(document: Pick<ResearchDocument, 'disclosure'>, asOf: string): boolean {
  const d = document.disclosure;
  if (d.status === 'unknown') return false;
  const available = d.precision === 'instant' ? d.at : `${d.on}T23:59:59.999+08:00`;
  return new Date(available).getTime() <= new Date(asOf).getTime();
}
