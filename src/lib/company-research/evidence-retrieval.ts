import { z } from 'zod';
import { defaultResearchContext, ResearchPersistenceError } from './repository-core';
import { scopedEvidenceDocuments, ensureEvidenceIndex } from './evidence-index-store';
import { documentChunks, evidenceFieldSchema, lexicalIndexVersion, rankEvidence, selectEvidenceHits, neighboringBlocks } from './lexical-index';
import { parsedReceiptSchema } from './parsed-document';
import { researchIdSchema, canonicalResearchJson } from './task-contracts';
import { researchLocatorSchema } from './document-contracts';

const filters = { periodIds: z.array(researchIdSchema).max(2).optional(), documentIds: z.array(researchIdSchema).max(100).optional() };
export const evidenceSearchSchema = z.object({ query: z.string().trim().min(1).max(300), ...filters, fields: z.array(evidenceFieldSchema).min(1).max(4).optional(), topK: z.number().int().min(1).max(20).default(5), maxOutputCharacters: z.number().int().min(1500).max(20000).default(10000) }).strict();
export const evidenceReadSchema = z.object({ documentId: researchIdSchema, documentVersion: z.number().int().min(1), locator: researchLocatorSchema,
  offset: z.number().int().min(0).max(500000).default(0), maxCharacters: z.number().int().min(100).max(5000).default(2000) }).strict();
export async function searchResearchEvidence(actor: string, taskId: string, input: unknown, ctx = defaultResearchContext) {
  const query = evidenceSearchSchema.parse(input), { task, documents } = await scopedEvidenceDocuments(actor, taskId, query, ctx);
  const indexes = [];
  for (const document of documents) indexes.push({ document, index: await ensureEvidenceIndex(actor, document, ctx) });
  if (indexes.reduce((n, i) => n + i.index.chunks.length, 0) > 100000) throw new ResearchPersistenceError('INVALID_RESEARCH', '索引超过 10 万块，请缩小文档范围');
  const ranked = selectEvidenceHits(rankEvidence(indexes, query.query, query.fields), query.topK), hits = [];
  const receipts = new Map<string, z.infer<typeof parsedReceiptSchema>>();
  let limited = false;
  for (const match of ranked) {
    if (hits.length >= query.topK) break;
    const doc = match.document, key = `${doc.id}:${doc.version}`;
    let receipt = receipts.get(key);
    if (!receipt) { receipt = parsedReceiptSchema.parse(JSON.parse((await ctx.artifacts.read(actor, doc.parsed!)).toString('utf8'))); receipts.set(key, receipt); }
    const chunk = documentChunks(receipt).find(c => c.id === match.chunkId)!;
    const block = receipt.schemaVersion === 2 ? receipt.pages.flatMap(p => p.blocks).find(b => b.id === chunk.blockId) : undefined;
    const originalText = block?.text || chunk.text, offset = Math.min(chunk.offset, originalText.length);
    const snippet = originalText.slice(offset, offset + 1200);
    const cells = block?.table && chunk.tableRow !== undefined ? block.table.cells.filter(c => c.row === chunk.tableRow).slice(0, 8).map(c => ({ ...c, text: c.text.slice(0, 300), locator: { kind: 'table', filePage: block.locator.kind === 'html' ? 1 : block.locator.filePage, tableId: block.table!.id, row: c.row, column: c.column, ...(c.box ? { box: c.box } : {}) } })) : undefined;
    const hit = { sourceId: doc.id, documentVersion: doc.version, bytesSha256: doc.bytesSha256, parsedSha256: doc.parsed!.sha256, chunkId: chunk.id, blockId: chunk.blockId,
      title: doc.title, periodId: doc.period.id, disclosure: doc.disclosure, locator: chunk.locator, snippet, textOffset: offset, hasMore: offset + snippet.length < originalText.length,
      score: Number(match.score.toFixed(6)), quality: chunk.quality, flags: chunk.flags,
      context: neighboringBlocks(receipt, chunk).map(b => ({ blockId: b.id, locator: b.locator, snippet: b.text.slice(0, 240), quality: b.quality })),
      ...(cells ? { table: { id: block!.table!.id, row: chunk.tableRow, cells } } : {}) };
    if (JSON.stringify({ hits: [...hits, hit] }).length > query.maxOutputCharacters - 500) { limited = true; break; }
    hits.push(hit);
  }
  return { indexVersion: lexicalIndexVersion, taskId, asOf: task.spec.asOf, scopedDocumentCount: documents.length, topK: query.topK, limited, hits };
}
export async function readResearchEvidence(actor: string, taskId: string, input: unknown, ctx = defaultResearchContext) {
  const request = evidenceReadSchema.parse(input), { task, documents } = await scopedEvidenceDocuments(actor, taskId, { documentIds: [request.documentId] }, ctx);
  const doc = documents.find(d => d.id === request.documentId && d.version === request.documentVersion);
  if (!doc) throw new ResearchPersistenceError('NOT_FOUND');
  const receipt = parsedReceiptSchema.parse(JSON.parse((await ctx.artifacts.read(actor, doc.parsed!)).toString('utf8'))), loc = request.locator;
  let text: string | undefined;
  if (loc.kind === 'page') text = receipt.pages.find(p => p.filePage === loc.filePage && (receipt.schemaVersion === 1 || !receipt.failedPages.includes(p.filePage)))?.text;
  else if (receipt.schemaVersion === 2) {
    const blocks = receipt.pages.filter(p => !receipt.failedPages.includes(p.filePage)).flatMap(p => p.blocks);
    if (loc.kind === 'block' || loc.kind === 'html') text = blocks.find(b => b.id === loc.blockId && canonicalResearchJson(b.locator) === canonicalResearchJson(loc))?.text;
    else {
      const block = blocks.find(b => b.table?.id === loc.tableId && b.locator.kind !== 'html' && b.locator.filePage === loc.filePage);
      const cell = block?.table?.cells.find(c => c.row === loc.row && c.column === loc.column);
      if (cell && (!loc.box || canonicalResearchJson(cell.box) === canonicalResearchJson(loc.box))) text = cell.text;
    }
  }
  if (text === undefined) throw new ResearchPersistenceError('NOT_FOUND');
  const part = text.slice(request.offset, request.offset + request.maxCharacters);
  return { sourceId: doc.id, documentVersion: doc.version, bytesSha256: doc.bytesSha256, asOf: task.spec.asOf, locator: loc, text: part, offset: request.offset,
    nextOffset: request.offset + part.length < text.length ? request.offset + part.length : null };
}
/** Actor/task are supplied by the application, never by the model's tool arguments. S11 registers these with PI. */
export function researchEvidenceReader(actor: string, taskId: string, ctx = defaultResearchContext) {
  return { search: (input: unknown) => searchResearchEvidence(actor, taskId, input, ctx), read: (input: unknown) => readResearchEvidence(actor, taskId, input, ctx) };
}
