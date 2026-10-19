import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parsedDocumentV2Schema } from '../../src/lib/company-research/parsed-document';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';
import { createResearchTask, getResearchTask } from '../../src/lib/company-research/version-store';
import { queueFinancialResearch, claimFinancialResearch, saveResearchCheckpoint } from '../../src/lib/company-research/execution-store';
import { cancelResearchTask } from '../../src/lib/company-research/attempt-store';
import { registerResearchDocument } from '../../src/lib/company-research/document-store';
import { readResearchSource } from '../../src/lib/company-research/source-reader';
import { emptyCheckpoint } from '../../src/lib/company-research/execution-contracts';
import { specFixture, documentFixture } from '../../src/lib/company-research/version-test-fixtures';
import type { ResearchRepositoryContext } from '../../src/lib/company-research/repository-core';
export async function verifyRetainedScanReader(root: string, actor: string, ctx: ResearchRepositoryContext) {
  const scanMeta = JSON.parse(await readFile('fixtures/company-research/derived-scan.json', 'utf8'));
  const manifest = JSON.parse(await readFile('fixtures/company-research/documents.json', 'utf8'));
  const parent = manifest.documents.find((d: { id: string }) => d.id === scanMeta.sourceDocumentId);
  if (!parent || parent.bytesSha256 !== scanMeta.sourceBytesSha256) throw new Error('Derived scan parent mismatch');
  const original = await readFile(scanMeta.path), parsed = await readFile('data/research-agent-upgrade/evidence/S08/service-2026-10-19T04-06-33-475Z/scan.json');
  const receipt = parsedDocumentV2Schema.parse(JSON.parse(parsed.toString()));
  if (artifactDigest(original) !== receipt.originalSha256 || artifactDigest(original) !== scanMeta.bytesSha256) throw new Error('Retained scan hash mismatch');
  const task = (await createResearchTask(actor, specFixture(), randomUUID(), ctx))!;
  const ref = (b: Buffer) => ({ store: 'local' as const, key: artifactDigest(b), sha256: artifactDigest(b), byteLength: b.length });
  const document = { ...documentFixture(task.id), id: 'scan-maotai-2024-p5', url: parent.url, title: '贵州茅台 2024 年报第 5 页 · 派生扫描验收样本', original: ref(original), parsed: ref(parsed), bytesSha256: artifactDigest(original), pageCount: receipt.pageCount, state: receipt.status, parser: { ...receipt.parser, failedPages: receipt.failedPages, warnings: receipt.warnings },
    disclosure: { status: 'unknown' as const, reason: '原公开 PDF 的派生扫描样本，仅作 OCR/定位验收，不能据此回溯历史结论' } };
  await registerResearchDocument(actor, document, original, parsed, ctx);
  const table = receipt.pages.flatMap(p => p.blocks).find(b => b.table?.cells.some(c => c.text === '170,899,152,276.34'))!;
  const cell = table.table!.cells.find(c => c.text === '170,899,152,276.34')!;
  await queueFinancialResearch(actor, task.id, 0, ctx); const attempt = (await claimFinancialResearch('scan-reader', ctx))!.attempt;
  const state = emptyCheckpoint(1, 1);
  state.claims = [{ id: 'scan-revenue', questionId: 'income_profit', text: '扫描表格中的营业收入数值定位演练；待复核，不作为已验收业务事实。', kind: 'fact', status: 'evidence_gap', reason: '派生扫描资料，时间与 OCR 质量不能升级为历史研究事实', factIds: [], citations: [{ documentId: document.id, documentVersion: 1, bytesSha256: document.bytesSha256,
    locator: { kind: 'table', filePage: 1, tableId: table.table!.id, row: cell.row, column: cell.column, ...(cell.box ? { box: cell.box } : {}) }, quote: cell.text }] }];
  await saveResearchCheckpoint(actor, attempt, state, 'scan-reader', ctx); await cancelResearchTask(actor, task.id, ctx);
  const source = await readResearchSource(actor, task.id, { reportRevision: 0, claimId: 'scan-revenue', citationIndex: 0 }, ctx);
  if (source.quality !== 'needs_review' || !source.coordinate || source.selectedCell?.row !== cell.row || source.selectedCell?.column !== cell.column) throw new Error('Scan locator reconciliation failed');
  await writeFile(path.join(root, 'scan-case.json'), JSON.stringify(await getResearchTask(actor, task.id, ctx), null, 2));
  await writeFile(path.join(root, 'scan-case-sources.json'), JSON.stringify([source], null, 2));
  return { bytesSha256: document.bytesSha256, parser: receipt.parser, selectedCell: source.selectedCell, coordinate: source.coordinate, quality: source.quality, scope: 'real retained OCR output over rasterized public PDF page; synthetic degradation, not a naturally scanned annual report' };
}
