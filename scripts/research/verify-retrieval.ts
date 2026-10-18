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
async function main() {
  const baseline = process.argv.includes('--profile=baseline-v1');
  const candidates = (await readdir('data/research-agent-upgrade/evidence/S07', { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
  const parsedRoot = process.argv.slice(2).find(a => !a.startsWith('--')) || path.join('data/research-agent-upgrade/evidence/S07', candidates[0]);
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
