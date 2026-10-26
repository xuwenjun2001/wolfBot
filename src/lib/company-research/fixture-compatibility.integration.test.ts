import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/client';
import { createFixtureTaskInput, loadFixtureTaskDocuments } from '../../../scripts/research/fixture-task-adapter';
import { ResearchArtifactStore, artifactDigest } from './artifact-store';
import { createResearchTask, getResearchReportRevision, getResearchTask } from './version-store';
import { registerResearchDocument, readResearchDocumentArtifact } from './document-store';
import { parseResearchDocument } from './parse-service';
import { parsedDocumentV2Schema } from './parsed-document';
import { researchTaskSpecSchema, type ResearchTaskSpec } from './task-contracts';
import { documentFixture, specFixture } from './version-test-fixtures';
import { claimFinancialResearch, queueFinancialResearch, saveResearchCheckpoint } from './execution-store';
import { emptyCheckpoint } from './execution-contracts';
import { financialResearchTools } from './financial-tools';
import { assembleFinancialReport, financialChanges } from './report-assembly';
import { commitResearchReport } from './report-store';
import { normalizedYuan } from './financial-normalization';
import { deterministicReportErrors } from './verification-service';
import { readResearchEvidence, searchResearchEvidence } from './evidence-retrieval';
import type { ResearchCheckpoint } from './execution-contracts';
import type { ResearchAttemptToken } from './attempt-store';
import type { VersionedCitation } from './document-contracts';

const actor = `fixture-compatibility-${randomUUID()}`;
const evidenceDirectory = path.resolve('data/research-agent-upgrade/evidence/U04/engineering-20261026', actor);
const ctx = { db: prisma, artifacts: new ResearchArtifactStore(evidenceDirectory) };
const ref = (bytes: Buffer) => ({ store: 'local' as const, key: artifactDigest(bytes), sha256: artifactDigest(bytes), byteLength: bytes.length });

async function create(spec = specFixture()) {
  return (await createResearchTask(actor, spec, randomUUID(), ctx))!;
}
async function attachHtml(taskId: string, spec: ResearchTaskSpec, id: string, period: ResearchTaskSpec['periods'][number], paragraphs: string[]) {
  const original = Buffer.from(`<html><h1>${spec.company.name}${period.end.slice(0, 4)}年年度报告</h1>${paragraphs.map(text => `<p>${text}</p>`).join('')}</html>`);
  await registerResearchDocument(actor, { ...documentFixture(taskId, spec), id, period, mediaType: 'text/html', original: ref(original), bytesSha256: artifactDigest(original) }, original, undefined, ctx);
  const parsed = await parseResearchDocument(actor, taskId, id, 1, {}, AbortSignal.timeout(5000), ctx);
  const receipt = parsedDocumentV2Schema.parse(JSON.parse((await readResearchDocumentArtifact(actor, taskId, id, 2, 'parsed', ctx)).bytes.toString()));
  expect(parsed.document.state).toBe('ready');
  const citation = (quote: string): VersionedCitation => {
    const block = receipt.pages.flatMap(page => page.blocks).find(block => block.text.includes(quote));
    if (!block) throw new Error(`Missing synthetic source block: ${quote}`);
    return { documentId: id, documentVersion: 2, bytesSha256: parsed.document.bytesSha256, locator: block.locator, quote };
  };
  return { document: parsed.document, receipt, citation };
}
async function toolsFor(taskId: string, spec: ResearchTaskSpec) {
  await queueFinancialResearch(actor, taskId, 0, ctx);
  const claimed = (await claimFinancialResearch('fixture-compatibility', ctx))!;
  expect(claimed.actor).toBe(actor);
  expect(claimed.attempt.taskId).toBe(taskId);
  const state = emptyCheckpoint(1, 1);
  return { token: claimed.attempt, state, call: toolCaller(claimed.attempt, spec, state) };
}
function toolCaller(token: ResearchAttemptToken, spec: ResearchTaskSpec, state: ResearchCheckpoint) {
  const tools = financialResearchTools(actor, token, spec, state, 'deterministic-integration-fixture', tool => saveResearchCheckpoint(actor, token, state, tool, ctx), ctx, true);
  return async (name: string, input: unknown) => {
    const tool = tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    return tool.execute(input, { runId: token.id, turn: 1, toolCallId: randomUUID(), operationId: randomUUID(), signal: AbortSignal.timeout(10000) });
  };
}

