import '../workers/worker-environment';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/db/client';
import type { PiAgentModelProvider } from '../../src/lib/agent/types';
import { ResearchArtifactStore } from '../../src/lib/company-research/artifact-store';
import { specFixture } from '../../src/lib/company-research/version-test-fixtures';
import { createResearchTask, getResearchTask } from '../../src/lib/company-research/version-store';
import { claimFinancialResearch, queueFinancialResearch, saveResearchCheckpoint } from '../../src/lib/company-research/execution-store';
import { heartbeatResearchAttempt, type ResearchAttemptToken } from '../../src/lib/company-research/attempt-store';
import { executeFinancialResearch } from '../../src/lib/company-research/financial-runtime';
import { safeError } from '../../src/lib/company-research/config';

function disposable() {
  const u = new URL(process.env.DATABASE_URL!);
  assert.equal(process.env.DATABASE_URL, process.env.RESEARCH_TEST_DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(u.hostname) && u.pathname === '/research_test', 'Disposable database required');
}
const root = path.resolve(process.env.RESEARCH_RELIABILITY_ROOT || `data/research-agent-upgrade/evidence/S18/${randomUUID()}`);
const ctx = { db: prisma, artifacts: new ResearchArtifactStore(path.join(root, 'artifacts')) };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function protocol(names: string[], ready?: () => void): PiAgentModelProvider {
  let turn = 0;
  return { name: 'deterministic-interruption-protocol-not-a-quality-eval', async *complete(request) {
    const name = names[turn++];
    if (!name) {
      ready?.();
      await new Promise<void>((_, reject) => { request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
      return;
    }
    yield { type: 'response_start', responseId: `response-${turn}`, model: 'protocol-fixture' };
    yield { type: 'tool_call_delta', index: 0, id: `call-${turn}`, nameDelta: name, argumentsDelta: '{}' };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
    yield { type: 'finish', reason: 'tool_calls' };
  } };
}
async function child() {
  const claim = await claimFinancialResearch(`interrupt-child-${process.pid}`, ctx); assert(claim);
  assert.equal(claim.attempt.taskId, process.env.RESEARCH_INTERRUPT_TASK);
  const provider = protocol(['list_documents'], () => process.send?.({ type: 'paused-after-checkpoint', token: claim.attempt, pid: process.pid }));
  await executeFinancialResearch(claim.actor, claim.attempt, undefined, ctx, provider, true);
}
async function main() {
  disposable(); await mkdir(root, { recursive: true });
  if (process.argv.includes('--child')) return child();
  const actor = `research-interrupt-${randomUUID()}`, task = (await createResearchTask(actor, specFixture(), randomUUID(), ctx))!;
  let worker: ReturnType<typeof fork> | undefined, exited = false;
  const started = Date.now();
  try {
    await queueFinancialResearch(actor, task.id, 0, ctx);
    worker = fork(fileURLToPath(import.meta.url), ['--child'], { execArgv: ['--import', 'tsx'], env: { ...process.env,
      RESEARCH_RELIABILITY_ROOT: root, RESEARCH_INTERRUPT_TASK: task.id }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    worker.stdout?.on('data', data => { void appendFile(path.join(root, 'child.stdout.jsonl'), data); });
    worker.stderr?.on('data', data => { void appendFile(path.join(root, 'child.stderr.log'), data); });
    const exit = once(worker, 'exit').then(result => { exited = true; return result; });
    let readyTimer: ReturnType<typeof setTimeout>;
    const ready = new Promise<{token: ResearchAttemptToken; pid: number}>((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error('Child did not reach persisted checkpoint in 30 seconds')), 30000);
      worker!.on('message', message => { const m = message as {type: string; token: ResearchAttemptToken; pid: number}; if (m.type === 'paused-after-checkpoint') resolve(m); });
      worker!.once('error', reject);
    });
    const message = await ready.finally(() => clearTimeout(readyTimer));
    const before = (await getResearchTask(actor, task.id, ctx))!;
    assert.equal(before.usage.toolCalls, 1); assert.equal(before.usage.unknownModelRequests, 1);
    assert(before.checkpoint?.observations.some(o => o.tool === 'list_documents'));
    worker.kill('SIGKILL'); const exitResult = await exit;
    assert.equal(await claimFinancialResearch('too-early', ctx), null);
    console.log('Child forcibly terminated; waiting for the original 60 second lease, no SQL clock changes.');
    let next: Awaited<ReturnType<typeof claimFinancialResearch>> = null;
    const waitStarted = Date.now();
    while (!next && Date.now() - waitStarted < 75000) { await pause(1000); next = await claimFinancialResearch('interrupt-recovery', ctx); }
    assert(next); assert.equal(next.attempt.taskId, task.id); assert.equal(next.attempt.generation, message.token.generation + 1);
    await assert.rejects(heartbeatResearchAttempt(actor, message.token, ctx), { code: 'LEASE_LOST' });
    await assert.rejects(saveResearchCheckpoint(actor, message.token, before.checkpoint!, 'late-child', ctx), { code: 'LEASE_LOST' });
    const observations: unknown[] = [];
    await executeFinancialResearch(actor, next.attempt, undefined, ctx, protocol(['check_coverage', 'submit_report']), true, undefined, record => observations.push(record));
    const after = (await getResearchTask(actor, task.id, ctx))!;
    assert.equal(after.status, 'partial'); assert.equal(after.reportRevision, 1); assert.equal(after.usage.toolCalls, 3);
    assert.equal(after.usage.startedAt, before.usage.startedAt); assert.equal(after.usage.deadline, before.usage.deadline);
    assert.equal(after.usage.unknownModelRequests, 1); assert.equal(after.usage.inputTokens, 300); // Known subtotal; interrupted request remains explicitly unknown.
    await executeFinancialResearch(actor, next.attempt, undefined, ctx, protocol([]), true);
    assert.equal((await getResearchTask(actor, task.id, ctx))!.reportRevision, 1);
    const result = { version: 'real-child-interruption-v1', passed: true, scope: 'real OS process kill + real PostgreSQL + PI protocol fixture; no live model',
      taskId: task.id, childPid: message.pid, exitResult, naturalLeaseWaitMs: Date.now() - waitStarted, elapsedMs: Date.now() - started,
      before: { generation: before.generation, usage: before.usage, checkpoint: before.checkpoint },
      after: { generation: after.generation, usage: after.usage, status: after.status, reportRevision: after.reportRevision }, observations, cost: 'unknown' };
    await writeFile(path.join(root, 'interruption.json'), JSON.stringify(result, null, 2)); console.log(`Real interruption passed: ${root}`);
  } finally {
    if (worker && !exited) worker.kill('SIGKILL');
    // Delete only this script's disposable actor rows; immutable evidence remains on disk.
    await prisma.$executeRaw`DELETE FROM company_research_tasks WHERE actor_id=${actor}`;
  }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
