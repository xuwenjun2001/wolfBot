import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db/client';
import { ResearchArtifactStore, artifactDigest } from './artifact-store';
import { createResearchTask, getResearchTask } from './version-store';
import { queueFinancialResearch, claimFinancialResearch, saveResearchCheckpoint } from './execution-store';
import { cancelResearchTask } from './attempt-store';
import { documentFixture, reportFixture, specFixture } from './version-test-fixtures';
import { registerResearchDocument, readResearchDocumentArtifact } from './document-store';
import { parseResearchDocument } from './parse-service';
import { parsedDocumentV2Schema } from './parsed-document';
import { commitResearchReport } from './report-store';
import { financialResearchTools } from './financial-tools';
import { emptyCheckpoint } from './execution-contracts';
import { readResearchSource } from './source-reader';
import * as network from './network';

const actor = `execution-review-${randomUUID()}`;
const artifactRoot = path.resolve('data/research-agent-upgrade/evidence/review-s11-s15-fixes', actor);
const ctx = { db: prisma, artifacts: new ResearchArtifactStore(artifactRoot) };
const ref = (bytes: Buffer) => ({ store: 'local' as const, key: artifactDigest(bytes), sha256: artifactDigest(bytes), byteLength: bytes.length });
async function task() {
  const t = (await createResearchTask(actor, specFixture(), randomUUID(), ctx))!;
  await queueFinancialResearch(actor, t.id, 0, ctx);
  const claimed = (await claimFinancialResearch('execution-review', ctx))!;
  expect(claimed.attempt.taskId).toBe(t.id);
  return { t, token: claimed.attempt };
}
async function attach(taskId: string, text: string) {
  const bytes = Buffer.from(`<html><h1>贵州茅台2024年年度报告</h1><p>${text}</p></html>`);
  await registerResearchDocument(actor, { ...documentFixture(taskId), mediaType: 'text/html', original: ref(bytes), bytesSha256: artifactDigest(bytes) }, bytes, undefined, ctx);
}
const toolContext = (id: string) => ({ runId: id, turn: 1, toolCallId: randomUUID(), operationId: randomUUID(), signal: new AbortController().signal });

