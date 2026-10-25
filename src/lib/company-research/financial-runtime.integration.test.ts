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
import { buildFinancialPlanV2 } from './plan-graph';
import { upgradeFinancialCheckpoint } from './financial-scheduler';
import { executeFinancialResearch } from './financial-runtime';
import { specFixture, documentFixture, reportFixture } from './version-test-fixtures';
import { registerResearchDocument } from './document-store';
import { commitResearchReport } from './report-store';
import { readResearchSource } from './source-reader';
import { safeResearchUrl } from './reader-contracts';
import { financialResearchTools } from './financial-tools';
import { acceptResearchReport } from './report-acceptance';
import { canonicalResearchJson } from './task-contracts';
import { queueResearchReportUpdate } from './report-update-store';
import { recordResearchUpdateRead } from './update-run-store';

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
  it('gives a later evidence update its own bounded budget while retaining all historical costs', async () => {
    const task = await queued(3), first = (await claimFinancialResearch('update-expired-baseline', ctx))!.attempt;
    await executeFinancialResearch(actor, first, undefined, ctx, sequenceProvider([{ name: 'check_coverage', input: {} }, { name: 'submit_report', input: {} }]), true);
    await prisma.$executeRaw`UPDATE company_research_tasks SET started_at=NOW()-INTERVAL '1 day',deadline=NOW()-INTERVAL '23 hours' WHERE id=${task.id}`;
    const before = (await getResearchTask(actor, task.id, ctx))!;
    const bytes = Buffer.from('%PDF-later-update'), parsed = Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [{ filePage: 5, text: '新的公告原文' }] }));
    const document = { ...documentFixture(task.id), bytesSha256: artifactDigest(bytes), original: ref(bytes), parsed: ref(parsed), state: 'ready' as const,
      fetchedAt: new Date().toISOString(), parser: { name: 'fixture', version: '1', failedPages: [], warnings: [] } };
    await registerResearchDocument(actor, document, bytes, parsed, ctx);
    const update = await queueResearchReportUpdate(actor, task.id, randomUUID(), { expectedRequestRevision: 1, expectedPlanRevision: 1, expectedReportRevision: 1, asOf: before.spec.asOf }, ctx);
    expect(update).toMatchObject({ queued: true, retry: false, budgetRevision: 2 });
    const token = (await claimFinancialResearch('update-fresh-budget', ctx))!.attempt;
    const report = await executeFinancialResearch(actor, token, undefined, ctx, sequenceProvider([
      { name: 'read_evidence', input: { documentId: document.id, documentVersion: 1, locator: { kind: 'page', filePage: 5 } } },
      { name: 'check_coverage', input: {} }, { name: 'submit_report', input: {} },
    ]), true);
    const after = (await getResearchTask(actor, task.id, ctx))!;
    expect(report?.revision).toBe(2); expect(after.checkpoint?.submitted).toBe(true);
    expect(after.budget).toEqual({ revision: 2, toolCalls: 3 });
    expect(after.usage).toMatchObject({ toolCalls: 5, inputTokens: 500, outputTokens: 100, unknownModelRequests: 0 });
    expect(Date.parse(after.usage.deadline!)).toBeGreaterThan(Date.now());
    const [history] = await prisma.$queryRaw<{snapshot: unknown}[]>`SELECT snapshot FROM company_research_budget_history WHERE task_id=${task.id} AND revision=1`;
    expect(history.snapshot).toMatchObject({ toolCalls: 2, cumulative: { toolCalls: 2, inputTokens: 200 }, startedAt: before.usage.startedAt, deadline: before.usage.deadline });
    await expect(prisma.$executeRaw`UPDATE company_research_budget_history SET snapshot='{}'::jsonb WHERE task_id=${task.id}`).rejects.toThrow('RESEARCH_IMMUTABLE_VERSION');
    expect(await queueResearchReportUpdate(actor, task.id, randomUUID(), { expectedRequestRevision: 1, expectedPlanRevision: 2, expectedReportRevision: 2, asOf: before.spec.asOf }, ctx)).toEqual({ queued: false, reason: 'no_new_evidence' });
  }, 30000);
  it('retries unread queued sources after a first-model failure without renewing that update budget', async () => {
    const task = await queued(), first = (await claimFinancialResearch('update-retry-baseline', ctx))!.attempt;
    await executeFinancialResearch(actor, first, undefined, ctx, sequenceProvider([{ name: 'check_coverage', input: {} }, { name: 'submit_report', input: {} }]), true);
    const bytes = Buffer.from('%PDF-unread-update');
    await registerResearchDocument(actor, { ...documentFixture(task.id), bytesSha256: artifactDigest(bytes), original: ref(bytes), fetchedAt: new Date().toISOString() }, bytes, undefined, ctx);
    const input = { expectedRequestRevision: 1, expectedPlanRevision: 1, expectedReportRevision: 1, asOf: specFixture().asOf }, key = randomUUID();
    await queueResearchReportUpdate(actor, task.id, key, input, ctx);
    const failed = (await claimFinancialResearch('update-offline', ctx))!.attempt;
    await executeFinancialResearch(actor, failed, undefined, ctx, { name: 'offline-fixture', async *complete() { throw new Error('Injected offline before any read'); } }, true);
    const before = (await getResearchTask(actor, task.id, ctx))!;
    expect(before).toMatchObject({ status: 'partial', reportRevision: 2, budget: { revision: 2, toolCalls: 0 }, usage: { unknownModelRequests: 1 } });
    expect((await queueResearchReportUpdate(actor, task.id, key, input, ctx))).toMatchObject({ idempotent: true });
    const retryInput = { ...input, expectedPlanRevision: 2, expectedReportRevision: 2 };
    const retried = await queueResearchReportUpdate(actor, task.id, randomUUID(), retryInput, ctx);
    expect(retried).toMatchObject({ queued: true, retry: true, budgetRevision: 2, sourceHashes: [artifactDigest(bytes)] });
    const token = (await claimFinancialResearch('update-retry', ctx))!.attempt;
    const after = (await getResearchTask(actor, task.id, ctx))!;
    expect(after.usage).toEqual(before.usage); expect(after.checkpoint?.stopReason).toBeNull();
    await expect(recordResearchUpdateRead(actor, failed, artifactDigest(bytes), ctx)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await executeFinancialResearch(actor, token, undefined, ctx, sequenceProvider([{ name: 'check_coverage', input: {} }, { name: 'submit_report', input: {} }]), true);
    // Submission without an actual read still cannot consume the source receipt.
    await prisma.$executeRaw`UPDATE company_research_tasks SET deadline=NOW()-INTERVAL '1 second' WHERE id=${task.id}`;
    await expect(queueResearchReportUpdate(actor, task.id, randomUUID(), { ...retryInput, expectedPlanRevision: 3, expectedReportRevision: 3 }, ctx)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect((await getResearchTask(actor, task.id, ctx))!.budget.revision).toBe(2);
  }, 30000);
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
  it('rejects B calls in the closure reserve before charging them and counts generation turns', async () => {
    const task = await queued(2), token = (await claimFinancialResearch('scheduler-reserve', ctx))!.attempt;
    const feedback: unknown[] = [];
    const report = await executeFinancialResearch(actor, token, undefined, ctx, sequenceProvider([
      { name: 'search_evidence', input: { query: '预算预留区不应再检索' } },
      { name: 'check_coverage', input: {} }, { name: 'submit_report', input: {} },
    ]), true, async record => { if (record.type === 'tool_result') feedback.push(record.data); }, undefined, undefined, { variant: 'B' });
    const snapshot = (await getResearchTask(actor, task.id, ctx))!;
    expect(report?.status).toBe('partial'); expect(snapshot.usage.toolCalls).toBe(2); expect(snapshot.usage.unknownModelRequests).toBe(0);
    expect(snapshot.checkpoint).toMatchObject({ schemaVersion: 2, variant: 'B', submitted: true, modelTurns: 3 });
    expect(report?.method).toMatchObject({ variant: 'B', modelTurns: 3 });
    expect(JSON.stringify(feedback)).toContain('SCHEDULER_CLOSURE_RESERVED');
  }, 30000);
  it('uses B targeted actions to close changed-query misses as partial without a not-disclosed assertion', async () => {
    const task = await queued(), token = (await claimFinancialResearch('scheduler-gap', ctx))!.attempt;
    let turns = 0;
    const provider: PiAgentModelProvider = { name: 'scheduler-gap-protocol-fixture', async *complete(request) {
      const view = request.messages.filter(message => message.role === 'user').map(message => {
        try { return JSON.parse(String(message.content)); } catch { return null; }
      }).findLast(value => value?.nextAction);
      const action = view?.nextAction; if (!action) throw new Error('Missing scheduler action');
      let name: string, input: unknown;
      if (action.kind === 'prepare') { name = 'list_documents'; input = {}; }
      else if (action.kind === 'retrieve') { name = 'search_evidence'; input = { query: `${action.questionId} 定向缺证 ${turns}` }; }
      else if (action.kind === 'compare') { name = 'record_claim'; input = { id: `${action.questionId}-gap`, questionId: action.questionId,
        text: '合成协议夹具：当前证据不足', status: 'evidence_gap', reason: '有界定向检索未获支持，不推断原文未披露', kind: 'fact', factIds: [], citations: [] }; }
      else if (action.kind === 'report') { name = view.checkpoint.checkedHash ? 'submit_report' : 'check_coverage'; input = {}; }
      else throw new Error(`Unexpected scheduler action ${action.kind}`);
      turns++;
      yield { type: 'response_start', responseId: `scheduler-gap-${turns}`, model: 'fixture' };
      yield { type: 'tool_call_delta', index: 0, id: `scheduler-gap-call-${turns}`, nameDelta: name, argumentsDelta: JSON.stringify(input) };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
      yield { type: 'finish', reason: 'tool_calls' };
    } };
    const report = await executeFinancialResearch(actor, token, undefined, ctx, provider, true, undefined, undefined, undefined, { variant: 'B' });
    const snapshot = (await getResearchTask(actor, task.id, ctx))!, state = snapshot.checkpoint;
    expect(report?.status).toBe('partial'); expect(state?.submitted).toBe(true); expect(state?.claims).toHaveLength(3);
    expect(state?.schemaVersion).toBe(2); if (state?.schemaVersion !== 2) throw new Error('Expected B checkpoint');
    expect(state.gaps.filter(gap => gap.status === 'partial')).toHaveLength(3);
    expect(state.gaps.every(gap => gap.type !== 'not_disclosed')).toBe(true);
    expect(state.gaps.every(gap => gap.stalledAttempts === 4)).toBe(true);
    expect(snapshot.usage.toolCalls).toBeLessThan(40); expect(state.modelTurns).toBe(turns);
  }, 30000);
  it('resumes the checkpoint-bound B variant by default and rejects an explicit downgrade to A', async () => {
    const task = await queued(2), token = (await claimFinancialResearch('scheduler-resume', ctx))!.attempt;
    const legacy = emptyCheckpoint(1, 1); legacy.modelTurns = 5;
    const state = upgradeFinancialCheckpoint(legacy, buildFinancialPlanV2(task.spec, { taskId: task.id, createdAt: new Date().toISOString() }), []);
    await saveResearchCheckpoint(actor, token, state, 'scheduler-fixture', ctx);
    await expect(executeFinancialResearch(actor, token, undefined, ctx, sequenceProvider([]), true, undefined, undefined, undefined, { variant: 'A' })).rejects.toThrow('FINANCIAL_VARIANT_MISMATCH');
    const report = await executeFinancialResearch(actor, token, undefined, ctx, sequenceProvider([{ name: 'check_coverage', input: {} }, { name: 'submit_report', input: {} }]), true);
    const snapshot = (await getResearchTask(actor, task.id, ctx))!;
    expect(report?.method).toMatchObject({ variant: 'B', modelTurns: 7 }); expect(snapshot.usage.toolCalls).toBe(2);
    expect(snapshot.checkpoint).toMatchObject({ schemaVersion: 2, variant: 'B', modelTurns: 7, submitted: true });
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

  describe('U14 B2 sequential batch protocol fixtures', () => {
    type Call = { name: string; input: unknown; id?: string };
    function batches(turns: Call[][]): PiAgentModelProvider {
      let turn = 0;
      return { name: 'B2-protocol-fixture', async *complete() {
        const calls = turns[turn++]; if (!calls) throw new Error('B2 fixture exhausted');
        yield { type: 'response_start', responseId: `B2-response-${turn}`, model: 'fixture' };
        for (const [index, call] of calls.entries()) yield { type: 'tool_call_delta', index, id: call.id || `B2-${turn}-${index}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.input) };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
        yield { type: 'finish', reason: 'tool_calls' };
      } };
    }
    const searches = (n: number): Call[] => Array.from({ length: n }, (_, index) => ({ name: 'search_evidence', input: { query: `合成批量定向缺证 ${index}` } }));
    const close: Call[][] = [[{ name: 'check_coverage', input: {} }], [{ name: 'submit_report', input: {} }]];
    const gapClaim: Call = { name: 'record_claim', input: { id: 'batch-income-gap', questionId: 'income_profit', text: '合成协议测试缺证',
      kind: 'fact', status: 'evidence_gap', reason: '夹具没有披露材料；不表示真实财报未披露', factIds: [], citations: [] } };

    it('charges each of three ordered reads once while reducing model turns from B five to B2 three', async () => {
      const bTask = await queued(5), bToken = (await claimFinancialResearch('B-comparison', ctx))!.attempt;
      const bReport = await executeFinancialResearch(actor, bToken, undefined, ctx, batches([...searches(3).map(call => [call]), ...close]), true, undefined, undefined, undefined, { variant: 'B' });
      const task = await queued(5), token = (await claimFinancialResearch('B2-three-read', ctx))!.attempt, order: string[] = [];
      const report = await executeFinancialResearch(actor, token, undefined, ctx, batches([searches(3), ...close]), true,
        async record => { if (record.type === 'tool_result') order.push((record.data as { toolCall: { id: string } }).toolCall.id); }, undefined, undefined, { variant: 'B2' });
      const snapshot = (await getResearchTask(actor, task.id, ctx))!;
      expect(snapshot.usage.toolCalls).toBe(5); expect(snapshot.budget.toolCalls).toBe(5);
      expect(snapshot.checkpoint).toMatchObject({ schemaVersion: 2, variant: 'B2', maxToolCallsPerTurn: 3, submitted: true, modelTurns: 3 });
      expect(report?.method).toMatchObject({ variant: 'B2', modelTurns: 3 }); expect(bReport?.method?.modelTurns).toBe(5);
      expect((await getResearchTask(actor, bTask.id, ctx))!.usage.toolCalls).toBe(5);
      expect(order.slice(0, 3)).toEqual(['B2-1-0', 'B2-1-1', 'B2-1-2']);
      expect(snapshot.checkpoint?.schemaVersion).toBe(2);
      if (snapshot.checkpoint?.schemaVersion !== 2) throw new Error('Expected B2 state');
      expect(snapshot.checkpoint.gaps.some(gap => gap.stalledAttempts === 1)).toBe(true);
      expect(snapshot.checkpoint.gaps.every(gap => gap.type !== 'not_disclosed')).toBe(true);
    }, 30000);

    it('allows a readonly call followed by one current-node state write', async () => {
      const task = await queued(), token = (await claimFinancialResearch('B2-read-then-state', ctx))!.attempt;
      const state = upgradeFinancialCheckpoint(emptyCheckpoint(1, 1), buildFinancialPlanV2(task.spec, { taskId: task.id, createdAt: new Date().toISOString() }), []);
      state.variant = 'B2'; state.maxToolCallsPerTurn = 3;
      for (const id of ['prepare-facts', 'income_profit-retrieve', 'cash_flow-retrieve', 'risks-retrieve']) state.nodes[id] = 'completed';
      await saveResearchCheckpoint(actor, token, state, 'B2-compare-fixture', ctx);
      const order: string[] = [];
      await executeFinancialResearch(actor, token, undefined, ctx, batches([[...searches(1), gapClaim]]), true,
        async record => { if (record.type === 'tool_result') order.push((record.data as { toolCall: { name: string } }).toolCall.name); });
      const snapshot = (await getResearchTask(actor, task.id, ctx))!;
      expect(snapshot.usage.toolCalls).toBe(2); expect(snapshot.checkpoint?.claims).toMatchObject([gapClaim.input]);
      expect(order).toEqual(['search_evidence', 'record_claim']);
    }, 30000);

    it('rejects whole turns before effects for state ordering, multiple mutations and a later invalid schema', async () => {
      const invalidBatches: { calls: Call[]; code: string }[] = [
        { calls: [gapClaim, ...searches(1)], code: 'FINANCIAL_BATCH_STATE_ORDER' },
        { calls: [gapClaim, { name: 'check_coverage', input: {} }], code: 'FINANCIAL_BATCH_STATE_COUNT' },
        { calls: [...searches(1), { name: 'read_evidence', input: { documentId: 'missing' } }], code: 'FINANCIAL_BATCH_ARGUMENTS' },
        { calls: [...searches(1), { name: 'missing_tool', input: {} }], code: 'FINANCIAL_BATCH_UNKNOWN_TOOL' },
      ];
      for (const scenario of invalidBatches) {
        const task = await queued(), token = (await claimFinancialResearch(`B2-invalid-${scenario.code}`, ctx))!.attempt, feedback: unknown[] = [];
        await executeFinancialResearch(actor, token, undefined, ctx, batches([scenario.calls]), true,
          async record => { if (record.type === 'tool_result') feedback.push(record.data); }, undefined, undefined, { variant: 'B2' });
        const snapshot = (await getResearchTask(actor, task.id, ctx))!;
        expect(snapshot.usage.toolCalls).toBe(0); expect(snapshot.checkpoint?.facts).toEqual([]); expect(snapshot.checkpoint?.claims).toEqual([]);
        expect(snapshot.checkpoint?.checkedHash).toBeNull(); expect(JSON.stringify(feedback)).toContain(scenario.code);
      }
    }, 30000);

    it('returns model-visible oversized-turn feedback and then accepts a corrected closure turn without charging the rejected batch', async () => {
      const task = await queued(2), token = (await claimFinancialResearch('B2-limit-feedback', ctx))!.attempt, feedback: unknown[] = [];
      const report = await executeFinancialResearch(actor, token, undefined, ctx, batches([searches(4), ...close]), true,
        async record => { if (record.type === 'tool_feedback') feedback.push(record.data); }, undefined, undefined, { variant: 'B2' });
      const snapshot = (await getResearchTask(actor, task.id, ctx))!;
      expect(snapshot.usage.toolCalls).toBe(2); expect(snapshot.checkpoint?.submitted).toBe(true);
      expect(report?.method?.modelTurns).toBe(3); expect(JSON.stringify(feedback)).toContain('FINANCIAL_BATCH_LIMIT');
    }, 30000);

    it('preflights closure reserve and duplicate identities without charging an otherwise valid first read', async () => {
      const reserveTask = await queued(3), reserveToken = (await claimFinancialResearch('B2-reserve-whole', ctx))!.attempt, feedback: unknown[] = [];
      await executeFinancialResearch(actor, reserveToken, undefined, ctx, batches([searches(2)]), true,
        async record => { if (record.type === 'tool_result') feedback.push(record.data); }, undefined, undefined, { variant: 'B2' });
      expect((await getResearchTask(actor, reserveTask.id, ctx))!.usage.toolCalls).toBe(0);
      expect(JSON.stringify(feedback)).toContain('FINANCIAL_BATCH_CLOSURE_RESERVED');
      const task = await queued(), token = (await claimFinancialResearch('B2-duplicate-id', ctx))!.attempt;
      await executeFinancialResearch(actor, token, undefined, ctx, batches([searches(2).map(call => ({ ...call, id: 'same' }))]), true, undefined, undefined, undefined, { variant: 'B2' });
      expect((await getResearchTask(actor, task.id, ctx))!.usage.toolCalls).toBe(0);
    }, 30000);

    it('inherits a B2 limit of five and cumulative model turns on recovery while rejecting explicit mismatches', async () => {
      const task = await queued(6), token = (await claimFinancialResearch('B2-custom-resume', ctx))!.attempt;
      const state = upgradeFinancialCheckpoint(emptyCheckpoint(1, 1), buildFinancialPlanV2(task.spec, { taskId: task.id, createdAt: new Date().toISOString() }), []);
      state.variant = 'B2'; state.maxToolCallsPerTurn = 5; state.modelTurns = 7;
      await saveResearchCheckpoint(actor, token, state, 'B2-resume-fixture', ctx);
      await expect(executeFinancialResearch(actor, token, undefined, ctx, batches([]), true, undefined, undefined, undefined, { maxToolCallsPerTurn: 3 })).rejects.toThrow('FINANCIAL_BATCH_LIMIT_MISMATCH');
      await expect(executeFinancialResearch(actor, token, undefined, ctx, batches([]), true, undefined, undefined, undefined, { variant: 'B' })).rejects.toThrow('FINANCIAL_VARIANT_MISMATCH');
      const report = await executeFinancialResearch(actor, token, undefined, ctx, batches([searches(4), ...close]), true);
      const snapshot = (await getResearchTask(actor, task.id, ctx))!;
      expect(snapshot.checkpoint).toMatchObject({ schemaVersion: 2, variant: 'B2', maxToolCallsPerTurn: 5, modelTurns: 10, submitted: true });
      expect(snapshot.usage.toolCalls).toBe(6); expect(report?.method).toMatchObject({ variant: 'B2', modelTurns: 10 });
    }, 30000);

    it('rechecks the next node after the first call rather than charging a now-disallowed second write', async () => {
      const task = await queued(), token = (await claimFinancialResearch('B2-dynamic-admission', ctx))!.attempt, feedback: unknown[] = [];
      const fact: Call = { name: 'record_fact', input: { periodId: task.spec.periods[0].id, metric: 'revenue', rawText: '100', unitLabel: '元', citations: reportFixture(task.id).facts[0].citations } };
      await executeFinancialResearch(actor, token, undefined, ctx, batches([[...searches(1), fact]]), true,
        async record => { if (record.type === 'tool_result') feedback.push(record.data); }, undefined, undefined, { variant: 'B2' });
      const snapshot = (await getResearchTask(actor, task.id, ctx))!;
      expect(snapshot.usage.toolCalls).toBe(1); expect(snapshot.checkpoint?.facts).toEqual([]);
      expect(JSON.stringify(feedback)).toContain('SCHEDULER_TOOL_NOT_ALLOWED');
    }, 30000);

    it.each(['cancel', 'lease'] as const)('does not precharge later batch items when %s occurs after the first result', async failure => {
      const task = await queued(), token = (await claimFinancialResearch(`B2-between-${failure}`, ctx))!.attempt, results: string[] = [];
      await executeFinancialResearch(actor, token, undefined, ctx, batches([searches(3)]), true, async record => {
        if (record.type !== 'tool_result') return;
        results.push((record.data as { toolCall: { id: string } }).toolCall.id);
        if (results.length === 1) {
          if (failure === 'cancel') await cancelResearchTask(actor, task.id, ctx);
          else await prisma.$executeRaw`UPDATE company_research_attempts SET lease_until=NOW()-INTERVAL '1 second' WHERE id=${token.id}`;
        }
      }, undefined, undefined, { variant: 'B2' });
      const snapshot = (await getResearchTask(actor, task.id, ctx))!;
      expect(snapshot.usage.toolCalls).toBe(1); expect(results).toEqual(['B2-1-0']); expect(snapshot.reportRevision).toBe(0);
      await cancelResearchTask(actor, task.id, ctx);
    }, 30000);
  });
});
