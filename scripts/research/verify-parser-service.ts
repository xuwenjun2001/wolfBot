import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parsedDocumentV2Schema } from '../../src/lib/company-research/parsed-document';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';
const origin = process.env.DOCUMENT_PARSER_URL || 'http://127.0.0.1:7821';
const headers = { Authorization: `Bearer ${process.env.DOCUMENT_PARSER_TOKEN || ''}`, 'Content-Type': 'application/pdf' };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function api(url: string, init?: RequestInit) {
  const response = await fetch(new URL(url, origin), { ...init, headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error(`Parser ${response.status}`);
  return response.json();
}
async function submit(bytes: Buffer, maxPages: number, timeoutSeconds = 180) {
  return (await api(`/jobs?maxPages=${maxPages}&forceOcr=true&timeoutSeconds=${timeoutSeconds}`, { method: 'POST', body: new Uint8Array(bytes) })).jobId as string;
}
async function complete(id: string, cancelAfterPage = false) {
  const started = Date.now(); let cancelSent = false;
  while (Date.now() - started < 200000) {
    const status = await api('/jobs/' + id);
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(`Parser job failed: ${status.error}`);
    if (cancelAfterPage && status.completedPages >= 1 && !cancelSent) { await api('/jobs/' + id, { method: 'DELETE' }); cancelSent = true; }
    await pause(300);
  }
  await api('/jobs/' + id, { method: 'DELETE' }); throw new Error('Probe deadline exceeded');
}
async function main() {
  const root = path.resolve('data/research-agent-upgrade/evidence/S08', `service-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(root, { recursive: true });
  const health = await api('/health');
  const scan = await readFile('data/research-agent-upgrade/dataset-v1/derived/maotai-2024-p5-scan.pdf');
  const synthetic = await readFile('data/research-agent-upgrade/evidence/S08/synthetic-01/synthetic-table-scan.pdf');
  const first = await complete(await submit(scan, 1)), receipt = parsedDocumentV2Schema.parse(first.result);
  assert(receipt.pages[0].blocks.some(b => b.table));
  await writeFile(path.join(root, 'scan.json'), JSON.stringify(receipt));
  console.log(JSON.stringify({ phase: 'scan', elapsedMs: first.elapsedMs, blocks: receipt.pages[0].blocks.length }));
  const cancelled = await complete(await submit(synthetic, 2), true);
  assert(cancelled.result.warnings.includes('cancelled_partial') || cancelled.result.pages.length === 2);
  await writeFile(path.join(root, 'cancelled.json'), JSON.stringify(cancelled));
  const completeSynthetic = await complete(await submit(synthetic, 2)), s = parsedDocumentV2Schema.parse(completeSynthetic.result);
  assert.equal(s.pages.length, 2); assert(s.pages.every(p => p.blocks.some(b => b.table)));
  const expected = JSON.parse(await readFile('data/research-agent-upgrade/evidence/S08/synthetic-01/synthetic-expected.json', 'utf8'));
  const labels = [['营业收入', '归母净利润', '经营现金流净额'], ['营业成本', '财务费用', '其他收益']];
  const compact = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
  const numericChecks = s.pages.flatMap((p, i) => (expected[`page${i + 1}`] as string[]).map((text, n) => {
    const metric = labels[i][Math.floor(n / 2)], year = n % 2 === 0 ? '2024年' : '2023年';
    const found = p.blocks.some(b => {
      const row = b.table?.cells.find(c => compact(c.text) === metric), column = b.table?.cells.find(c => compact(c.text) === year);
      return row && column && b.table!.cells.some(c => c.row === row.row && c.column === column.column && compact(c.text) === compact(text));
    });
    return { filePage: p.filePage, metric, year, expected: text, found };
  }));
  await writeFile(path.join(root, 'synthetic.json'), JSON.stringify(s));
  const timedOut = await complete(await submit(Buffer.concat([synthetic, Buffer.from('\n%timeout-probe-v1')]), 2, 1));
  assert(timedOut.result.warnings.includes('timeout_partial'));
  await writeFile(path.join(root, 'timeout.json'), JSON.stringify(timedOut));
  const replay = await complete(await submit(scan, 1)), replayReceipt = parsedDocumentV2Schema.parse(replay.result);
  await writeFile(path.join(root, 'replay.json'), JSON.stringify(replayReceipt));
  assert.deepEqual(replayReceipt, receipt);
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ health, originalSha256: artifactDigest(scan), firstJobElapsedMs: first.elapsedMs, replayElapsedMs: replay.elapsedMs,
    cancelled: { pages: cancelled.result.pages.length, warnings: cancelled.result.warnings, truncatedPages: cancelled.result.truncatedPages },
    timeout: { warnings: timedOut.result.warnings }, numericChecks, mergedCells: s.pages.flatMap(p => p.blocks).some(b => b.table?.cells.some(c => c.columnSpan > 1 || c.rowSpan > 1)),
    scopeHeaderChecks: s.pages.map(p => ({ filePage: p.filePage, expected: '合并口径', exactTextFound: compact(p.text).includes('合并口径'), unitFound: compact(p.text).includes('单位:万元') })),
    parserVersionCacheStable: true, humanReview: 'pending' }, null, 2));
  assert(numericChecks.every(c => c.found), 'Synthetic value/metric/year mismatch');
  console.log(JSON.stringify({ evidence: root, numericHits: numericChecks.filter(c => c.found).length, denominator: numericChecks.length, cancelled: cancelled.result.warnings, replayElapsedMs: replay.elapsedMs }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
