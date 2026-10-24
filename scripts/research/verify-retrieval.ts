import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildLexicalIndex, documentChunks, lexicalIndexVersion, rankEvidence, selectEvidenceHits } from '../../src/lib/company-research/lexical-index';
import { researchDocumentSchema } from '../../src/lib/company-research/document-contracts';
import { parsedDocumentV2Schema } from '../../src/lib/company-research/parsed-document';
import { cninfoDisclosure } from '../../src/lib/company-research/filing-acquisition';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';
import { buildBaselineIndex, rankBaseline } from './lexical-baseline-v1';
import { documentsInRetrievalScope, retrievalLabelsSchema, retrievalKs, scoreRetrievedPages, summarizeRetrievalScores, type RetrievalLabels, type RetrievalPageScore } from '../../src/lib/eval/research-retrieval-score';

type RetrievalMeta = { id: string; path: string; title: string; url: string; bytesSha256: string; byteLength: number; retrievedAt: string; period: { start: string; end: string; kind: 'annual' } };
type RetrievalCase = { id: string; company: { symbol: string; name: string }; documentIds: string[] };
const normalizedQuote = (s: string) => s.normalize('NFKC').replace(/\s/gu, '');
const argument = (name: string) => {
  const args = process.argv.slice(2), index = args.indexOf(`--${name}`);
  return args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) || (index < 0 ? undefined : args[index + 1]);
};