describe.skipIf(process.env.COMPANY_RESEARCH_TEST_POSTGRES !== '1')('fixture compatibility through isolated PostgreSQL', () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.DATABASE_URL !== process.env.RESEARCH_TEST_DATABASE_URL || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/research_test') throw new Error('Disposable database required');
  });
  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM company_research_tasks WHERE actor_id=${actor}`;
    await prisma.$disconnect();
  });

  it('retains original and adjusted million-yuan values through record_fact, checkpoints and publication', async () => {
    const spec = researchTaskSpecSchema.parse({ ...specFixture(), company: { symbol: '601318.SH', name: '中国平安', exchange: 'SH' }, periods: [2022, 2023].map(year => ({ id: `FY${year}`, start: `${year}-01-01`, end: `${year}-12-31`, kind: 'annual', basis: 'cumulative' })) });
    const task = await create(spec);
    const oldRow = '单位：百万元 2022年 经营活动产生的现金流量净额 485,905';
    const newRow = '单位：百万元 2023年 2022年（调整后） 经营活动产生的现金流量净额 360,403 476,776';
    const limitation = '本报告按披露的比较列列示，不证明不同会计准则已完全同口径。';
    const old = await attachHtml(task.id, spec, 'original-2022', spec.periods[0], [oldRow]);
    const current = await attachHtml(task.id, spec, 'comparative-2023', spec.periods[1], [limitation, newRow]);
    const { token, state, call } = await toolsFor(task.id, spec);
    expect(await call('record_fact', { periodId: spec.periods[0].id, metric: 'operating_cash_flow', rawText: '485,905', unitLabel: '百万元', citations: [old.citation(oldRow)] })).toMatchObject({ ok: true });
    const comparative = { metric: 'operating_cash_flow', unitLabel: '百万元', citations: [current.citation(newRow)], accountingBasis: '2023-disclosed-comparative', periodEvidence: [current.citation('2023年 2022年（调整后）')], accountingBasisEvidence: [current.citation(limitation)], comparisonLimitations: [limitation] };
    expect(await call('record_fact', { ...comparative, periodId: spec.periods[0].id, restatement: 'restated', rawText: '476,776' })).toMatchObject({ ok: true });
    expect(await call('record_fact', { ...comparative, periodId: spec.periods[1].id, restatement: 'original', rawText: '360,403' })).toMatchObject({ ok: true });
    expect(state.facts).toHaveLength(3);
    expect(state.facts.every(fact => fact.value.status === 'known')).toBe(true);
    expect(state.facts.map(normalizedYuan).sort()).toEqual(['360403000000', '476776000000', '485905000000']);
    const report = assembleFinancialReport(task.id, spec, token.planRevision, 1, state, 'deterministic-integration-fixture');
    const change = financialChanges(report).find(change => change.metric === 'operating_cash_flow')!;
    expect(change.before?.value).toMatchObject({ raw: '476776', unit: 'million_yuan' });
    expect(change.comparison).toMatchObject({ status: 'comparable', beforeYuan: '476776000000', afterYuan: '360403000000', percentage: '-24.408318', comparisonBasis: 'disclosed_comparative', limitations: expect.arrayContaining([limitation]) });
    expect(report.status).toBe('partial');
    await commitResearchReport(actor, token, 0, report, ctx);
    const saved = (await getResearchReportRevision(actor, task.id, 1, ctx))!;
    const snapshot = (await getResearchTask(actor, task.id, ctx))!;
    expect(saved.facts).toEqual(report.facts);
    expect(snapshot.checkpoint?.facts).toEqual(report.facts);
    expect(snapshot.changes.find(change => change.metric === 'operating_cash_flow')?.comparison).toMatchObject({ percentage: '-24.408318' });
    expect(snapshot.usage).toMatchObject({ inputTokens: null, outputTokens: null, unknownModelRequests: 0 });
  }, 30000);

  it('rejects wrong comparative columns and forged source bindings before checkpoint mutation', async () => {
    const task = await create();
    const row = '单位：百万元 2024年 2023年（调整后） 经营活动产生的现金流量净额 120 100';
    const source = await attachHtml(task.id, task.spec, 'comparative', task.spec.periods[1], [row]);
    const { token, state, call } = await toolsFor(task.id, task.spec);
    const args = { periodId: task.spec.periods[0].id, metric: 'operating_cash_flow', restatement: 'restated', rawText: '100', unitLabel: '百万元', citations: [source.citation(row)], accountingBasis: 'basis', periodEvidence: [source.citation('2024年 2023年（调整后）')] };
    expect(await call('record_fact', { ...args, rawText: '120' })).toMatchObject({ ok: false });
    expect(await call('record_fact', { ...args, periodEvidence: [] })).toMatchObject({ ok: false });
    expect(await call('record_fact', { ...args, unitLabel: '万元' })).toMatchObject({ ok: false });
    expect(await call('record_fact', { ...args, periodEvidence: [{ ...args.periodEvidence[0], quote: '2024年 2023年（伪造列头）' }] })).toMatchObject({ ok: false });
    expect(await call('record_fact', { ...args, accountingBasisEvidence: [{ ...source.citation(row), documentId: 'not-authorized' }] })).toMatchObject({ ok: false });
    expect(state.facts).toHaveLength(0);
    expect(await call('record_fact', args)).toMatchObject({ ok: true });
    expect(await call('record_fact', { ...args, periodId: task.spec.periods[1].id, restatement: 'original', rawText: '120', accountingBasis: 'other-basis' })).toMatchObject({ ok: true });
    const report = assembleFinancialReport(task.id, task.spec, token.planRevision, 1, state, 'deterministic-integration-fixture');
    expect(financialChanges(report).find(change => change.metric === 'operating_cash_flow')?.comparison).toMatchObject({ status: 'incomparable', reason: 'comparison_basis_ambiguous' });
    expect((await deterministicReportErrors(actor, task.spec, report, ctx)).errors).toEqual([]);
    await commitResearchReport(actor, token, 0, report, ctx);
    expect((await getResearchReportRevision(actor, task.id, 1, ctx))!.status).toBe('partial');
  }, 30000);

  it('keeps the supporting scan in a three-document task and refuses its unreviewed numeric evidence', async () => {
    const task = await create();
    await attachHtml(task.id, task.spec, 'annual-2023', task.spec.periods[0], ['单位：元 2023年 经营活动产生的现金流量净额 90']);
    await attachHtml(task.id, task.spec, 'annual-2024', task.spec.periods[1], ['单位：元 2024年 经营活动产生的现金流量净额 100']);
    const original = Buffer.from('%PDF-synthetic-scanned-support');
    const text = '单位：元 2024年 经营活动产生的现金流量净额 100';
    const locator = { kind: 'block' as const, filePage: 1, blockId: 'scan_cash_flow' };
    const receipt = parsedDocumentV2Schema.parse({ schemaVersion: 2, originalSha256: artifactDigest(original), mediaType: 'application/pdf', parser: { name: 'synthetic-ocr', version: '1' }, pageCount: 1, status: 'partial', failedPages: [], truncatedPages: [], warnings: ['ocr_requires_review'], pages: [{ filePage: 1, text, blocks: [{ id: locator.blockId, order: 0, kind: 'text', text, locator, quality: 'needs_review', flags: ['ocr'] }] }] });
    const parsed = Buffer.from(JSON.stringify(receipt));
    await registerResearchDocument(actor, { ...documentFixture(task.id), id: 'supporting-scan', original: ref(original), bytesSha256: artifactDigest(original), parsed: ref(parsed), state: 'partial', pageCount: 1, parser: { ...receipt.parser, failedPages: [], warnings: receipt.warnings } }, original, parsed, ctx);
    const result = await searchResearchEvidence(actor, task.id, { query: '经营现金流', documentIds: ['supporting-scan'] }, ctx);
    expect(result.scopedDocumentCount).toBe(1);
    expect(result.hits.some(hit => hit.sourceId === 'supporting-scan' && hit.quality === 'needs_review')).toBe(true);
    const { token, state, call } = await toolsFor(task.id, task.spec);
    expect(await call('record_fact', { periodId: task.spec.periods[1].id, metric: 'operating_cash_flow', rawText: '100', unitLabel: '元', citations: [{ documentId: 'supporting-scan', documentVersion: 1, bytesSha256: artifactDigest(original), locator, quote: text }] })).toMatchObject({ ok: false, error: { message: expect.stringContaining('FACT_SOURCE_NEEDS_REVIEW') } });
    expect(state.facts).toHaveLength(0);
    expect(new Set((await getResearchTask(actor, task.id, ctx))!.documents.map(document => document.id))).toEqual(new Set(['annual-2023', 'annual-2024', 'supporting-scan']));
    await expect(readResearchEvidence(`${actor}-other`, task.id, { documentId: 'supporting-scan', documentVersion: 1, locator }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await commitResearchReport(actor, token, 0, assembleFinancialReport(task.id, task.spec, token.planRevision, 1, state, 'deterministic-integration-fixture'), ctx);
  }, 30000);

  it.skipIf(process.env.RESEARCH_TEST_PUBLIC_FIXTURES !== '1')('imports all fourteen actual development tasks with unchanged source receipts and no model calls', async () => {
    const datasetBytes = await readFile('fixtures/company-research/development-v2.json');
    const dataset = JSON.parse(datasetBytes.toString()) as { documents: unknown[]; cases: { id: string; documentIds: string[] }[] };
    expect(dataset.cases).toHaveLength(14);
    expect(dataset.documents).toHaveLength(30);
    const cases = [];
    for (const sample of dataset.cases) {
      const input = createFixtureTaskInput(sample, dataset.documents);
      const serialized = JSON.stringify(input);
      for (const forbidden of ['rawValue', 'answerability', 'acceptedReference', 'expectedPercent', 'referenceStatus', 'checkedRanges']) expect(serialized).not.toContain(`"${forbidden}"`);
      expect(input.spec.budget).toEqual({ maxToolCalls: 40, timeoutMs: 1200000 });
      const task = await create(input.spec);
      const sources = await loadFixtureTaskDocuments(input, task.id);
      for (const source of sources) await registerResearchDocument(actor, source.document, source.original, source.parsed, ctx);
      const snapshot = (await getResearchTask(actor, task.id, ctx))!;
      expect(snapshot.documents.map(document => document.id).sort()).toEqual([...sample.documentIds].sort());
      expect(snapshot.spec).toEqual(input.spec);
      expect(snapshot.usage).toMatchObject({ toolCalls: 0, inputTokens: null, outputTokens: null, unknownModelRequests: 0, startedAt: null, deadline: null });
      const sourceBindings = [];
      for (const source of sources) {
        const stored = await readResearchDocumentArtifact(actor, task.id, source.document.id, 1, 'parsed', ctx);
        expect(stored.bytes.equals(source.parsed)).toBe(true);
        const receipt = parsedDocumentV2Schema.parse(JSON.parse(stored.bytes.toString()));
        const page = receipt.pages.find(page => page.text.trim() && !receipt.failedPages.includes(page.filePage));
        if (page) {
          const read = await readResearchEvidence(actor, task.id, { documentId: source.document.id, documentVersion: 1, locator: { kind: 'page', filePage: page.filePage } }, ctx);
          expect(read.text.length).toBeGreaterThan(0);
        }
        sourceBindings.push({ documentId: source.document.id, originalSha256: source.document.bytesSha256, parserReceiptSha256: artifactDigest(stored.bytes), state: source.document.state, pageCount: receipt.pageCount });
      }
      cases.push({ caseId: sample.id, taskId: task.id, periods: input.spec.periods, documentScope: input.documentScope, sourceBindings, modelCalls: 0 });
    }
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(path.join(evidenceDirectory, 'public-fixture-import.json'), JSON.stringify({ schemaVersion: 1, purpose: 'isolated_postgres_source_and_execution_input_binding_only', historicalReceiptsPreserved: true, parserQualityAccepted: false, semanticQualityAccepted: false, datasetSha256: artifactDigest(datasetBytes), caseCount: cases.length, documentCount: cases.reduce((sum, item) => sum + item.sourceBindings.length, 0), questionCount: 42, modelCalls: 0, cases }, null, 2) + '\n', { flag: 'wx' });
  }, 180000);
});
