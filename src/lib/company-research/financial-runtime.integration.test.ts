import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/client';
import type { PiAgentModelProvider } from '@/lib/agent/types';
import { createResearchTask, getResearchTask, reviseResearchTask } from './version-store';
import { queueFinancialResearch, claimFinancialResearch, saveResearchCheckpoint, reserveResearchModelRequest } from './execution-store';
import { reserveResearchToolCall, cancelResearchTask } from './attempt-store';
import { ResearchArtifactStore, artifactDigest } from './artifact-store';
import { emptyCheckpoint } from './execution-contracts';
import { executeFinancialResearch } from './financial-runtime';
import { specFixture, documentFixture, reportFixture } from './version-test-fixtures';
import { registerResearchDocument } from './document-store';
import { commitResearchReport } from './report-store';
import { readResearchSource } from './source-reader';
import { safeResearchUrl } from './reader-contracts';
import { financialResearchTools } from './financial-tools';
import { acceptResearchReport } from './report-acceptance';
import { canonicalResearchJson } from './task-contracts';

const actor = `financial-runtime-test-${randomUUID()}`, ctx = { db: prisma, artifacts: new ResearchArtifactStore(path.resolve('data/research-agent-upgrade/evidence/S11', actor)) };
const ref = (b: Buffer) => ({ store: 'local' as const, key: artifactDigest(b), sha256: artifactDigest(b), byteLength: b.length });
async function queued(maxToolCalls = 40) {
  const spec = specFixture(); spec.budget.maxToolCalls = maxToolCalls;
  const task = (await createResearchTask(actor, spec, randomUUID(), ctx))!;
  await queueFinancialResearch(actor, task.id, 0, ctx); return task;
}
function sequenceProvider(calls: {name: string; input: unknown}[]): PiAgentModelProvider {
  let turn = 0;
  return { name: 'deterministic-protocol-fixture', async *complete() {
    const c = calls[turn++]; if (!c) throw new Error('Fixture exhausted');
    yield { type: 'response_start', responseId: `response-${turn}`, model: 'fixture' };
    yield { type: 'tool_call_delta', index: 0, id: `call-${turn}`, nameDelta: c.name, argumentsDelta: JSON.stringify(c.input) };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    yield { type: 'finish', reason: 'tool_calls' };
  } };
}
describe.skipIf(process.env.COMPANY_RESEARCH_TEST_POSTGRES !== '1')('financial execution, recovery and evidence reader with PostgreSQL', () => {
  beforeAll(() => {
    const u = new URL(process.env.DATABASE_URL!);
    if (process.env.DATABASE_URL !== process.env.RESEARCH_TEST_DATABASE_URL || !['localhost', '127.0.0.1'].includes(u.hostname) || u.pathname !== '/research_test') throw new Error('Disposable database required');
  });
  afterAll(async () => { await prisma.$executeRaw`DELETE FROM company_research_tasks WHERE actor_id=${actor}`; await prisma.$disconnect(); });
  it('queues one plan, claims once concurrently and seals exhausted recovery without a model or budget reset', async () => {
    const task = await queued(1); await queueFinancialResearch(actor, task.id, 0, ctx);
    const claims = await Promise.all([claimFinancialResearch('one', ctx), claimFinancialResearch('two', ctx)]);
    expect(claims.filter(Boolean)).toHaveLength(1); const first = claims.find(Boolean)!;
    const state = emptyCheckpoint(1, 1); await saveResearchCheckpoint(actor, first.attempt, state, 'fixture', ctx);
    await reserveResearchToolCall(actor, first.attempt, ctx); await reserveResearchModelRequest(actor, first.attempt, ctx);
    const before = (await getResearchTask(actor, task.id, ctx))!;
    await prisma.$executeRaw`UPDATE company_research_attempts SET lease_until=NOW()-INTERVAL '1 second' WHERE id=${first.attempt.id}`;
    const next = (await claimFinancialResearch('recovery', ctx))!; expect(next.attempt.generation).toBe(2);
    await expect(saveResearchCheckpoint(actor, first.attempt, state, 'late', ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const report = await executeFinancialResearch(actor, next.attempt, undefined, ctx, { name: 'must-not-run', complete() { throw new Error('Budget reset'); } });
    expect(report?.status).toBe('partial');
    const after = (await getResearchTask(actor, task.id, ctx))!;
    expect(after.usage.startedAt).toBe(before.usage.startedAt); expect(after.usage.deadline).toBe(before.usage.deadline);
    expect(after.usage.toolCalls).toBe(1); expect(after.usage.unknownModelRequests).toBe(1); expect(after.reportRevision).toBe(1);
    await executeFinancialResearch(actor, next.attempt, undefined, ctx); expect((await getResearchTask(actor, task.id, ctx))!.reportRevision).toBe(1);
  });
  it('keeps an exhausted logical budget exhausted after a request revision', async () => {
    const task = await queued(1), first = (await claimFinancialResearch('revision-budget-first', ctx))!.attempt;
    await reserveResearchToolCall(actor, first, ctx); await reserveResearchModelRequest(actor, first, ctx);
    const before = (await getResearchTask(actor, task.id, ctx))!;
    await reviseResearchTask(actor, task.id, 1, 1, `revision-budget-${randomUUID()}`, { asOf: '2025-07-01T00:00:00Z' }, ctx);
    const next = (await claimFinancialResearch('revision-budget-next', ctx))!.attempt;
    const report = await executeFinancialResearch(actor, next, undefined, ctx, { name: 'must-not-run-after-revision', complete() { throw new Error('Revision reset an exhausted budget'); } });
    const after = (await getResearchTask(actor, task.id, ctx))!;
    expect(report?.status).toBe('partial'); expect(next.planRevision).toBe(2); expect(next.requestRevision).toBe(2);
    expect(after.usage).toMatchObject({ toolCalls: 1, unknownModelRequests: 1, startedAt: before.usage.startedAt, deadline: before.usage.deadline });
    expect(after.reportRevision).toBe(1);
  });
  it('uses the real PI loop and stops repeated no-progress searches with an honest partial', async () => {
    const task = await queued(), token = (await claimFinancialResearch('loop', ctx))!.attempt;
    const provider = sequenceProvider(Array.from({ length: 8 }, () => ({ name: 'search_evidence', input: { query: '经营现金流', topK: 5, maxOutputCharacters: 10000 } })));
    const report = await executeFinancialResearch(actor, token, undefined, ctx, provider, true);
    const snapshot = (await getResearchTask(actor, task.id, ctx))!;
    expect(report?.status).toBe('partial'); expect(snapshot.checkpoint?.stopReason).toContain('连续四次');
    expect(snapshot.usage.toolCalls).toBe(5); expect(snapshot.usage.unknownModelRequests).toBe(0);
    expect(snapshot.usage.inputTokens).toBe(500);
    expect(snapshot.checkpoint?.observations.some(o => o.tool === 'search_evidence' && o.summary.includes('scopedDocumentCount'))).toBe(true);
  }, 30000);
  it('honors cancellation between the model response and tool execution', async () => {
    const task = await queued(), token = (await claimFinancialResearch('cancel', ctx))!.attempt;
    const provider: PiAgentModelProvider = { name: 'cancel-fixture', async *complete() {
      yield { type: 'response_start', responseId: 'cancel', model: 'fixture' }; await cancelResearchTask(actor, task.id, ctx);
      yield { type: 'tool_call_delta', index: 0, id: 'cancelled-tool', nameDelta: 'list_documents', argumentsDelta: '{}' };
      yield { type: 'finish', reason: 'tool_calls' };
    } };
    await executeFinancialResearch(actor, token, undefined, ctx, provider, true);
    const snapshot = (await getResearchTask(actor, task.id, ctx))!; expect(snapshot.status).toBe('cancelled'); expect(snapshot.reportRevision).toBe(0); expect(snapshot.usage.toolCalls).toBe(0);
  });
  it('accepts omitted reader defaults through PI, preserves unrelated draft claims and retains conflicting amounts', async () => {
    const task = await queued(), token = (await claimFinancialResearch('tool-contract', ctx))!.attempt;
    const citation = { ...reportFixture(task.id).facts[0].citations[0], quote: '经营活动产生的现金流量净额 250.00' };
    for (const [version, amount] of [[1, '250.00'], [2, '300.00']] as const) {
      const original = Buffer.from(`%PDF-tool-contract-${version}`), text = `单位：元\n2024年\n经营活动产生的现金流量净额 ${amount}`;
      const parsed = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ filePage: 5, text }] }));
      await registerResearchDocument(actor, { ...documentFixture(task.id), version, bytesSha256: artifactDigest(original), original: ref(original), parsed: ref(parsed), state: 'ready', parser: { name: 'fixture', version: '1', failedPages: [], warnings: [] } }, original, parsed, ctx);
      if (version === 1) citation.bytesSha256 = artifactDigest(original);
    }
    const provider = sequenceProvider([
      { name: 'read_evidence', input: { documentId: citation.documentId, documentVersion: 2, locator: citation.locator } },
      { name: 'check_coverage', input: {} }, { name: 'submit_report', input: {} },
    ]);
    await executeFinancialResearch(actor, token, undefined, ctx, provider, true);
    expect((await getResearchTask(actor, task.id, ctx))?.checkpoint?.observations.find(o => o.tool === 'read_evidence')?.summary).toContain('300.00');
    // Test local repair against a separate live attempt; no model/reviewer is faked as accepted.
    const repairTask = await queued(), repair = (await claimFinancialResearch('repair', ctx))!.attempt;
    for (const [version, amount] of [[1, '250.00'], [2, '300.00']] as const) {
      const original = Buffer.from(`%PDF-tool-contract-${version}`), parsed = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ filePage: 5, text: `单位：元\n2024年\n经营活动产生的现金流量净额 ${amount}` }] }));
      await registerResearchDocument(actor, { ...documentFixture(repairTask.id), version, bytesSha256: artifactDigest(original), original: ref(original), parsed: ref(parsed), state: 'ready', parser: { name: 'fixture', version: '1', failedPages: [], warnings: [] } }, original, parsed, ctx);
    }
    const state = emptyCheckpoint(1, 1), tools = financialResearchTools(actor, repair, repairTask.spec, state, 'fixture', async () => {}, ctx, true);
    const call = (name: string, input: unknown) => tools.find(t => t.name === name)!.execute(input, { runId: repair.id, turn: 1, toolCallId: randomUUID(), operationId: randomUUID(), signal: new AbortController().signal });
    const factInput = { periodId: 'fy2024', metric: 'operating_cash_flow', rawText: '250.00', unitLabel: '元', citations: [citation] };
    expect((await call('record_fact', factInput)).ok).toBe(true);
    const claim = { id: 'cash', questionId: 'cash_flow', text: '本期经营现金流250元', kind: 'fact', status: 'supported', factIds: [], citations: [citation] };
    expect((await call('record_claim', claim)).ok).toBe(true);
    expect((await call('record_claim', { ...claim, id: 'risk', questionId: 'risks' })).ok).toBe(true);
    expect(state.claims.map(c => c.status)).toEqual(['supported', 'supported']);
    expect((await call('check_coverage', {})).ok).toBe(true);
    expect(state.phase).toBe('verifying'); // An incomplete coverage check must still permit local repair.
    expect(state.checkedHash).not.toBeNull();
    const second = { ...citation, documentVersion: 2, bytesSha256: artifactDigest(Buffer.from('%PDF-tool-contract-2')), quote: '经营活动产生的现金流量净额 300.00' };
    expect((await call('record_fact', { ...factInput, rawText: '300.00', citations: [second] })).ok).toBe(true);
    expect(state.checkedHash).toBeNull();
    expect(state.facts[0].value.status).toBe('conflict'); expect(state.facts[0].citations).toHaveLength(2);
    await call('record_fact', factInput); expect(state.facts[0].value.status).toBe('conflict');
    await cancelResearchTask(actor, repairTask.id, ctx);
  }, 30000);
  it('binds explicit report acceptance to the actor, immutable complete revision and hash', async () => {
    const task = await queued(), token = (await claimFinancialResearch('acceptance-fixture', ctx))!.attempt;
    const report = reportFixture(task.id); report.facts = []; report.claims[0].factIds = []; report.claims[0].status = 'evidence_gap'; report.claims[0].reason = 'fixture'; report.claims[0].citations = [];
    await commitResearchReport(actor, token, 0, report, ctx);
    const hash = artifactDigest(canonicalResearchJson(report)), input = { reportRevision: 1, reportHash: hash, checkedNumbersAndExplanations: true };
    await expect(acceptResearchReport(actor, task.id, input, ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(acceptResearchReport(actor + '-other', task.id, input, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const complete = { ...report, revision: 2, status: 'completed', facts: [], claims: [{ ...report.claims[0], status: 'supported', reason: undefined, citations: [reportFixture(task.id).claims[0].citations[0]] }], gaps: [] };
    await prisma.$executeRaw`INSERT INTO company_research_report_versions(task_id,revision,request_revision,plan_revision,attempt_id,generation,report) VALUES (${task.id},2,1,1,${token.id},${token.generation},${JSON.stringify(complete)}::jsonb)`;
    const acceptedInput = { ...input, reportRevision: 2, reportHash: artifactDigest(canonicalResearchJson(complete)) };
    await expect(acceptResearchReport(actor, task.id, { ...acceptedInput, reportHash: '0'.repeat(64) }, ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await acceptResearchReport(actor, task.id, acceptedInput, ctx)).toEqual({ accepted: true, reportRevision: 2 });
    await acceptResearchReport(actor, task.id, acceptedInput, ctx);
    const [count] = await prisma.$queryRaw<{n: bigint}[]>`SELECT count(*) AS n FROM company_research_report_acceptances WHERE task_id=${task.id}`;
    expect(Number(count.n)).toBe(1);
  });
  it('requires a trusted semantic receipt even when a caller publishes directly', async () => {
    const task = await queued(), token = (await claimFinancialResearch('publisher', ctx))!.attempt;
    const original = Buffer.from('%PDF-test semantic gate'), parsed = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ filePage: 5, text: '经营现金流原文测试' }] }));
    const doc = { ...documentFixture(task.id), bytesSha256: artifactDigest(original), original: ref(original), parsed: ref(parsed), state: 'ready', parser: { name: 'fixture', version: '1', failedPages: [], warnings: [] } };
    await registerResearchDocument(actor, doc, original, parsed, ctx);
    const report = reportFixture(task.id); report.facts = []; report.claims[0].factIds = []; report.claims[0].citations[0].bytesSha256 = artifactDigest(original);
    await expect(commitResearchReport(actor, token, 0, report, ctx)).rejects.toThrow('CLAIM_REVIEW_MISSING');
    await cancelResearchTask(actor, task.id, ctx);
  });
  it('reads the retained text version and scanned table cell, rejects cross-actor reads and unsafe links', async () => {
    const task = await queued(), token = (await claimFinancialResearch('reader', ctx))!.attempt, original = Buffer.from('%PDF-text retained');
    const text = '合成注入防护夹具：营业表现保持稳定。<script>alert(1)</script><img src=x onerror=alert(2)>';
    const parsed = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ filePage: 5, text }] }));
    const doc = { ...documentFixture(task.id), title: '注入防护夹具（合成）', url: 'javascript:alert(1)', bytesSha256: artifactDigest(original), original: ref(original), parsed: ref(parsed), state: 'ready', parser: { name: 'fixture', version: '1', failedPages: [], warnings: [] } };
    await registerResearchDocument(actor, doc, original, parsed, ctx);
    const state = emptyCheckpoint(1, 1), citation = { documentId: doc.id, documentVersion: 1, bytesSha256: doc.bytesSha256, locator: { kind: 'page' as const, filePage: 5 }, quote: '营业表现保持稳定。' };
    state.claims = [{ id: 'text', questionId: 'risks', text: '原始披露', status: 'evidence_gap', reason: '语义待审', kind: 'fact', factIds: [], citations: [citation] }];
    const scan = Buffer.from('%PDF-scanned retained'), box = { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.3 };
    const receipt = { schemaVersion: 2, originalSha256: artifactDigest(scan), mediaType: 'application/pdf', parser: { name: 'ocr-fixture', version: '1' }, pageCount: 1, status: 'partial', failedPages: [], truncatedPages: [], warnings: [], pages: [{ filePage: 1, text: '100.00', blocks: [{ id: 'table', order: 0, kind: 'table', text: '100.00', locator: { kind: 'block', filePage: 1, blockId: 'table' }, quality: 'needs_review', flags: [], table: { id: 'grid', rows: 1, columns: 1, cells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: '100.00', header: false, box }] } }] }] };
    const scanParsed = Buffer.from(JSON.stringify(receipt));
    await registerResearchDocument(actor, { ...doc, version: 2, bytesSha256: artifactDigest(scan), original: ref(scan), parsed: ref(scanParsed), pageCount: 1, state: 'partial', parser: { ...receipt.parser, failedPages: [], warnings: [] } }, scan, scanParsed, ctx);
    state.claims.push({ ...state.claims[0], id: 'scan', citations: [{ ...citation, documentVersion: 2, bytesSha256: artifactDigest(scan), quote: '100.00', locator: { kind: 'table', filePage: 1, tableId: 'grid', row: 0, column: 0, box } }] });
    await saveResearchCheckpoint(actor, token, state, 'reader', ctx);
    const source = await readResearchSource(actor, task.id, { reportRevision: 0, claimId: 'text', citationIndex: 0 }, ctx);
    expect(source.document.version).toBe(1); expect(source.document.bytesSha256).toBe(doc.bytesSha256); expect(source.highlight).not.toBeNull(); expect(source.coordinate).toBeNull();
    const table = await readResearchSource(actor, task.id, { reportRevision: 0, claimId: 'scan', citationIndex: 0 }, ctx);
    expect(table.selectedCell).toEqual({ row: 0, column: 0 }); expect(table.coordinate).toEqual(box); expect(table.quality).toBe('needs_review');
    await expect(readResearchSource(actor + '-other', task.id, { reportRevision: 0, claimId: 'scan', citationIndex: 0 }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(safeResearchUrl('javascript:alert(1)')).toBeNull(); expect(safeResearchUrl('data:text/html,<script>')).toBeNull();
    await cancelResearchTask(actor, task.id, ctx);
    const fixtureRoot = path.resolve('data/research-agent-upgrade/evidence/S15', actor); await mkdir(fixtureRoot, { recursive: true });
    await writeFile(path.join(fixtureRoot, 'reader-fixture.json'), JSON.stringify({ scope: 'synthetic hostile PDF text retained through the real repository; not financial model evidence', task: await getResearchTask(actor, task.id, ctx), sources: [source, table] }, null, 2));
  });
});