async function labeledBaseline(labelsFile: string, parsedRoot: string, baseline: boolean) {
  const labelsBytes = await readFile(labelsFile), labels = retrievalLabelsSchema.parse(JSON.parse(labelsBytes.toString()));
  const datasetPath = 'fixtures/company-research/development.json', documentsPath = 'fixtures/company-research/documents.json';
  const dataset: { cases: RetrievalCase[] } = JSON.parse(await readFile(datasetPath, 'utf8'));
  const manifest: { documents: RetrievalMeta[] } = JSON.parse(await readFile(documentsPath, 'utf8'));
  const cases = new Map(dataset.cases.map(c => [c.id, c]));
  const corpus: { documentId: string; originalSha256: string; parsedSha256: string; indexVersion: string; quality: string }[] = [];
  const results: { id: string; caseId: string; questionId: string; questionType: string; querySource: string; query: string; origin: string;
    observedRequest?: RetrievalLabels['queries'][number]['observedRequest']; expected: string[];
    retrievedByK: Record<number, { key: string; chunkId: string; score: number }[]>; score: RetrievalPageScore; scoresByEvidenceKind: Record<string, RetrievalPageScore> }[] = [];
  const scopedRuns: { id: string; indexVersionMatches: boolean; originalTopK: number | null; expected: string[]; outsideScopeGold: string[];
    status: string; retrievedByK: Record<number, { key: string; chunkId: string; score: number }[]>; score: RetrievalPageScore | null;
    atOriginalK: { hits: number; total: number; recall: number | null } | null }[] = [];
  const started = Date.now();
  for (const caseId of [...new Set(labels.queries.map(q => q.caseId))]) {
    const sample = cases.get(caseId); if (!sample) throw new Error(`Unknown labeled case: ${caseId}`);
    const indexes = [], oldIndexes = [], receipts = new Map<string, ReturnType<typeof parsedDocumentV2Schema.parse>>();
    const chunks = new Map<string, ReturnType<typeof documentChunks>>();
    for (const id of sample.documentIds) {
      const meta = manifest.documents.find(d => d.id === id); if (!meta) throw new Error(`Unknown document: ${id}`);
      const [bytes, original, announcement] = await Promise.all([readFile(path.join(parsedRoot, id + '.json')), readFile(meta.path), readFile(meta.path.replace(/\.pdf$/, '.announcement.json'))]);
      if (artifactDigest(original) !== meta.bytesSha256 || original.length !== meta.byteLength) throw new Error(`Original changed: ${id}`);
      const receipt = parsedDocumentV2Schema.parse(JSON.parse(bytes.toString()));
      if (receipt.originalSha256 !== meta.bytesSha256) throw new Error(`Parser identity mismatch: ${id}`);
      const document = researchDocumentSchema.parse({ schemaVersion: 1, id, taskId: randomUUID(), version: 1,
        company: { ...sample.company, exchange: sample.company.symbol.slice(-2) }, period: { ...meta.period, id: meta.period.end.slice(0, 4), basis: 'cumulative' },
        title: meta.title, url: meta.url, bytesSha256: meta.bytesSha256, mediaType: 'application/pdf', fetchedAt: meta.retrievedAt,
        disclosure: cninfoDisclosure(JSON.parse(announcement.toString()), announcement, 'https://www.cninfo.com.cn/new/hisAnnouncement/query').disclosure,
        original: { store: 'local', key: meta.bytesSha256, sha256: meta.bytesSha256, byteLength: original.length },
        parsed: { store: 'local', key: artifactDigest(bytes), sha256: artifactDigest(bytes), byteLength: bytes.length },
        state: receipt.status, pageCount: receipt.pageCount, parser: { ...receipt.parser, failedPages: receipt.failedPages, warnings: receipt.warnings } });
      receipts.set(id, receipt); chunks.set(id, documentChunks(receipt));
      if (baseline) oldIndexes.push({ document, index: buildBaselineIndex(receipt) });
      else indexes.push({ document, index: buildLexicalIndex(document, receipt) });
      corpus.push({ documentId: id, originalSha256: meta.bytesSha256, parsedSha256: artifactDigest(bytes), indexVersion: baseline ? 'zh-bigram-bm25-v1' : lexicalIndexVersion, quality: receipt.status });
    }
    for (const query of labels.queries.filter(q => q.caseId === caseId)) {
      for (const gold of query.expected) {
        const receipt = receipts.get(gold.documentId);
        if (!receipt || receipt.originalSha256 !== gold.bytesSha256) throw new Error(`Gold outside case or hash mismatch: ${query.id}`);
        const page = receipt.pages.find(p => p.filePage === gold.filePage);
        if (!page || receipt.failedPages.includes(gold.filePage) || !normalizedQuote(page.text).includes(normalizedQuote(gold.quote))) throw new Error(`Gold quote/page not present: ${query.id}:${gold.documentId}:${gold.filePage}`);
      }
      const ranked = baseline ? rankBaseline(oldIndexes, query.query) : rankEvidence(indexes, query.query);
      const chunkLookup = new Map([...chunks].map(([id, blocks]) => [id, new Map(blocks.map(b => [b.id, b]))]));
      const asHits = (hits: typeof ranked) => hits.map(hit => {
        const chunk = chunkLookup.get(hit.document.id)!.get(hit.chunkId)!;
        return { key: `${hit.document.id}:${chunk.locator.kind === 'html' ? 'html' : chunk.locator.filePage}`, chunkId: hit.chunkId, score: hit.score };
      });
      const seenPages = new Set<string>();
      const pageRanking = asHits(ranked).filter(hit => {
        if (seenPages.has(hit.key)) return false;
        seenPages.add(hit.key); return true;
      });
      const retrievedByK = Object.fromEntries(retrievalKs.map(k => [k, baseline ? pageRanking.slice(0, k) : asHits(selectEvidenceHits(ranked as ReturnType<typeof rankEvidence>, k))]));
      const expected = [...new Set(query.expected.map(g => `${g.documentId}:${g.filePage}`))];
      const scoresByEvidenceKind = Object.fromEntries([...new Set(query.expected.map(g => g.evidenceKind))].map(kind => [kind,
        scoreRetrievedPages(query.expected.filter(g => g.evidenceKind === kind).map(g => `${g.documentId}:${g.filePage}`), retrievedByK, pageRanking)]));
      results.push({ id: query.id, caseId, questionId: query.questionId, questionType: query.questionType, querySource: query.querySource, query: query.query, origin: query.origin,
        observedRequest: query.observedRequest, expected, retrievedByK, score: scoreRetrievedPages(expected, retrievedByK, pageRanking), scoresByEvidenceKind });
      if (query.observedRequest) {
        const request = query.observedRequest;
        const documents = (baseline ? oldIndexes : indexes).map(item => item.document);
        const allowed = new Set(documentsInRetrievalScope(documents, request).map(d => d.id));
        const scopedExpected = query.expected.filter(g => allowed.has(g.documentId)).map(g => `${g.documentId}:${g.filePage}`);
        const unsupported = baseline && request.fields.length > 0;
        const scopedRanked = unsupported ? [] : baseline ? rankBaseline(oldIndexes.filter(i => allowed.has(i.document.id)), query.query) : rankEvidence(indexes.filter(i => allowed.has(i.document.id)), query.query, request.fields);
        const seen = new Set<string>();
        const scopedPages = asHits(scopedRanked).filter(hit => { if (seen.has(hit.key)) return false; seen.add(hit.key); return true; });
        const scopeHits = (k: number) => baseline ? scopedPages.slice(0, k) : asHits(selectEvidenceHits(scopedRanked as ReturnType<typeof rankEvidence>, k));
        const scopedByK = Object.fromEntries(retrievalKs.map(k => [k, scopeHits(k)]));
        const originalHits = request.topK === null ? null : new Set(scopeHits(request.topK).map(h => h.key));
        const hits = originalHits ? scopedExpected.filter(key => originalHits.has(key)).length : null;
        scopedRuns.push({ id: query.id, indexVersionMatches: request.indexVersion === (baseline ? 'zh-bigram-bm25-v1' : lexicalIndexVersion),
          originalTopK: request.topK, expected: scopedExpected, outsideScopeGold: expected.filter(key => !scopedExpected.includes(key)),
          status: unsupported ? 'baseline_v1_field_filter_unsupported' : scopedExpected.length ? 'scored_with_original_filters' : 'no_gold_in_original_scope',
          retrievedByK: scopedByK, score: !unsupported && scopedExpected.length ? scoreRetrievedPages(scopedExpected, scopedByK, scopedPages) : null,
          atOriginalK: !unsupported && hits !== null ? { hits, total: scopedExpected.length, recall: scopedExpected.length ? hits / scopedExpected.length : null } : null });
      }
    }
  }
  const byType = Object.fromEntries([...new Set(results.map(r => r.questionType))].map(type => [type, summarizeRetrievalScores(results.filter(r => r.questionType === type).map(r => r.score))]));
  const bySource = Object.fromEntries(['canonical', 'observed'].map(source => [source, summarizeRetrievalScores(results.filter(r => r.querySource === source).map(r => r.score))]));
  const byEvidenceKind = Object.fromEntries(['numeric', 'causal_explanation', 'disclosure_scope', 'risk_statement'].map(kind => [kind,
    summarizeRetrievalScores(results.flatMap(r => r.scoresByEvidenceKind[kind] ? [r.scoresByEvidenceKind[kind]] : []))]));
  const sourceFiles = ['src/lib/company-research/lexical-index.ts', 'scripts/research/lexical-baseline-v1.ts', 'scripts/research/verify-retrieval.ts', 'src/lib/eval/research-retrieval-score.ts'];
  const report = { schemaVersion: 2, labelsVersion: labels.version, labelsStatus: labels.status,
    indexVersion: baseline ? 'zh-bigram-bm25-v1' : lexicalIndexVersion, parserRoot: parsedRoot,
    sourceSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, artifactDigest(await readFile(file))]))),
    fixtureSha256: { development: artifactDigest(await readFile(datasetPath)), documents: artifactDigest(await readFile(documentsPath)), labels: artifactDigest(labelsBytes) },
    corpus, k: retrievalKs, granularity: 'unique source/file-page', mrrGranularity: 'first gold page in unrestricted unique-page ranking',
    queryProtocol: 'summary/byType/bySource/byEvidenceKind use query text over both case reports without original filters; observedScope separately preserves original document/period/field filters',
    summary: summarizeRetrievalScores(results.map(r => r.score)), byType, bySource, byEvidenceKind,
    observedScope: { queries: scopedRuns.length, scoredQueries: scopedRuns.filter(r => r.score !== null).length, outsideScopeGold: scopedRuns.reduce((n, r) => n + r.outsideScopeGold.length, 0),
      summary: summarizeRetrievalScores(scopedRuns.flatMap(r => r.score ? [r.score] : [])), results: scopedRuns }, elapsedMs: Date.now() - started,
    limitations: labels.notes, modelCalls: 0, embedding: false, reranker: false, results };
  const root = path.resolve(argument('output-dir') || path.join('data/research-agent-upgrade/evidence/U05', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const metricsTable = (Object.entries(byType).map(([type, s]) => `| ${type} | ${s.queryCount} | ${retrievalKs.map(k => s.atK[k].recall?.toFixed(4) ?? 'unknown').join(' | ')} | ${s.mrr?.toFixed(4) ?? 'unknown'} |`)).join('\n');
  const evidenceTable = Object.entries(byEvidenceKind).map(([kind, s]) => `| ${kind} | ${s.queryCount} | ${s.atK[5].hits}/${s.atK[5].total} | ${s.mrr?.toFixed(4) ?? 'unknown'} |`).join('\n');
  await writeFile(path.join(root, 'report.md'), `# U05 检索基线\n\n索引 ${report.indexVersion}；标签 ${labels.version}（${labels.status}）。只运行检索，无模型调用。\n\n${labels.notes}\n\n下表是 query 文本在统一两期语料上的基线，未施加历史调用过滤条件。问型 cash_flow_disclosure_scope 可以同时含因果页和范围页；严格页证据类型另列。\n\n| 类型 | 查询数 | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR |\n| --- | --- | --- | --- | --- | --- | --- |\n${metricsTable}\n\n| 页证据类型 | 含该类型查询数 | 命中页@5/金标页 | MRR |\n| --- | --- | --- | --- |\n${evidenceTable}\n\n原始过滤范围查询 ${scopedRuns.length} 条，按范围内金标可评分 ${report.observedScope.scoredQueries} 条，范围外金标 ${report.observedScope.outsideScopeGold} 条，全部记录保留在 observedScope。该组沿用原 documentIds/periodIds/fields，并另记原 topK 命中；它使用当前语料和索引，不重放历史字符截断、模型上下文或语义判断。baseline-v1 不支持字段过滤时明确标不可评分。\n\n完整分母、query 来源、语料/解析/源码 hash 及逐题结果见同目录 report.json。MRR 按完整唯一页排名计算；Recall@k 使用对应 k 的实际选择结果。默认 BM25 v4 的两期覆盖策略不保证不同 k 的结果为前缀。\n`, { flag: 'wx' });
  console.log(JSON.stringify({ evidence: root, summary: report.summary, byType, bySource, elapsedMs: report.elapsedMs }));
}
async function main() {
  const baseline = process.argv.includes('--profile=baseline-v1');
  const candidates = (await readdir('data/research-agent-upgrade/evidence/S07', { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
  const labels = argument('labels');
  const parsedRoot = argument('parsed-root') || process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && (i === 0 || !['--labels', '--output-dir', '--parsed-root'].includes(all[i - 1]))) || path.join('data/research-agent-upgrade/evidence/S07', candidates[0]);
  if (labels) return labeledBaseline(labels, parsedRoot, baseline);
  const root = path.resolve('data/research-agent-upgrade/evidence/S10', new Date().toISOString().replace(/[:.]/g, '-')); await mkdir(root, { recursive: true });
  const dataset = JSON.parse(await readFile('fixtures/company-research/development.json', 'utf8'));
  const manifest = JSON.parse(await readFile('fixtures/company-research/documents.json', 'utf8'));
  const results = [], corpus = []; let hits = 0, denominator = 0;
  const started = Date.now();
  for (const c of dataset.cases) {
    const indexes = [], baselineIndexes = [], chunks = new Map<string, ReturnType<typeof documentChunks>>();
    for (const meta of manifest.documents.filter((d: {id: string}) => c.documentIds.includes(d.id))) {
      const bytes = await readFile(path.join(parsedRoot, meta.id + '.json')), receipt = parsedDocumentV2Schema.parse(JSON.parse(bytes.toString()));
      const announcement = await readFile(meta.path.replace(/\.pdf$/, '.announcement.json'));
      const document = researchDocumentSchema.parse({ schemaVersion: 1, id: meta.id, taskId: randomUUID(), version: 1, company: { ...c.company, exchange: c.company.symbol.slice(-2) },
        period: { ...meta.period, id: meta.period.end.slice(0, 4), basis: 'cumulative' }, title: meta.title, url: meta.url, bytesSha256: meta.bytesSha256, mediaType: 'application/pdf', fetchedAt: meta.retrievedAt,
        disclosure: cninfoDisclosure(JSON.parse(announcement.toString()), announcement, 'https://www.cninfo.com.cn/new/hisAnnouncement/query').disclosure,
        original: { store: 'local', key: meta.bytesSha256, sha256: meta.bytesSha256, byteLength: meta.byteLength },
        parsed: { store: 'local', key: artifactDigest(bytes), sha256: artifactDigest(bytes), byteLength: bytes.length }, state: receipt.status, pageCount: receipt.pageCount, parser: { ...receipt.parser, failedPages: receipt.failedPages, warnings: receipt.warnings } });
      corpus.push({ documentId: meta.id, originalSha256: meta.bytesSha256, parsedSha256: artifactDigest(bytes), parser: receipt.parser });
      if (baseline) baselineIndexes.push({ document, index: buildBaselineIndex(receipt) });
      else indexes.push({ document, index: buildLexicalIndex(document, receipt) });
      chunks.set(meta.id, documentChunks(receipt));
    }
    for (const q of c.questions) {
      const expectedRaw = q.id === 'q3' ? c.reference.riskCitations : c.reference.facts.filter((f: {metric: string}) => q.id === 'q2' ? f.metric === 'operating_cash_flow' : ['revenue', 'parent_net_profit'].includes(f.metric)).map((f: {citation: unknown}) => f.citation);
      const expected = [...new Set<string>(expectedRaw.map((r: {documentId: string; filePage: number}) => `${r.documentId}:${r.filePage}`))];
      const ranked = baseline ? rankBaseline(baselineIndexes, q.text) : selectEvidenceHits(rankEvidence(indexes, q.text), 5);
      const retrieved: { key: string; chunkId: string; score: number }[] = [], perPage = new Map<string, number>();
      for (const r of ranked) {
        const loc = chunks.get(r.document.id)!.find(b => b.id === r.chunkId)!.locator;
        const key = `${r.document.id}:${loc.kind === 'html' ? 'html' : loc.filePage}`;
        if (baseline && (perPage.get(key) || 0) >= 2) continue;
        retrieved.push({ key, chunkId: r.chunkId, score: r.score });
        perPage.set(key, (perPage.get(key) || 0) + 1); if (retrieved.length === 5) break;
      }
      const matched = expected.filter(e => retrieved.some(r => r.key === e)); hits += matched.length; denominator += expected.length;
      results.push({ caseId: c.id, questionId: q.id, query: q.text, expected, retrieved, hits: matched.length, denominator: expected.length });
    }
  }
  assert.equal(results.length, 12); assert.equal(denominator, 24);
  const sourceSha256 = Object.fromEntries(await Promise.all(['src/lib/company-research/lexical-index.ts', 'scripts/research/lexical-baseline-v1.ts', 'scripts/research/verify-retrieval.ts'].map(async file => [file, artifactDigest(await readFile(file))])));
  const report = { indexVersion: baseline ? 'zh-bigram-bm25-v1' : lexicalIndexVersion, parserRoot: parsedRoot, sourceSha256,
    fixtureSha256: { development: artifactDigest(await readFile('fixtures/company-research/development.json')), documents: artifactDigest(await readFile('fixtures/company-research/documents.json')) }, corpus,
    k: 5, maxHitsPerPage: baseline ? 2 : 1, granularity: 'unique source/file-page per question', queryCount: 12, hits, denominator, recallAt5: hits / denominator,
    fullyCoveredQuestions: results.filter(r => r.hits === r.denominator).length, elapsedMs: Date.now() - started,
    scope: 'frozen development only; company/two-period/date metadata fixed before lexical ranking', modelCalls: 0, embedding: false, reranker: false, results };
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidence: root, hits, denominator, fullyCoveredQuestions: report.fullyCoveredQuestions, elapsedMs: report.elapsedMs }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
