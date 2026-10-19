import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/client';
import { ResearchArtifactStore, artifactDigest } from './artifact-store';
import { createResearchTask, appendResearchPlan, getResearchReportRevision } from './version-store';
import { registerResearchDocument, readResearchDocumentArtifact } from './document-store';
import { parseResearchDocument } from './parse-service';
import { startResearchAttempt } from './attempt-store';
import { commitResearchReport } from './report-store';
import { researchTaskSpecSchema, type ResearchTaskSpec } from './task-contracts';
import { documentFixture, reportFixture, specFixture } from './version-test-fixtures';
import { researchEvidencePeriods } from './evidence-periods';
import { deriveSingleQuarter } from './financial-comparison';
import { searchResearchEvidence, readResearchEvidence } from './evidence-retrieval';
import type { FinancialFact } from './document-contracts';
import { parsedDocumentV2Schema } from './parsed-document';

const actor = `review-regression-${randomUUID()}`;
const ctx = { db: prisma, artifacts: new ResearchArtifactStore(path.resolve('data/research-agent-upgrade/evidence/review-fixes-20261019', actor)) };
const ref = (b: Buffer) => ({ store: 'local' as const, key: artifactDigest(b), sha256: artifactDigest(b), byteLength: b.length });
async function create(spec = specFixture()) {
  const task = (await createResearchTask(actor, spec, randomUUID(), ctx))!;
  await appendResearchPlan(actor, task.id, 0, randomUUID(), { schemaVersion: 1, taskId: task.id, requestRevision: 1, revision: 1, createdAt: new Date().toISOString(), steps: [{ id: 'verify', questionId: 'cash_flow', kind: 'verify', title: '检查证据' }] }, ctx);
  return task;
}
async function attach(taskId: string, spec: ResearchTaskSpec, id: string, period: ResearchTaskSpec['periods'][number], text: string, heading = `贵州茅台${period.end.slice(0, 4)}年报告`) {
  const original = Buffer.from(`<html><h1>${heading}</h1>${text}</html>`);
  await registerResearchDocument(actor, { ...documentFixture(taskId, spec), id, period, mediaType: 'text/html', original: ref(original), bytesSha256: artifactDigest(original) }, original, undefined, ctx);
  const parsed = await parseResearchDocument(actor, taskId, id, 1, {}, AbortSignal.timeout(5000), ctx);
  const receipt = parsedDocumentV2Schema.parse(JSON.parse((await readResearchDocumentArtifact(actor, taskId, id, 2, 'parsed', ctx)).bytes.toString()));
  const citation = (block: number) => ({ documentId: id, documentVersion: 2, bytesSha256: parsed.document.bytesSha256, quote: receipt.pages[0].blocks[block].text, locator: receipt.pages[0].blocks[block].locator });
  return { document: parsed.document, citation };
}

