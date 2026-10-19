import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db/client';
import { ResearchArtifactStore, artifactDigest } from './artifact-store';
import type { ResearchRepositoryContext } from './repository-core';
import { createResearchTask, getResearchTask, appendResearchPlan, reviseResearchTask, getResearchReportRevision, researchVersionEventsAfter } from './version-store';
import { registerResearchDocument, getResearchDocument, readResearchDocumentArtifact } from './document-store';
import { startResearchAttempt, heartbeatResearchAttempt, reserveResearchToolCall, cancelResearchTask } from './attempt-store';
import { commitResearchReport } from './report-store';
import { documentFixture, reportFixture, specFixture } from './version-test-fixtures';
import type { ResearchTaskSpec } from './task-contracts';
import { importTaskFiling, listResearchDocuments } from './acquisition-service';
import * as network from './network';
import * as filingAcquisition from './filing-acquisition';
import { parseResearchDocument } from './parse-service';

const enabled = process.env.COMPANY_RESEARCH_TEST_POSTGRES === '1';
const suiteId = randomUUID(), actor = `research-version-test-${suiteId}`, other = `research-version-other-${suiteId}`;
const root = path.resolve('data/research-agent-upgrade/evidence/S05', `artifacts-${suiteId}`);
const ctx: ResearchRepositoryContext = { db: prisma, artifacts: new ResearchArtifactStore(root) };
const original = Buffer.from('%PDF-1.7\nsynthetic persistence fixture, not a parsed annual report\n');
const parsed = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ filePage: 5, text: '经营现金流原文测试' }] }));
const ref = (b: Buffer) => ({ store: 'local' as const, key: artifactDigest(b), sha256: artifactDigest(b), byteLength: b.length });
const planFor = (taskId: string, revision = 1) => ({ schemaVersion: 1, taskId, requestRevision: 1, revision, createdAt: new Date().toISOString(), steps: [{ id: 'verify', questionId: 'cash_flow', kind: 'verify', title: '检查现金流' }] });
async function taskWithPlan(spec: ResearchTaskSpec = specFixture()) {
  const task = (await createResearchTask(actor, spec, randomUUID(), ctx))!;
  await appendResearchPlan(actor, task.id, 0, randomUUID(), planFor(task.id), ctx);
  return task;
}
async function attachDocument(taskId: string) {
  const doc = { ...documentFixture(taskId), state: 'ready' as const, bytesSha256: artifactDigest(original), original: ref(original), parsed: ref(parsed), parser: { name: 'synthetic-test-receipt', version: '1', failedPages: [], warnings: [] } };
  await registerResearchDocument(actor, doc, original, parsed, ctx);
  return doc;
}
function reportFor(taskId: string, revision = 1) {
  const report = { ...reportFixture(taskId), revision };
  // Persistence fixtures have no real amount/semantic evidence; S12 must not label them known/supported.
  report.facts[0].value = { status: 'missing', reason: 'synthetic persistence fixture' };
  report.claims[0].status = 'evidence_gap'; report.claims[0].reason = 'synthetic persistence fixture';
  report.facts.forEach(f => f.citations.forEach(c => { c.bytesSha256 = artifactDigest(original); }));
  report.claims.forEach(f => f.citations.forEach(c => { c.bytesSha256 = artifactDigest(original); }));
  return report;
}
describe.skipIf(!enabled)('versioned research PostgreSQL and controlled artifacts', () => {
  beforeAll(async () => {
    const db = new URL(process.env.DATABASE_URL!);
    if (process.env.DATABASE_URL !== process.env.RESEARCH_TEST_DATABASE_URL || !['127.0.0.1','localhost'].includes(db.hostname) || !/^\/research_test/.test(db.pathname)) throw new Error('Disposable RESEARCH_TEST_DATABASE_URL required');
    await mkdir(root, { recursive: true });
  });
  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM company_research_tasks WHERE actor_id=${actor} OR actor_id=${other}`;
    await prisma.$disconnect();
  });
  it('imports within actor scope, deduplicates retry bytes and retains changed originals', async () => {
    const task = (await createResearchTask(actor, specFixture(), randomUUID(), ctx))!;
    const input = { provider: 'manual', url: 'https://example.com/report.pdf', title: '2024年年度报告', periodId: 'fy2024' };
    const download = vi.spyOn(network, 'downloadResearchOriginal').mockResolvedValue({ bytes: original, mediaType: 'application/pdf', url: input.url });
    try {
      await expect(importTaskFiling(other, task.id, input, AbortSignal.timeout(1000), ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(download).not.toHaveBeenCalled();
      const first = await importTaskFiling(actor, task.id, input, AbortSignal.timeout(1000), ctx);
      const retry = await importTaskFiling(actor, task.id, input, AbortSignal.timeout(1000), ctx);
      expect(retry.reused).toBe(true); expect(retry.document).toEqual(first.document);
      expect(first.eligibility).toBe('date_unverified');
      download.mockResolvedValue({ bytes: Buffer.concat([original, Buffer.from('revision')]), mediaType: 'application/pdf', url: input.url });
      const changed = await importTaskFiling(actor, task.id, input, AbortSignal.timeout(1000), ctx);
      expect(changed.document.version).toBe(2); expect(changed.document.original.key).not.toBe(first.document.original.key);
      expect(await listResearchDocuments(actor, task.id, ctx)).toHaveLength(2);
      expect(await listResearchDocuments(other, task.id, ctx)).toEqual([]);
      expect((await readResearchDocumentArtifact(actor, task.id, first.document.id, 1, 'original', ctx)).bytes).toEqual(original);
    } finally { download.mockRestore(); }
  });
  it('persists rich HTML, retries its parser version and rejects invented source locations at publication', async () => {
    const task = await taskWithPlan(), html = Buffer.from('<html><body><h1>贵州茅台2024年度报告</h1><p>经营现金流原文测试</p></body></html>');
    await registerResearchDocument(actor, { ...documentFixture(task.id), mediaType: 'text/html', original: ref(html), bytesSha256: artifactDigest(html) }, html, undefined, ctx);
    const result = await parseResearchDocument(actor, task.id, 'annual-2024', 1, {}, AbortSignal.timeout(5000), ctx);
    expect(result.document.version).toBe(2); expect(result.document.state).toBe('ready');
    expect((await parseResearchDocument(actor, task.id, 'annual-2024', 2, {}, AbortSignal.timeout(5000), ctx)).reused).toBe(true);
    await expect(parseResearchDocument(other, task.id, 'annual-2024', 2, {}, AbortSignal.timeout(5000), ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const receipt = JSON.parse((await readResearchDocumentArtifact(actor, task.id, 'annual-2024', 2, 'parsed', ctx)).bytes.toString());
    const report = reportFor(task.id), block = receipt.pages[0].blocks[1];
    for (const c of [...report.facts.flatMap(f => f.citations), ...report.claims.flatMap(f => f.citations)]) Object.assign(c, { documentVersion: 2, bytesSha256: artifactDigest(html), locator: block.locator });
    const attempt = await startResearchAttempt(actor, task.id, 1, 'html-verifier', ctx);
    const bad = structuredClone(report); Object.assign(bad.claims[0].citations[0].locator, { selector: 'invented' });
    await expect(commitResearchReport(actor, attempt, 0, bad, ctx)).rejects.toThrow('CITATION_LOCATOR_MISMATCH');
    expect((await commitResearchReport(actor, attempt, 0, report, ctx)).status).toBe('partial');
  });
  it('does not backdate replacement bytes using an unchanged official announcement date', async () => {
    const task = (await createResearchTask(actor, specFixture(), randomUUID(), ctx))!;
    const evidence = Buffer.from('synthetic official-date fixture');
    const candidate: filingAcquisition.FilingCandidate = { id: 'cninfo-123456', periodId: 'fy2024', title: '2024年年度报告', provider: 'cninfo',
      url: 'https://example.com/report.pdf', evidence, evidenceUrl: 'https://example.com/announcement',
      disclosure: { status: 'verified', precision: 'date', on: '2025-04-03', timezone: 'Asia/Shanghai', evidenceUrl: 'https://example.com/announcement', evidenceSha256: artifactDigest(evidence) }, dateClaims: [], warnings: [] };
    const discovery = vi.spyOn(filingAcquisition, 'discoverResearchFilings').mockResolvedValue({ candidates: [candidate], failures: [], hasMore: false, page: 1 });
    const download = vi.spyOn(network, 'downloadResearchOriginal').mockResolvedValue({ bytes: original, mediaType: 'application/pdf', url: candidate.url });
    const request = { provider: 'cninfo', candidateId: candidate.id };
    try {
      const first = await importTaskFiling(actor, task.id, request, AbortSignal.timeout(1000), ctx);
      expect(first.eligibility).toBe('available');
      download.mockResolvedValue({ bytes: Buffer.concat([original, Buffer.from('replacement')]), mediaType: 'application/pdf', url: candidate.url });
      const revised = await importTaskFiling(actor, task.id, request, AbortSignal.timeout(1000), ctx);
      expect(revised.document.disclosure.status).toBe('unknown'); expect(revised.eligibility).toBe('date_unverified');
      expect(revised.document.provenance!.warnings).toContain('replacement_disclosure_unverified');
      const retry = await importTaskFiling(actor, task.id, request, AbortSignal.timeout(1000), ctx);
      expect(retry.reused).toBe(true); expect(retry.document.version).toBe(revised.document.version);
      expect((await getResearchDocument(actor, task.id, candidate.id, 1, ctx))!.disclosure.status).toBe('verified');
    } finally { discovery.mockRestore(); download.mockRestore(); }
  });
  it('does not publish a known fact sourced from unreviewed OCR blocks', async () => {
    const task = await taskWithPlan(), base = documentFixture(task.id), id = 'b_ocr';
    const receipt = { schemaVersion: 2, originalSha256: artifactDigest(original), mediaType: 'application/pdf', parser: { name: 'ocr-test', version: '1' }, pageCount: 1,
      status: 'partial', failedPages: [], truncatedPages: [], warnings: [], pages: [{ filePage: 1, text: '经营现金流原文测试', blocks: [{ id, order: 0, kind: 'text', text: '经营现金流原文测试', quality: 'needs_review', flags: ['ocr_requires_review'], locator: { kind: 'block', filePage: 1, blockId: id } }] }] };
    const bytes = Buffer.from(JSON.stringify(receipt));
    await registerResearchDocument(actor, { ...base, state: 'partial', pageCount: 1, parser: { ...receipt.parser, failedPages: [], warnings: [] }, original: ref(original), bytesSha256: artifactDigest(original), parsed: ref(bytes) }, original, bytes, ctx);
    const report = reportFor(task.id);
    for (const c of [...report.facts.flatMap(f => f.citations), ...report.claims.flatMap(f => f.citations)]) Object.assign(c, { locator: receipt.pages[0].blocks[0].locator });
    report.facts[0].value = { status: 'known', raw: '0', unit: 'yuan', currency: 'CNY', decimals: 2 };
    const attempt = await startResearchAttempt(actor, task.id, 1, 'ocr-verifier', ctx);
    await expect(commitResearchReport(actor, attempt, 0, report, ctx)).rejects.toThrow('FACT_SOURCE_NEEDS_REVIEW');
  });
  it('creates once under concurrent retries and hashes all user fields within actor scope', async () => {
    const key = randomUUID(), spec = specFixture();
    const tasks = await Promise.all(Array.from({ length: 6 }, () => createResearchTask(actor, spec, key, ctx)));
    expect(new Set(tasks.map(t => t!.id)).size).toBe(1);
    expect(await researchVersionEventsAfter(actor, tasks[0]!.id, 0, ctx)).toHaveLength(1);
    await expect(createResearchTask(actor, { ...spec, asOf: '2025-07-01T00:00:00Z' }, key, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(createResearchTask(actor, { ...spec, questions: spec.questions.map(q => ({ ...q, text: q.text + '重点' })) }, key, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await createResearchTask(other, spec, key, ctx))!.id).not.toBe(tasks[0]!.id);
  });
  it('serializes competing plan revisions, detects changed retries and enforces immutable snapshots in SQL', async () => {
    const task = (await createResearchTask(actor, specFixture(), randomUUID(), ctx))!, key = randomUUID(), plan = planFor(task.id);
    const keys = [key, randomUUID()], plans = [plan, { ...plan, createdAt: '2026-10-18T00:00:00Z' }];
    const results = await Promise.allSettled(plans.map((p, i) => appendResearchPlan(actor, task.id, 0, keys[i], p, ctx)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'REVISION_CONFLICT' } });
    const winner = results.findIndex(r => r.status === 'fulfilled');
    expect((await appendResearchPlan(actor, task.id, 0, keys[winner], plans[winner], ctx)).revision).toBe(1);
    await expect(appendResearchPlan(actor, task.id, 0, keys[winner], { ...plans[winner], steps: [{ ...plan.steps[0], title: '变化' }] }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(prisma.$executeRaw`UPDATE company_research_plans SET plan='{}'::jsonb WHERE task_id=${task.id}`).rejects.toThrow('RESEARCH_IMMUTABLE_VERSION');
  });
  it('revises the request and plan atomically, fences the old worker, and preserves the logical budget', async () => {
    const task = await taskWithPlan(), first = await startResearchAttempt(actor, task.id, 1, 'revision-worker-1', ctx);
    await reserveResearchToolCall(actor, first, ctx);
    const before = (await getResearchTask(actor, task.id, ctx))!, key = `revise-${randomUUID()}`;
    const changes = { questions: before.spec.questions.map(q => q.id === 'income_profit' ? { ...q, text: '重点检查收入和利润变化的证据' } : q) };
    await reviseResearchTask(actor, task.id, 1, 1, key, changes, ctx);
    const revised = (await getResearchTask(actor, task.id, ctx))!;
    expect(revised).toMatchObject({ status: 'queued', requestRevision: 2, planRevision: 2, generation: first.generation + 1, reportRevision: 0 });
    expect(revised.spec.questions[0].text).toBe('重点检查收入和利润变化的证据');
    expect(revised.plan).toMatchObject({ requestRevision: 2, revision: 2 });
    expect(revised.checkpoint).toMatchObject({ requestRevision: 2, planRevision: 2, facts: [], claims: [] });
    expect(revised.usage).toMatchObject({ toolCalls: 1, startedAt: before.usage.startedAt, deadline: before.usage.deadline });
    await expect(heartbeatResearchAttempt(actor, first, ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const sequence = revised.sequence;
    await reviseResearchTask(actor, task.id, 1, 1, key, changes, ctx);
    expect((await getResearchTask(actor, task.id, ctx))!.sequence).toBe(sequence);
    await expect(reviseResearchTask(actor, task.id, 1, 1, key, { asOf: '2025-07-01T00:00:00Z' }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const second = await startResearchAttempt(actor, task.id, 2, 'revision-worker-2', ctx);
    expect(second.requestRevision).toBe(2); expect(second.planRevision).toBe(2);
    expect((await getResearchTask(actor, task.id, ctx))!.usage.deadline).toBe(before.usage.deadline);
    await cancelResearchTask(actor, task.id, ctx);
    await expect(reviseResearchTask(actor, task.id, 2, 2, `revise-${randomUUID()}`, { asOf: '2025-07-01T00:00:00Z' }, ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it('allows only one concurrent request revision and requires new period IDs for changed boundaries', async () => {
    const task = await taskWithPlan(), current = (await getResearchTask(actor, task.id, ctx))!;
    const periods = [{ ...current.spec.periods[0], id: 'fy2022', start: '2022-01-01', end: '2022-12-31' }, current.spec.periods[1]] as const;
    await expect(reviseResearchTask(actor, task.id, 1, 1, `bad-period-${randomUUID()}`, { periods: [{ ...periods[0], id: current.spec.periods[0].id }, periods[1]] }, ctx)).rejects.toMatchObject({ code: 'INVALID_RESEARCH' });
    const changes = { periods };
    const results = await Promise.allSettled([
      reviseResearchTask(actor, task.id, 1, 1, `period-a-${randomUUID()}`, changes, ctx),
      reviseResearchTask(actor, task.id, 1, 1, `period-b-${randomUUID()}`, { asOf: '2025-07-01T00:00:00Z' }, ctx),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'REVISION_CONFLICT' } });
    expect((await getResearchTask(actor, task.id, ctx))!.requestRevision).toBe(2);
  });
  it('retains the previous report and its as-of request after a plan revision', async () => {
    const task = await taskWithPlan(); await attachDocument(task.id);
    const attempt = await startResearchAttempt(actor, task.id, 1, 'report-before-revision', ctx);
    const previous = await commitResearchReport(actor, attempt, 0, reportFor(task.id), ctx);
    await reviseResearchTask(actor, task.id, 1, 1, `report-revision-${randomUUID()}`, { asOf: '2025-07-01T00:00:00Z' }, ctx);
    const current = (await getResearchTask(actor, task.id, ctx))!;
    expect(current.spec.asOf).toBe('2025-07-01T00:00:00Z');
    expect(current.reportSpec?.asOf).toBe(previous.asOf);
    expect(await getResearchReportRevision(actor, task.id, 1, ctx)).toEqual(previous);
    expect(current.reportRevision).toBe(1);
  });
  it('isolates metadata, original/parsed content, reports, events and cancellation for other actors', async () => {
    const task = await taskWithPlan(), doc = await attachDocument(task.id), attempt = await startResearchAttempt(actor, task.id, 1, 'worker', ctx);
    await commitResearchReport(actor, attempt, 0, reportFor(task.id), ctx);
    expect(await getResearchTask(other, task.id, ctx)).toBeNull();
    expect(await getResearchDocument(other, task.id, doc.id, 1, ctx)).toBeNull();
    expect(await getResearchReportRevision(other, task.id, 1, ctx)).toBeNull();
    expect(await researchVersionEventsAfter(other, task.id, 0, ctx)).toEqual([]);
    for (const kind of ['original','parsed'] as const) await expect(readResearchDocumentArtifact(other, task.id, doc.id, 1, kind, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(cancelResearchTask(other, task.id, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ctx.artifacts.read(other, ref(original))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readResearchDocumentArtifact(actor, task.id, doc.id, 1, 'original', ctx)).bytes.equals(original)).toBe(true);
  });
  it('fences superseded and cancelled attempts at tool/report boundaries and preserves logical budgets', async () => {
    const task = await taskWithPlan(); await attachDocument(task.id);
    const first = await startResearchAttempt(actor, task.id, 1, 'first', ctx);
    expect(await reserveResearchToolCall(actor, first, ctx)).toBe(1);
    const before = (await getResearchTask(actor, task.id, ctx))!.usage;
    await expect(startResearchAttempt(actor, task.id, 1, 'racer', ctx)).rejects.toMatchObject({ code: 'TASK_ACTIVE' });
    await prisma.$executeRaw`UPDATE company_research_attempts SET lease_until=NOW()-INTERVAL '1 second' WHERE id=${first.id}`;
    const second = await startResearchAttempt(actor, task.id, 1, 'second', ctx);
    expect(second.id).not.toBe(first.id); expect(second.generation).toBe(first.generation + 1);
    expect((await getResearchTask(actor, task.id, ctx))!.usage).toEqual(before);
    await expect(heartbeatResearchAttempt(actor, first, ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(reserveResearchToolCall(actor, first, ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(commitResearchReport(actor, first, 0, reportFor(task.id), ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await reserveResearchToolCall(actor, second, ctx)).toBe(2);
    await heartbeatResearchAttempt(actor, second, ctx);
    await cancelResearchTask(actor, task.id, ctx);
    await expect(commitResearchReport(actor, second, 0, reportFor(task.id), ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await getResearchTask(actor, task.id, ctx))!.status).toBe('cancelled');
    const events = await researchVersionEventsAfter(actor, task.id, 0, ctx);
    expect(events.map(e => e.sequence)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
    expect((await researchVersionEventsAfter(actor, task.id, 3, ctx)).every(e => e.sequence > 3)).toBe(true);
  });
  it('enforces cumulative call and time budgets instead of resetting them for recovery', async () => {
    const spec = specFixture(); spec.budget.maxToolCalls = 2;
    const task = await taskWithPlan(spec), attempt = await startResearchAttempt(actor, task.id, 1, 'limited', ctx);
    await reserveResearchToolCall(actor, attempt, ctx); await reserveResearchToolCall(actor, attempt, ctx);
    await expect(reserveResearchToolCall(actor, attempt, ctx)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    await prisma.$executeRaw`UPDATE company_research_attempts SET lease_until=NOW()-INTERVAL '1 second' WHERE id=${attempt.id}`;
    await expect(startResearchAttempt(actor, task.id, 1, 'recovery', ctx)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    const timed = await taskWithPlan(), timedAttempt = await startResearchAttempt(actor, timed.id, 1, 'timed', ctx);
    await prisma.$executeRaw`UPDATE company_research_tasks SET deadline=NOW()-INTERVAL '1 second' WHERE id=${timed.id}`;
    await expect(reserveResearchToolCall(actor, timedAttempt, ctx)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect((await getResearchTask(actor, task.id, ctx))!.usage.inputTokens).toBeNull();
  });
  it('stores immutable report revisions, retries once, and retains the previous report after a new attempt', async () => {
    const task = await taskWithPlan(); await attachDocument(task.id);
    const a = await startResearchAttempt(actor, task.id, 1, 'reporter-1', ctx), report = reportFor(task.id);
    const first = await commitResearchReport(actor, a, 0, report, ctx);
    const eventCount = (await researchVersionEventsAfter(actor, task.id, 0, ctx)).length;
    expect(await commitResearchReport(actor, a, 0, report, ctx)).toEqual(first);
    expect(await researchVersionEventsAfter(actor, task.id, 0, ctx)).toHaveLength(eventCount);
    await expect(commitResearchReport(actor, a, 0, { ...report, gaps: [] }, ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const b = await startResearchAttempt(actor, task.id, 1, 'reporter-2', ctx);
    await commitResearchReport(actor, b, 1, reportFor(task.id, 2), ctx);
    expect(await getResearchReportRevision(actor, task.id, 1, ctx)).toEqual(first);
    expect((await getResearchReportRevision(actor, task.id, 2, ctx))!.revision).toBe(2);
    await expect(prisma.$executeRaw`UPDATE company_research_report_versions SET report='{}'::jsonb WHERE task_id=${task.id}`).rejects.toThrow('RESEARCH_IMMUTABLE_VERSION');
  });
  it('rejects malformed or unsupported citations transactionally instead of advancing report state', async () => {
    const task = await taskWithPlan(); await attachDocument(task.id);
    const attempt = await startResearchAttempt(actor, task.id, 1, 'verifier', ctx), report = reportFor(task.id);
    report.claims[0].citations[0].quote = '原文没有这句';
    await expect(commitResearchReport(actor, attempt, 0, report, ctx)).rejects.toMatchObject({ code: 'INVALID_RESEARCH' });
    expect((await getResearchTask(actor, task.id, ctx))!.reportRevision).toBe(0);
    expect(await getResearchReportRevision(actor, task.id, 1, ctx)).toBeNull();
    const invalidDate = { ...reportFor(task.id), asOf: '2025-07-01T00:00:00Z' };
    await expect(commitResearchReport(actor, attempt, 0, invalidDate, ctx)).rejects.toMatchObject({ code: 'INVALID_RESEARCH' });
  });
  it('allows only one competing report revision and keeps its full payload', async () => {
    const task = await taskWithPlan(); await attachDocument(task.id);
    const attempt = await startResearchAttempt(actor, task.id, 1, 'racing-reporter', ctx), a = reportFor(task.id);
    const b = { ...reportFor(task.id), gaps: [{ ...a.gaps[0], message: '另一个草稿' }] };
    const results = await Promise.allSettled([a,b].map(r => commitResearchReport(actor, attempt, 0, r, ctx)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'REVISION_CONFLICT' } });
    const winner = results.findIndex(r => r.status === 'fulfilled');
    expect(await getResearchReportRevision(actor, task.id, 1, ctx)).toEqual([a,b][winner]);
  });
  it('rechecks a lease lost during artifact reads before publishing a report', async () => {
    const task = await taskWithPlan(); await attachDocument(task.id);
    const attempt = await startResearchAttempt(actor, task.id, 1, 'late-reporter', ctx), read = ctx.artifacts.read.bind(ctx.artifacts);
    const spy = vi.spyOn(ctx.artifacts, 'read').mockImplementation(async (actorId, reference) => {
      const bytes = await read(actorId, reference);
      await prisma.$executeRaw`UPDATE company_research_attempts SET lease_until=NOW()-INTERVAL '1 second' WHERE id=${attempt.id}`;
      return bytes;
    });
    try { await expect(commitResearchReport(actor, attempt, 0, reportFor(task.id), ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' }); }
    finally { spy.mockRestore(); }
    expect(await getResearchReportRevision(actor, task.id, 1, ctx)).toBeNull();
  });
  it('keeps document versions immutable and detects disk tampering before serving a cached artifact', async () => {
    const task = await taskWithPlan(), doc = await attachDocument(task.id);
    await expect(registerResearchDocument(actor, { ...doc, title: 'overwrite attempt' }, original, parsed, ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(registerResearchDocument(other, doc, original, parsed, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await registerResearchDocument(actor, { ...doc, version: 2, parser: { ...doc.parser, version: '2' } }, original, parsed, ctx);
    expect((await getResearchDocument(actor, task.id, doc.id, 1, ctx))!.parser!.version).toBe('1');
    const separateActor = `${actor}-tamper`, artifact = await ctx.artifacts.put(separateActor, Buffer.from('integrity-test'));
    const target = path.join(root, artifactDigest(separateActor), artifact.key), originalBytes = await readFile(target);
    await writeFile(target, Buffer.alloc(originalBytes.length, 'x'));
    await expect(ctx.artifacts.read(separateActor, artifact)).rejects.toThrow('RESEARCH_ARTIFACT_INTEGRITY');
    await expect(ctx.artifacts.read(actor, { ...ref(original), key: '../escape' })).rejects.toThrow();
  });
  it('rejects symlinked actor directories without following them', async () => {
    // Directory junctions exercise the same invariant on Windows without symlink privilege.
    const symlinkActor = `${actor}-link`, outside = path.join(root, 'outside-fixture'); await mkdir(outside);
    await symlink(outside, path.join(root, artifactDigest(symlinkActor)), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(ctx.artifacts.put(symlinkActor, Buffer.from('no escape'))).rejects.toThrow('RESEARCH_ARTIFACT_SYMLINK');
  });
});
