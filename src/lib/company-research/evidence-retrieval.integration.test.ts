import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db/client';
import { ResearchArtifactStore, artifactDigest } from './artifact-store';
import { createResearchTask } from './version-store';
import { registerResearchDocument } from './document-store';
import { searchResearchEvidence, readResearchEvidence } from './evidence-retrieval';
import { specFixture, documentFixture } from './version-test-fixtures';
import type { ResearchDocument } from './document-contracts';
import { ensureEvidenceIndex } from './evidence-index-store';

const actor = `evidence-test-${randomUUID()}`, other = `${actor}-other`;
const ctx = { db: prisma, artifacts: new ResearchArtifactStore(path.resolve('data/research-agent-upgrade/evidence/S10', actor)) };
const ref = (b: Buffer) => ({ store: 'local' as const, key: artifactDigest(b), sha256: artifactDigest(b), byteLength: b.length });
async function attach(taskId: string, id: string, text: string, disclosure?: ResearchDocument['disclosure']) {
  const original = Buffer.from('%PDF-test ' + id), parsed = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ filePage: 5, text }] }));
  const doc = { ...documentFixture(taskId), id, original: ref(original), bytesSha256: artifactDigest(original), parsed: ref(parsed), state: 'ready', parser: { name: 'fixture-receipt', version: '1', failedPages: [], warnings: [] }, ...(disclosure ? { disclosure } : {}) };
  await registerResearchDocument(actor, doc, original, parsed, ctx);
  return doc;
}
describe.skipIf(process.env.COMPANY_RESEARCH_TEST_POSTGRES !== '1')('authorized persisted lexical evidence index', () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.DATABASE_URL !== process.env.RESEARCH_TEST_DATABASE_URL || !['127.0.0.1', 'localhost'].includes(url.hostname) || !/^\/research_test/.test(url.pathname)) throw new Error('Disposable database required');
  });
  afterAll(async () => { await prisma.$executeRaw`DELETE FROM company_research_tasks WHERE actor_id=${actor}`; await prisma.$disconnect(); });
  it('retrieves an early source among 12, persists/reuses an immutable index and reads its exact location', async () => {
    const task = (await createResearchTask(actor, specFixture(), randomUUID(), ctx))!;
    const first = await attach(task.id, 'source-00', '应收账款减值准备显著增加。现金流待核对。' + '附加原文。'.repeat(80));
    for (let n = 1; n < 12; n++) await attach(task.id, `source-${String(n).padStart(2, '0')}`, '一般经营资料，普通服务保持平稳。');
    await attach(task.id, 'future', '应收账款减值准备显著增加未来泄漏', { ...documentFixture().disclosure, status: 'verified', precision: 'date', on: '2030-01-01', timezone: 'Asia/Shanghai', evidenceUrl: 'https://example.com', evidenceSha256: 'a'.repeat(64) });
    await attach(task.id, 'unknown', '应收账款减值准备未知日期泄漏', { status: 'unknown', reason: 'no date' });
    const result = await searchResearchEvidence(actor, task.id, { query: '应收账款减值准备', topK: 5, maxOutputCharacters: 3000 }, ctx);
    expect(result.scopedDocumentCount).toBe(12); expect(result.hits[0].sourceId).toBe('source-00');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(3000);
    expect(result.hits.some(h => ['future', 'unknown'].includes(h.sourceId))).toBe(false);
    expect(await searchResearchEvidence(actor, task.id, { query: '应收账款减值准备', topK: 5, maxOutputCharacters: 3000 }, ctx)).toEqual(result);
    const hit = result.hits[0], read = await readResearchEvidence(actor, task.id, { documentId: hit.sourceId, documentVersion: hit.documentVersion, locator: hit.locator }, ctx);
    expect(read.text).toContain('减值准备');
    const page = await readResearchEvidence(actor, task.id, { documentId: hit.sourceId, documentVersion: hit.documentVersion, locator: hit.locator, maxCharacters: 100 }, ctx);
    expect(page.text.length).toBe(100); expect(page.nextOffset).toBe(100);
    const readSpy = vi.spyOn(ctx.artifacts, 'read');
    try {
      await expect(searchResearchEvidence(other, task.id, { query: '减值' }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(readResearchEvidence(other, task.id, { documentId: hit.sourceId, documentVersion: hit.documentVersion, locator: hit.locator }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(ensureEvidenceIndex(other, first as ResearchDocument, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(ensureEvidenceIndex(actor, { ...first, title: 'forged metadata' } as ResearchDocument, ctx)).rejects.toMatchObject({ code: 'INVALID_RESEARCH' });
      expect(readSpy).not.toHaveBeenCalled();
    } finally { readSpy.mockRestore(); }
    const [count] = await prisma.$queryRaw<{n: bigint}[]>`SELECT count(*)::bigint n FROM company_research_evidence_indexes WHERE task_id=${task.id}`;
    expect(Number(count.n)).toBe(12);
    await expect(prisma.$executeRaw`UPDATE company_research_evidence_indexes SET index_version='changed' WHERE task_id=${task.id}`).rejects.toThrow('RESEARCH_IMMUTABLE_VERSION');
    const stored = await ctx.artifacts.read(actor, first.parsed!);
    const bytes = await ctx.artifacts.read(actor, first.original);
    await registerResearchDocument(actor, { ...first, version: 2, state: 'unreadable' }, bytes, stored, ctx);
    const newer = await searchResearchEvidence(actor, task.id, { query: '应收账款减值准备' }, ctx);
    expect(newer.scopedDocumentCount).toBe(11); expect(newer.hits.some(h => h.sourceId === first.id)).toBe(false);
    await expect(readResearchEvidence(actor, task.id, { documentId: first.id, documentVersion: 1, locator: hit.locator }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