describe.skipIf(process.env.COMPANY_RESEARCH_TEST_POSTGRES !== '1')('review regressions through PostgreSQL publication', () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.DATABASE_URL !== process.env.RESEARCH_TEST_DATABASE_URL || !['127.0.0.1', 'localhost'].includes(url.hostname) || !/^\/research_test/.test(url.pathname)) throw new Error('Disposable database required');
  });
  afterAll(async () => { await prisma.$executeRaw`DELETE FROM company_research_tasks WHERE actor_id=${actor}`; await prisma.$disconnect(); });
  it('rejects issuer/year failures for facts and claim-only reports without publishing a revision', async () => {
    const task = await create(), source = await attach(task.id, task.spec, 'wrong-issuer', task.spec.periods[1], '<p>经营现金流原文测试</p>', '另一企业2022年报告');
    expect(source.document.state).toBe('unreadable');
    const report = reportFixture(task.id), c = source.citation(1);
    report.facts[0].citations = [c]; report.claims[0].citations = [c];
    const attempt = await startResearchAttempt(actor, task.id, 1, 'review-test', ctx);
    await expect(commitResearchReport(actor, attempt, 0, report, ctx)).rejects.toThrow('CITATION_DOCUMENT_UNUSABLE');
    await expect(commitResearchReport(actor, attempt, 0, { ...report, facts: [], claims: [{ ...report.claims[0], factIds: [] }] }, ctx)).rejects.toThrow('CITATION_DOCUMENT_UNUSABLE');
    expect(await getResearchReportRevision(actor, task.id, 1, ctx)).toBeNull();
  });
  it('publishes a restated prior-year fact only with real located period evidence', async () => {
    const task = await create(), source = await attach(task.id, task.spec, 'restated', task.spec.periods[1], '<p>2023年（调整后）</p><p>经营现金流 100.00 元</p>');
    const report = reportFixture(task.id);
    Object.assign(report.facts[0], { period: task.spec.periods[0], restatement: 'restated', accountingBasis: 'restatement-2024', value: { status: 'known', raw: '100.00', unit: 'yuan', currency: 'CNY', decimals: 2 }, citations: [source.citation(2)], periodEvidence: [source.citation(1)] });
    report.claims[0].citations = [source.citation(2)];
    const attempt = await startResearchAttempt(actor, task.id, 1, 'review-test', ctx);
    await expect(commitResearchReport(actor, attempt, 0, { ...report, facts: [{ ...report.facts[0], periodEvidence: [] }] }, ctx)).rejects.toThrow('CITATION_PERIOD_MISMATCH');
    const forged = structuredClone(report); forged.facts[0].periodEvidence![0].quote = '2023年（伪造列头）';
    await expect(commitResearchReport(actor, attempt, 0, forged, ctx)).rejects.toThrow('CITATION_LOCATOR_MISMATCH');
    await commitResearchReport(actor, attempt, 0, report, ctx);
    expect((await getResearchReportRevision(actor, task.id, 1, ctx))!.facts[0].period.id).toBe('fy2023');
  });
  it('imports, retrieves and publishes quarter inputs while rejecting unrelated periods and forged arithmetic', async () => {
    const spec = researchTaskSpecSchema.parse({ ...specFixture(), periods: [2023, 2024].map(y => ({ id: `${y}Q2`, start: `${y}-04-01`, end: `${y}-06-30`, kind: 'quarter', basis: 'single_quarter' })) });
    const task = await create(spec), periods = researchEvidencePeriods(spec);
    const h1Period = periods.find(p => p.id === 'ytd_2024_06')!, q1Period = periods.find(p => p.id === 'ytd_2024_03')!;
    const h1 = await attach(task.id, spec, 'half-year', h1Period, '<p>经营活动产生的现金流量净额 250.00 元</p>');
    const q1 = await attach(task.id, spec, 'first-quarter', q1Period, '<p>经营活动产生的现金流量净额 100.00 元</p>');
    await expect(attach(task.id, spec, 'unrelated', { id: 'fy2024', start: '2024-01-01', end: '2024-12-31', kind: 'annual', basis: 'cumulative' }, '<p>不相关资料</p>')).rejects.toThrow('Document task/company/period mismatch');
    const search = await searchResearchEvidence(actor, task.id, { query: '现金流', periodIds: [h1Period.id, q1Period.id] }, ctx);
    expect(search.scopedDocumentCount).toBe(2); expect(new Set(search.hits.map(h => h.periodId))).toEqual(new Set([h1Period.id, q1Period.id]));
    const hit = search.hits[0]; expect((await readResearchEvidence(actor, task.id, { documentId: hit.sourceId, documentVersion: hit.documentVersion, locator: hit.locator }, ctx)).text.length).toBeGreaterThan(0);
    const report = reportFixture(task.id, spec), base = report.facts[0];
    const input = (id: string, raw: string, period: typeof h1Period, citation: ReturnType<typeof h1.citation>): FinancialFact => ({ ...base, id, period, value: { status: 'known', raw, unit: 'yuan', currency: 'CNY', decimals: 0 }, citations: [citation] });
    const current = input('h1', '250', h1Period, h1.citation(1)), preceding = input('q1', '100', q1Period, q1.citation(1));
    const quarter = deriveSingleQuarter(current, preceding);
    report.facts = [quarter]; report.supportingFacts = [current, preceding]; report.claims[0].factIds = [quarter.id]; report.claims[0].citations = quarter.citations;
    const attempt = await startResearchAttempt(actor, task.id, 1, 'review-test', ctx);
    const forged = structuredClone(report); forged.facts[0].value = { status: 'known', raw: '151', unit: 'yuan', currency: 'CNY', decimals: 0 };
    await expect(commitResearchReport(actor, attempt, 0, forged, ctx)).rejects.toThrow('DERIVED_FACT_MISMATCH');
    await expect(commitResearchReport(actor, attempt, 0, { ...report, supportingFacts: [] }, ctx)).rejects.toThrow('DERIVED_INPUT_INVALID');
    await commitResearchReport(actor, attempt, 0, report, ctx);
    const saved = (await getResearchReportRevision(actor, task.id, 1, ctx))!;
    expect(saved.facts[0].value).toMatchObject({ raw: '150' }); expect(saved.supportingFacts).toHaveLength(2);
  });
  it('returns the cash-flow row and its cells while leaving the old index version unused', async () => {
    const task = await create(), original = Buffer.from('%PDF-review-table-fixture');
    const labels = ['指标', '营业收入', ...Array.from({ length: 38 }, (_, i) => `其他财务项目${i}${'说明'.repeat(20)}`), '经营活动产生的现金流量净额'];
    const cells = labels.flatMap((label, row) => [label, row ? '100.00' : '2024', row ? '90.00' : '2023'].map((text, column) => ({ row, column, rowSpan: 1, columnSpan: 1, text, header: row === 0 || column === 0 })));
    const text = cells.map(c => c.text).join('\n');
    const receipt = parsedDocumentV2Schema.parse({ schemaVersion: 2, originalSha256: artifactDigest(original), mediaType: 'application/pdf', parser: { name: 'table-fixture', version: '1' }, pageCount: 1, status: 'partial', failedPages: [], truncatedPages: [], warnings: [],
      pages: [{ filePage: 1, text, blocks: [{ id: 'table_review', order: 0, kind: 'table', text, locator: { kind: 'block', filePage: 1, blockId: 'table_review' }, quality: 'needs_review', flags: ['table_structure_requires_review'], table: { id: 'grid', rows: labels.length, columns: 3, cells } }] }] });
    const parsed = Buffer.from(JSON.stringify(receipt));
    const doc = { ...documentFixture(task.id), state: 'partial', pageCount: 1, parser: { ...receipt.parser, failedPages: [], warnings: [] }, original: ref(original), bytesSha256: artifactDigest(original), parsed: ref(parsed) };
    await registerResearchDocument(actor, doc, original, parsed, ctx);
    // If v4 accidentally reuses v3, parsing these original bytes as an index fails.
    await prisma.$executeRaw`INSERT INTO company_research_evidence_indexes(task_id,document_id,document_version,index_version,parsed_sha256,artifact_key,byte_length)
      VALUES (${task.id},${doc.id},1,'zh-context-bm25-v3',${doc.parsed.sha256},${doc.original.key},${doc.original.byteLength})`;
    const result = await searchResearchEvidence(actor, task.id, { query: '经营现金流', fields: ['cash_flow'] }, ctx);
    expect(result.indexVersion).toBe('zh-context-bm25-v4'); expect(result.hits).toHaveLength(1);
    expect(result.hits[0].table?.row).toBe(40); expect(result.hits[0].snippet).toContain('经营活动产生的现金流量净额');
    expect(result.hits[0].quality).toBe('needs_review');
    const cell = result.hits[0].table!.cells[1];
    const read = await readResearchEvidence(actor, task.id, { documentId: doc.id, documentVersion: 1, locator: cell.locator }, ctx);
    expect(read.text).toBe('100.00');
  });
});