describe.skipIf(process.env.COMPANY_RESEARCH_TEST_POSTGRES !== '1')('execution review publication and write fences', () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.DATABASE_URL !== process.env.RESEARCH_TEST_DATABASE_URL || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/research_test') throw new Error('Disposable database required');
  });
  afterAll(async () => { vi.restoreAllMocks(); await prisma.$executeRaw`DELETE FROM company_research_tasks WHERE actor_id=${actor}`; await prisma.$disconnect(); });
  it.each([
    { name: 'reversed years', text: '单位：元 2023年 2024年 经营活动产生的现金流量净额 100.00 250.00', wrong: '100.00', correct: '250.00' },
    { name: 'accounting negative', text: '单位：元 2024年 2023年 经营活动产生的现金流量净额 (250.00) 100.00', wrong: '250.00', correct: '-250.00' },
  ])('rejects $name at publication and accepts its correct signed column', async ({ text, wrong, correct }) => {
    const { t, token } = await task(); await attach(t.id, text);
    const { document } = await parseResearchDocument(actor, t.id, 'annual-2024', 1, {}, AbortSignal.timeout(5000), ctx);
    const receipt = parsedDocumentV2Schema.parse(JSON.parse((await readResearchDocumentArtifact(actor, t.id, document.id, 2, 'parsed', ctx)).bytes.toString()));
    const block = receipt.pages[0].blocks[1], report = reportFixture(t.id); report.claims = [];
    report.facts[0].citations = [{ documentId: document.id, documentVersion: 2, bytesSha256: document.bytesSha256, locator: block.locator, quote: block.text }];
    report.facts[0].value = { status: 'known', raw: wrong, unit: 'yuan', currency: 'CNY', decimals: 2 };
    await expect(commitResearchReport(actor, token, 0, report, ctx)).rejects.toThrow('FACT_PERIOD_COLUMN_MISMATCH');
    expect((await getResearchTask(actor, t.id, ctx))!.reportRevision).toBe(0);
    report.facts[0].value.raw = correct;
    expect((await commitResearchReport(actor, token, 0, report, ctx)).facts[0].value).toMatchObject({ raw: correct });
  });
  it.each(['cancel', 'takeover'] as const)('fences a parser finishing after %s and lets the new attempt parse', async boundary => {
    const { t, token } = await task(); await attach(t.id, '单位：元 2024年 经营活动产生的现金流量净额 100.00');
    const state = emptyCheckpoint(1, 1), artifacts = new ResearchArtifactStore(artifactRoot), read = artifacts.read.bind(artifacts);
    let crossed = false, replacement: typeof token | undefined;
    artifacts.read = async (owner, reference) => {
      const bytes = await read(owner, reference);
      if (!crossed) {
        crossed = true;
        if (boundary === 'cancel') await cancelResearchTask(actor, t.id, ctx);
        else {
          await prisma.$executeRaw`UPDATE company_research_attempts SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=${token.id}`;
          replacement = (await claimFinancialResearch('replacement', ctx))!.attempt;
        }
      }
      return bytes;
    };
    const tools = financialResearchTools(actor, token, t.spec, state, 'fixture', name => saveResearchCheckpoint(actor, token, state, name, ctx), { ...ctx, artifacts });
    const result = await tools.find(t => t.name === 'parse_document')!.execute({ documentId: 'annual-2024', version: 1 }, toolContext(token.id));
    expect(result).toMatchObject({ ok: false, error: { message: 'LEASE_LOST' } });
    expect((await getResearchTask(actor, t.id, ctx))!.documents.map(d => d.version)).toEqual([1]);
    if (replacement) {
      const parsed = await parseResearchDocument(actor, t.id, 'annual-2024', 1, {}, AbortSignal.timeout(5000), ctx, undefined, replacement);
      expect(parsed.document.version).toBe(2); await cancelResearchTask(actor, t.id, ctx);
    }
  });
  it('fences an import cancelled during its download', async () => {
    const { t, token } = await task(), state = emptyCheckpoint(1, 1);
    const download = vi.spyOn(network, 'downloadResearchOriginal').mockImplementation(async url => {
      await cancelResearchTask(actor, t.id, ctx);
      return { bytes: Buffer.from('<html>贵州茅台2024年年度报告</html>'), mediaType: 'text/html', url };
    });
    try {
      const tools = financialResearchTools(actor, token, t.spec, state, 'fixture', name => saveResearchCheckpoint(actor, token, state, name, ctx), ctx);
      const result = await tools.find(t => t.name === 'import_filing')!.execute({ provider: 'manual', url: 'https://example.com/review.html', title: '2024年年度报告', periodId: 'fy2024' }, toolContext(token.id));
      expect(result).toMatchObject({ ok: false, error: { message: 'LEASE_LOST' } });
      expect((await getResearchTask(actor, t.id, ctx))!.documents).toHaveLength(0);
    } finally { download.mockRestore(); }
  });
  it('checks the lease again after writing artifact bytes, before publishing metadata', async () => {
    const { t, token } = await task(), original = Buffer.from('<html>贵州茅台2024年年度报告</html>');
    const artifacts = new ResearchArtifactStore(artifactRoot), put = artifacts.put.bind(artifacts);
    artifacts.put = async (owner, bytes) => {
      const result = await put(owner, bytes);
      await prisma.$executeRaw`UPDATE company_research_attempts SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=${token.id}`;
      return result;
    };
    await expect(registerResearchDocument(actor, { ...documentFixture(t.id), mediaType: 'text/html', original: ref(original), bytesSha256: artifactDigest(original) }, original, undefined, { ...ctx, artifacts }, token)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await getResearchTask(actor, t.id, ctx))!.documents).toHaveLength(0);
    await cancelResearchTask(actor, t.id, ctx);
  });
  it('returns context around a normalized citation beyond the initial excerpt without inventing a highlight', async () => {
    const { t, token } = await task(), original = Buffer.from('%PDF-review-normalized-offset');
    const prefix = '前文。'.repeat(4000), quote = '经营活动产生的现金流量净额 100.00';
    const text = prefix + '经营活动产生的现金流量\n净额 100.00 后文';
    const parsed = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ filePage: 5, text }] }));
    await registerResearchDocument(actor, { ...documentFixture(t.id), original: ref(original), bytesSha256: artifactDigest(original), parsed: ref(parsed), state: 'ready', parser: { name: 'synthetic-offset-test', version: '1', warnings: [], failedPages: [] } }, original, parsed, ctx);
    const state = emptyCheckpoint(1, 1);
    state.claims = [{ id: 'cash', questionId: 'cash_flow', text: '定位测试', kind: 'fact', status: 'evidence_gap', reason: '仅验证原文定位', factIds: [], citations: [{ documentId: 'annual-2024', documentVersion: 1, bytesSha256: artifactDigest(original), locator: { kind: 'page', filePage: 5 }, quote }] }];
    await saveResearchCheckpoint(actor, token, state, 'reader-test', ctx);
    const source = await readResearchSource(actor, t.id, { reportRevision: 0, claimId: 'cash', citationIndex: 0 }, ctx);
    expect(source.textOffset).toBe(prefix.length - 1200);
    expect(source.text.replace(/\s+/g, '')).toContain(quote.replace(/\s+/g, ''));
    expect(source.highlight).toBeNull(); expect(source.coordinate).toBeNull();
    await cancelResearchTask(actor, t.id, ctx);
  });
});
