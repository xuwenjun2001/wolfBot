import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { NativePdfParser, HtmlTextParser } from '../../src/lib/company-research/text-parser';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';
import type { ParsedDocument } from '../../src/lib/company-research/parsed-document';
async function main() {
  const root = path.resolve('data/research-agent-upgrade/evidence/S07', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(root, { recursive: true });
  const manifest = JSON.parse(await readFile('fixtures/company-research/documents.json', 'utf8'));
  const dataset = JSON.parse(await readFile('fixtures/company-research/development.json', 'utf8'));
  const outputs = new Map<string, ParsedDocument>(), reports = [];
  const options = { maxPages: 500, maxCharacters: 5_000_000, signal: AbortSignal.timeout(300000) };
  const parser = new NativePdfParser();
  for (const doc of manifest.documents) {
    const started = Date.now(), bytes = await readFile(doc.path), output = await parser.parse(bytes, 'application/pdf', options);
    assert.equal(artifactDigest(bytes), doc.bytesSha256); assert.equal(output.pageCount, doc.pageCount); assert.equal(output.status, 'ready');
    const receipt = Buffer.from(JSON.stringify(output)); await writeFile(path.join(root, `${doc.id}.json`), receipt);
    outputs.set(doc.id, output); reports.push({ id: doc.id, pages: output.pageCount, blocks: output.pages.reduce((n, p) => n + p.blocks.length, 0), elapsedMs: Date.now() - started, receiptSha256: artifactDigest(receipt) });
  }
  const normal = (s: string) => s.normalize('NFKC').replace(/\s+/g, ''); let hits = 0;
  for (const c of dataset.cases) for (const citation of [...c.reference.facts.map((f: { citation: unknown }) => f.citation), ...c.reference.riskCitations]) {
    const page = outputs.get(citation.documentId)!.pages.find(p => p.filePage === citation.filePage)!;
    assert(normal(page.text).includes(normal(citation.quote))); hits++;
  }
  const first = manifest.documents[0], again = await parser.parse(await readFile(first.path), 'application/pdf', { ...options, maxPages: 2 });
  assert.equal(again.status, 'partial'); assert.equal(again.truncatedPages.length, first.pageCount - 2);
  assert.deepEqual(again.pages, outputs.get(first.id)!.pages.slice(0, 2));
  const html = await new HtmlTextParser().parse(Buffer.from('<html><body><h1>公开财报</h1><p>收入 100 万元</p><script>ignore</script></body></html>'), 'text/html', options);
  assert.equal(html.pages[0].blocks[1].text, '收入 100 万元');
  // A real page boundary is retained as two locators; no synthetic bounding box or joined page is invented.
  const cross = outputs.get('600519-2023-annual')!;
  const crossPage = [35, 36].map(n => ({ filePage: n, blocks: cross.pages.find(p => p.filePage === n)!.blocks }));
  assert(crossPage[0].blocks.some(b => b.text.includes('分布在公司本部老厂区及中华片区')));
  assert(crossPage[1].blocks.some(b => b.text.includes('和义兴酒业分公司大地片区')));
  await writeFile(path.join(root, 'cross-page.json'), JSON.stringify(crossPage));
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ reports, citationHits: hits, citationDenominator: hits, repeatedIdsStable: true, truncationVisible: true, html, crossPage: 'cross-page.json', manualSemanticReview: false }, null, 2));
  console.log(JSON.stringify({ evidence: root, documents: reports.length, citationHits: hits, repeatedIdsStable: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
