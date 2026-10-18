// Frozen first S10 development baseline. Keep independent of subsequent ranking profiles.
import { lexicalTokens, documentChunks } from '../../src/lib/company-research/lexical-index';
import type { ResearchDocument } from '../../src/lib/company-research/document-contracts';
interface BaselineIndex { chunks: { id: string; length: number; terms: Record<string, number> }[] }
export function buildBaselineIndex(receipt: unknown): BaselineIndex {
  return { chunks: documentChunks(receipt).map(c => {
    const tokens = lexicalTokens(c.text), terms: Record<string, number> = Object.create(null);
    for (const token of tokens) if (token.length <= 200) terms[token] = (terms[token] || 0) + 1;
    return { id: c.id, length: Math.max(1, tokens.length), terms };
  }) };
}
// V1 aliases intentionally differ from later profiles. No major-risk section or context features.
function tokens(query: string) {
  const aliases = [
    [/收入/, '营业收入 营业总收入'], [/归母|净利润/, '归属于上市公司股东的净利润 归属于母公司股东的净利润'],
    [/现金流/, '经营活动产生的现金流量净额 经营活动现金流'], [/风险/, '主要风险 可能面临的风险 风险因素'],
  ] as const;
  return [...new Set(lexicalTokens(query + ' ' + aliases.filter(([p]) => p.test(query)).map(([, t]) => t).join(' ')))];
}
export function rankBaseline(indexes: { document: ResearchDocument; index: BaselineIndex }[], query: string) {
  const queries = tokens(query), entries = indexes.flatMap(({ document, index }) => index.chunks.map(chunk => ({ document, chunk })));
  const average = entries.reduce((sum, e) => sum + e.chunk.length, 0) / Math.max(1, entries.length), frequency = new Map<string, number>();
  for (const token of queries) frequency.set(token, entries.filter(e => e.chunk.terms[token]).length);
  return entries.map(({ document, chunk }) => {
    let score = 0;
    for (const token of queries) {
      const tf = chunk.terms[token] || 0; if (!tf) continue;
      const df = frequency.get(token) || 0, idf = Math.log(1 + (entries.length - df + .5) / (df + .5));
      score += idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * chunk.length / Math.max(1, average)));
    }
    return { document, chunkId: chunk.id, score };
  }).filter(e => e.score > 0).sort((a, b) => b.score - a.score || `${a.document.id}:${a.chunkId}`.localeCompare(`${b.document.id}:${b.chunkId}`));
}
