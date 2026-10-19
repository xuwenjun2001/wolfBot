import { describe, expect, it } from 'vitest';
import { buildLexicalIndex, documentChunks, lexicalTokens, rankEvidence, selectEvidenceHits, neighboringBlocks } from './lexical-index';
import { evidenceSearchSchema } from './evidence-retrieval';
import { documentFixture } from './version-test-fixtures';
import { HtmlTextParser } from './text-parser';
describe('located Chinese lexical evidence', () => {
  it('selects the requested row in a long table without treating row labels as shared headers', () => {
    const doc = { ...documentFixture(), parsed: documentFixture().original };
    const labels = ['指标', '营业收入', ...Array.from({ length: 38 }, (_, i) => `其他财务附注${i}${'补充说明'.repeat(10)}`), '经营活动产生的现金流量净额'];
    const cells = labels.flatMap((label, row) => [label, row ? '100.00' : '2024', row ? '90.00' : '2023'].map((text, column) => ({ row, column, rowSpan: 1, columnSpan: 1, text, header: row === 0 || column === 0 })));
    const text = cells.map(c => c.text).join('\n');
    const receipt = { schemaVersion: 2, originalSha256: doc.bytesSha256, mediaType: 'application/pdf', parser: { name: 'table-test', version: '1' }, pageCount: 1, status: 'partial', failedPages: [], truncatedPages: [], warnings: [],
      pages: [{ filePage: 1, text, blocks: [{ id: 'table_test', order: 0, kind: 'table', text, locator: { kind: 'block', filePage: 1, blockId: 'table_test' }, quality: 'needs_review', flags: ['table_structure_requires_review'], table: { id: 'grid', rows: labels.length, columns: 3, cells } }] }] };
    const indexes = [{ document: doc, index: buildLexicalIndex(doc, receipt) }];
    const hits = selectEvidenceHits(rankEvidence(indexes, '经营活动产生的现金流量净额', ['cash_flow']), 5);
    expect(hits.map(h => h.chunkId)).toEqual(['table_test_r40']);
    const chunk = documentChunks(receipt).find(c => c.id === hits[0].chunkId)!;
    expect(text.slice(chunk.offset, chunk.offset + 1200)).toContain('经营活动产生的现金流量净额');
    expect(rankEvidence(indexes, '营业收入', ['revenue']).map(h => h.chunkId)).toEqual(['table_test_r1']);
    expect(chunk.text).toContain('2024');
  });
  it('recalls a source older than eight subsequent documents with deterministic ranking', () => {
    const indexes = Array.from({ length: 12 }, (_, i) => {
      const document = { ...documentFixture(), id: `source-${i}`, parsed: documentFixture().original };
      return { document, index: buildLexicalIndex(document, { schemaVersion: 1, pages: [{ filePage: 5, text: i === 0 ? '应收账款减值准备大幅增加。' : '普通公告：交易服务保持稳定。' }] }) };
    });
    const hits = rankEvidence(indexes, '应收账款减值准备');
    expect(hits[0].document.id).toBe('source-0');
    expect(rankEvidence(indexes, '应收账款减值准备')).toEqual(hits);
  });
  it('preserves legacy page locations and overlapping bounded chunks', () => {
    const chunks = documentChunks({ schemaVersion: 1, pages: [{ filePage: 23, text: '经营现金流'.repeat(500) }] });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.locator.kind === 'page' && c.locator.filePage === 23 && c.text.length <= 1800)).toBe(true);
    expect(lexicalTokens('经营活动现金流 1,234.50')).toContain('1234.50');
  });
  it('bounds arguments and does not accept model-specified actor or cutoff', () => {
    expect(evidenceSearchSchema.safeParse({ query: '现金流', actor: 'someone-else' }).success).toBe(false);
    expect(evidenceSearchSchema.safeParse({ query: '现金流', asOf: '2030-01-01' }).success).toBe(false);
    expect(evidenceSearchSchema.safeParse({ query: '现金流', topK: 21 }).success).toBe(false);
    expect(evidenceSearchSchema.safeParse({ query: '现金流', fields: ['unknown'] }).success).toBe(false);
  });
  it('filters financial fields before scoring even when excluded pages match the query', () => {
    const indexes = ['营业收入 100.00 90.00', '经营活动产生的现金流量净额 10.00 8.00'].map((text, i) => {
      const document = { ...documentFixture(), id: `field-${i}`, parsed: documentFixture().original };
      return { document, index: buildLexicalIndex(document, { schemaVersion: 1, pages: [{ filePage: 5, text }] }) };
    });
    expect(new Set(rankEvidence(indexes, '营业收入 现金流').map(hit => hit.document.id)).size).toBe(2);
    expect(rankEvidence(indexes, '营业收入 现金流', ['cash_flow']).map(hit => hit.document.id)).toEqual(['field-1']);
  });
  it('ranks split financial labels with adjacent original blocks and balances both periods', async () => {
    const receipt = await new HtmlTextParser().parse(Buffer.from('<p>主要会计数据和财务指标</p><p>经营活动产生</p><p>的现金流量净</p><p>额</p><p>66,593.25 36,698.60</p>'), 'text/html', { maxPages: 1, maxCharacters: 10000, signal: AbortSignal.timeout(5000) });
    const doc = { ...documentFixture(), bytesSha256: receipt.originalSha256, parsed: documentFixture().original };
    const chunk = documentChunks(receipt).find(c => c.text.startsWith('66,593'))!;
    const index = buildLexicalIndex(doc, receipt);
    expect(index.chunks.find(c => c.id === chunk.id)!.fields).toContain('cash_flow');
    expect(neighboringBlocks(receipt, chunk).map(b => b.text).join('')).toContain('经营活动产生的现金流量净额');
    expect(chunk.text).not.toContain('经营活动'); // Quotes remain at real individual block locations.
    const earlier = { ...doc, id: 'earlier', period: { ...doc.period, id: 'fy2023', start: '2023-01-01', end: '2023-12-31' } };
    const selected = selectEvidenceHits(rankEvidence([{ document: doc, index }, { document: earlier, index }], '比较两期经营现金流净额'), 2);
    expect(new Set(selected.map(h => h.document.period.id))).toEqual(new Set(['fy2023', 'fy2024']));
  });
});
