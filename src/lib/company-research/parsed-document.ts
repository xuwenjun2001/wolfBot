import { z } from 'zod';
import { researchLocatorSchema } from './document-contracts';
import { researchIdSchema, sha256Schema } from './task-contracts';

export const parsedBlockSchema = z.object({
  id: researchIdSchema, order: z.number().int().min(0), kind: z.enum(['text', 'table']), text: z.string().min(1).max(500000),
  locator: researchLocatorSchema, quality: z.enum(['native', 'needs_review', 'unreadable']), flags: z.array(z.string().max(100)).max(30),
  confidence: z.number().min(0).max(1).optional(),
  table: z.object({ id: researchIdSchema, rows: z.number().int().min(1).max(10000), columns: z.number().int().min(1).max(1000),
    cells: z.array(z.object({ row: z.number().int().min(0), column: z.number().int().min(0), rowSpan: z.number().int().min(1), columnSpan: z.number().int().min(1), text: z.string().max(10000), header: z.boolean(),
      box: z.object({ x0: z.number().min(0).max(1), y0: z.number().min(0).max(1), x1: z.number().min(0).max(1), y1: z.number().min(0).max(1) }).strict().refine(b => b.x0 < b.x1 && b.y0 < b.y1).optional(),
    }).strict()).max(50000) }).strict().optional(),
}).strict().superRefine((b, ctx) => {
  if (!['block', 'html'].includes(b.locator.kind) || ((b.locator.kind === 'block' || b.locator.kind === 'html') && b.locator.blockId !== b.id)) ctx.addIssue({ code: 'custom', message: 'Block locator ID mismatch' });
  if ((b.kind === 'table') !== !!b.table) ctx.addIssue({ code: 'custom', message: 'Table block/grid mismatch' });
  if (b.table?.cells.some(c => c.row + c.rowSpan > b.table!.rows || c.column + c.columnSpan > b.table!.columns)) ctx.addIssue({ code: 'custom', message: 'Cell outside table grid' });
  if (b.table && new Set(b.table.cells.map(c => `${c.row}:${c.column}`)).size !== b.table.cells.length) ctx.addIssue({ code: 'custom', message: 'Duplicate table cell anchor' });
});
export const parsedDocumentV2Schema = z.object({
  schemaVersion: z.literal(2), originalSha256: sha256Schema, mediaType: z.enum(['application/pdf', 'text/html']),
  parser: z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(100) }).strict(),
  pageCount: z.number().int().min(1).max(10000), status: z.enum(['ready', 'partial', 'unreadable']),
  failedPages: z.array(z.number().int().min(1)).max(10000), truncatedPages: z.array(z.number().int().min(1)).max(10000), warnings: z.array(z.string().max(500)).max(100),
  pages: z.array(z.object({ filePage: z.number().int().min(1), text: z.string().max(500000), blocks: z.array(parsedBlockSchema).max(10000) }).strict()).min(1).max(10000),
}).strict().superRefine((r, ctx) => {
  const ids = r.pages.flatMap(p => p.blocks.map(b => b.id));
  if (new Set(ids).size !== ids.length || new Set(r.pages.map(p => p.filePage)).size !== r.pages.length) ctx.addIssue({ code: 'custom', message: 'Duplicate page/block ID' });
  if ([...r.pages.map(p => p.filePage), ...r.failedPages, ...r.truncatedPages].some(p => p > r.pageCount)) ctx.addIssue({ code: 'custom', message: 'Page outside original' });
  const accounted = new Set([...r.pages.map(p => p.filePage), ...r.failedPages, ...r.truncatedPages]);
  if (accounted.size !== r.pageCount) ctx.addIssue({ code: 'custom', message: 'Unaccounted missing pages' });
  if (r.pages.some(p => p.blocks.some((b, i) => b.order !== i || !p.text.includes(b.text) || (b.locator.kind !== 'html' && b.locator.filePage !== p.filePage)))) ctx.addIssue({ code: 'custom', message: 'Block text/order/page mismatch' });
  if (r.status === 'ready' && (r.failedPages.length || r.truncatedPages.length || !ids.length || r.pages.some(p => !p.text.trim() || p.blocks.some(b => b.quality !== 'native')))) ctx.addIssue({ code: 'custom', message: 'Incomplete/low quality output cannot be ready' });
});
export const legacyPageReceiptSchema = z.object({ schemaVersion: z.literal(1), pages: z.array(z.object({ filePage: z.number().int().min(1), text: z.string().max(500000) }).strict()).min(1).max(10000) }).strict()
  .refine(v => new Set(v.pages.map(p => p.filePage)).size === v.pages.length, 'Duplicate parsed page');
export const parsedReceiptSchema = z.union([legacyPageReceiptSchema, parsedDocumentV2Schema]);
export type ParsedDocument = z.infer<typeof parsedDocumentV2Schema>;
export type ParsedBlock = z.infer<typeof parsedBlockSchema>;
