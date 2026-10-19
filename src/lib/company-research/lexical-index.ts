import { z } from 'zod';
import { parsedReceiptSchema } from './parsed-document';
import { artifactDigest } from './artifact-store';
import { researchLocatorSchema, type ResearchDocument } from './document-contracts';
import { sha256Schema, researchIdSchema } from './task-contracts';

export const lexicalIndexVersion = 'zh-context-bm25-v4';
export const evidenceFieldSchema = z.enum(['revenue', 'parent_profit', 'cash_flow', 'risk']);
export type EvidenceField = z.infer<typeof evidenceFieldSchema>;
export function lexicalTokens(text: string): string[] {
  const parts = text.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[a-z]+|\d+(?:[.,]\d+)*/gu) || [];
  return parts.flatMap(s => {
    if (!/\p{Script=Han}/u.test(s)) return [s.replace(/,/g, '')];
    const chars = Array.from(s); if (chars.length === 1) return chars;
    return [...(chars.length <= 8 ? [s] : []), ...chars.slice(0, -1).map((c, i) => c + chars[i + 1])];
  });
}
export function queryTokens(query: string) {
  const aliases = [
    [/收入/, '营业收入 营业总收入'], [/归母|净利润/, '归属于上市公司股东的净利润 归属于母公司股东的净利润'],
    [/现金流/, '经营活动产生的现金流量净额 经营活动现金流'], [/风险/, '主要风险 可能面对的风险 可能面临的风险 面临的风险和应对措施'],
  ] as const;
  return [...new Set(lexicalTokens(query + ' ' + aliases.filter(([pattern]) => pattern.test(query)).map(([, value]) => value).join(' ')))];
}
export const evidenceChunkSchema = z.object({ id: researchIdSchema, blockId: researchIdSchema, locator: researchLocatorSchema,
  text: z.string().min(1).max(500000), quality: z.enum(['native', 'needs_review', 'unreadable']), flags: z.array(z.string().max(100)).max(30),
  tableRow: z.number().int().min(0).optional(), offset: z.number().int().min(0),
}).strict();
export type EvidenceChunk = z.infer<typeof evidenceChunkSchema>;
export function documentChunks(input: unknown): EvidenceChunk[] {
  const receipt = parsedReceiptSchema.parse(input), chunks: EvidenceChunk[] = [];
  for (const page of receipt.pages) {
    if (receipt.schemaVersion === 2 && receipt.failedPages.includes(page.filePage)) continue;
    const blocks = receipt.schemaVersion === 2 ? receipt.pages.find(p => p.filePage === page.filePage)!.blocks : [{ id: `legacy_p${page.filePage}`, locator: { kind: 'page' as const, filePage: page.filePage }, text: page.text, quality: 'native' as const, flags: ['legacy_page_receipt'], table: undefined }];
    for (const block of blocks) {
      if (block.quality === 'unreadable') continue;
      if (block.table) {
        // Row headers describe their own metric, not every row in the table.
        const headerRows = new Set(block.table.cells.filter(c => c.header).map(c => c.row));
        for (const cell of block.table.cells) if (!cell.header) headerRows.delete(cell.row);
        const headers = block.table.cells.filter(c => headerRows.has(c.row)).map(c => c.text).join('\n');
        for (const row of [...new Set(block.table.cells.map(c => c.row))]) {
          const cells = block.table.cells.filter(c => c.row === row), rowText = cells.map(c => c.text).join('\n');
          if (!rowText.trim()) continue;
          chunks.push({ id: `${block.id}_r${row}`, blockId: block.id, locator: block.locator, text: `${headers}\n${rowText}`, quality: block.quality, flags: block.flags, tableRow: row, offset: Math.max(0, block.text.indexOf(cells[0].text)) });
        }
      } else for (let offset = 0; offset < block.text.length; offset += 1600) {
        const text = block.text.slice(offset, offset + 1800); if (!text.trim()) continue;
        chunks.push({ id: `${block.id}_${offset}`, blockId: block.id, locator: block.locator, text, quality: block.quality, flags: block.flags, offset });
      }
    }
  }
  return chunks;
}
export const lexicalIndexSchema = z.object({ version: z.literal(lexicalIndexVersion), originalSha256: sha256Schema, parsedSha256: sha256Schema,
  chunks: z.array(z.object({ id: researchIdSchema, length: z.number().int().min(1), terms: z.record(z.string().max(200), z.number().int().min(1)),
    filePage: z.number().int().min(1).nullable(), fields: z.array(evidenceFieldSchema).max(4), summary: z.boolean(), numericRow: z.boolean(), riskSection: z.boolean(),
  }).strict()).max(100000),
}).strict();
export type LexicalIndex = z.infer<typeof lexicalIndexSchema>;
function financialFields(text: string): LexicalIndex['chunks'][number]['fields'] {
  const compact = text.replace(/\s/g, '');
  return [
    /营业(?:总)?收入/.test(compact) ? 'revenue' : null,
    /归属于(?:上市公司|母公司)(?:股东|所有者)的净利润|归母净利润/.test(compact) ? 'parent_profit' : null,
    /经营活动(?:产生)?的?现金流(?:量)?净额|经营现金流净额/.test(compact) ? 'cash_flow' : null,
    /主要风险|可能面[临对]的风险|面临的风险和应对措施/.test(compact) ? 'risk' : null,
  ].filter((f): f is LexicalIndex['chunks'][number]['fields'][number] => f !== null);
}
/** Neighboring lines help ranking only; each quote still points to its own real block. */
export function neighboringBlocks(input: unknown, chunk: EvidenceChunk) {
  const receipt = parsedReceiptSchema.parse(input);
  if (receipt.schemaVersion !== 2) return [];
  const page = receipt.pages.find(p => chunk.locator.kind === 'html' ? p.blocks.some(b => b.id === chunk.blockId) : p.filePage === chunk.locator.filePage);
  if (!page) return [];
  const at = page.blocks.findIndex(b => b.id === chunk.blockId);
  return page.blocks.slice(Math.max(0, at - 3), at + 4).filter(b => b.id !== chunk.blockId && b.quality !== 'unreadable');
}
export function buildLexicalIndex(document: ResearchDocument, receipt: unknown): LexicalIndex {
  const parsed = parsedReceiptSchema.parse(receipt);
  const pages = new Map(parsed.pages.map(p => [p.filePage, p]));
  const blocks = parsed.schemaVersion === 2 ? new Map(parsed.pages.flatMap(p => p.blocks.map((b, at) => [b.id, { page: p, at }] as const))) : null;
  const riskBlocks = new Set<string>(); let inRiskSection = false;
  if (parsed.schemaVersion === 2) for (const page of parsed.pages) for (const block of page.blocks) {
    const line = block.text.replace(/\s/g, '');
    if (line.length <= 60 && /^(?:[（(一二三四五六七八九十\d、.．）)]*)(?:可能面[临对]的风险|面临的风险和应对措施|主要风险(?:因素)?)[：:]?$/.test(line)) inRiskSection = true;
    else if (/^第[一二三四五六七八九十\d]+节|^[（(][一二三四五六七八九十]+[）)]|^[一二三四五六七八九十]+、/.test(line)) inRiskSection = false;
    if (inRiskSection) riskBlocks.add(block.id);
  }
  const chunks = documentChunks(parsed).map(c => {
    const location = blocks?.get(c.blockId);
    const context = c.tableRow !== undefined ? c.text : location ? location.page.blocks.slice(Math.max(0, location.at - 3), location.at + 4).filter(b => b.quality !== 'unreadable').map(b => b.text).join('\n') : c.text;
    const page = location?.page || (c.locator.kind !== 'html' ? pages.get(c.locator.filePage) : undefined);
    const tokens = lexicalTokens(context), terms: Record<string, number> = Object.create(null);
    for (const token of tokens) if (token.length <= 200) terms[token] = (terms[token] || 0) + 1;
    return { id: c.id, length: Math.max(1, tokens.length), terms, filePage: c.locator.kind === 'html' ? null : c.locator.filePage,
      fields: financialFields(context), summary: (page?.text.split('\n') || []).some(line => /主要(?:会计|财务)数据|主要财务指标/.test(line.replace(/\s/g, '')) && !/分季度/.test(line)),
      riskSection: riskBlocks.has(c.blockId),
      numericRow: (c.text.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+/g) || []).length >= 2 };
  });
  return lexicalIndexSchema.parse({ version: lexicalIndexVersion, originalSha256: document.bytesSha256, parsedSha256: document.parsed!.sha256, chunks });
}
export function rankEvidence(indexes: { document: ResearchDocument; index: LexicalIndex }[], query: string, fields?: EvidenceField[]) {
  const tokens = queryTokens(query), entries = indexes.flatMap(({ document, index }) => index.chunks
    .filter(chunk => !fields?.length || fields.some(field => chunk.fields.includes(field) || field === 'risk' && chunk.riskSection))
    .map(chunk => ({ document, chunk })));
  const average = entries.reduce((s, e) => s + e.chunk.length, 0) / Math.max(1, entries.length), frequency = new Map<string, number>();
  for (const token of tokens) frequency.set(token, entries.filter(e => e.chunk.terms[token]).length);
  const requested = /现金流/.test(query) ? ['cash_flow'] : /风险/.test(query) ? ['risk'] : financialFields(query);
  return entries.map(({ document, chunk }) => {
    let score = 0;
    for (const token of tokens) {
      const tf = chunk.terms[token] || 0; if (!tf) continue;
      const df = frequency.get(token) || 0, idf = Math.log(1 + (entries.length - df + .5) / (df + .5));
      score += idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * chunk.length / Math.max(1, average)));
    }
    const covered = requested.filter(f => chunk.fields.includes(f as typeof chunk.fields[number])).length;
    if (covered) score += covered * 12 + (requested.includes('risk') ? 12 : (chunk.summary ? 24 : 0) + (chunk.numericRow ? 12 : 0));
    if (requested.includes('risk') && chunk.riskSection) score += 40;
    return { document, chunkId: chunk.id, filePage: chunk.filePage, score };
  }).filter(e => e.score > 0).sort((a, b) => b.score - a.score || `${a.document.id}:${a.chunkId}`.localeCompare(`${b.document.id}:${b.chunkId}`));
}
/** Give each requested period a first result, then fill by score with bounded page repetition. */
export function selectEvidenceHits(ranked: ReturnType<typeof rankEvidence>, topK: number) {
  const selected: typeof ranked = [], pages = new Map<string, number>();
  const add = (hit: typeof ranked[number]) => {
    const key = `${hit.document.id}:${hit.document.version}:${hit.filePage ?? 'html'}`;
    if (selected.length >= topK || selected.includes(hit) || (pages.get(key) || 0) >= 1) return;
    selected.push(hit); pages.set(key, (pages.get(key) || 0) + 1);
  };
  const periods = [...new Set(ranked.map(h => h.document.period.id))];
  if (topK >= periods.length && periods.length > 1) for (const id of periods) add(ranked.find(h => h.document.period.id === id)!);
  for (const hit of ranked) { add(hit); if (selected.length === topK) break; }
  return selected.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
}
export const lexicalArtifactHash = (index: LexicalIndex) => artifactDigest(JSON.stringify(index));
