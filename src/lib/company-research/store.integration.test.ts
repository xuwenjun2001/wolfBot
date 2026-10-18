import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import dotenv from 'dotenv';
import { prisma } from '@/lib/db/client';
import { cancelRun, checkpoint, createRun, eventsAfter, getRun, heartbeat, type StoredRun } from './store';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const enabled = process.env.COMPANY_RESEARCH_TEST_POSTGRES === '1';
const actor = `research-test-${randomUUID()}`;
const company = { symbol: '300750', name: '测试公司' };
describe.skipIf(!enabled)('company research PostgreSQL invariants', () => {
  afterAll(async () => {
    // Only this test's uniquely named actor owns these disposable fixtures.
    await prisma.$executeRaw`DELETE FROM company_research_runs WHERE actor_id=${actor}`;
    await prisma.$disconnect();
  });
  it('enforces owner isolation and idempotency payload conflicts', async () => {
    const key = randomUUID();
    const first = await createRun(actor, company, key);
    expect((await createRun(actor, company, key)).id).toBe(first.id);
    await expect(createRun(actor, { ...company, symbol: '600519' }, key)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await getRun('different-actor', first.id)).toBeNull();
    expect(await cancelRun('different-actor', first.id)).toBe(0);
    expect(await eventsAfter('different-actor', first.id, 0)).toEqual([]);
    await cancelRun(actor, first.id);
    expect((await getRun(actor, first.id))?.status).toBe('cancelled');
  });
  it('commits stable trace snapshots, supports replay and fences stale workers', async () => {
    const created = await createRun(actor, company, randomUUID());
    const [run] = await prisma.$queryRaw<StoredRun[]>`UPDATE company_research_runs SET status='running',lease_owner='test-worker',generation=1,lease_until=NOW()+INTERVAL '60 seconds',started_at=NOW() WHERE id=${created.id} RETURNING *`;
    run.steps.push({ number: 1, tool: 'web_search', title: '搜索', status: 'running', input: { query: '公司主营业务' }, summary: '', startedAt: new Date().toISOString() });
    run.state.toolCalls++;
    await checkpoint(run);
    run.steps[0].status = 'completed'; run.steps[0].summary = '已找到来源';
    await checkpoint(run);
    const events = await eventsAfter(actor, run.id, 1);
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(2);
    expect(events[0].payload.steps).toHaveLength(1);
    expect(events[0].payload.steps[0].status).toBe('completed');
    await prisma.$executeRaw`UPDATE company_research_runs SET generation=2 WHERE id=${run.id}`;
    await expect(checkpoint(run)).rejects.toThrow('LEASE_LOST');
    await expect(heartbeat(run)).rejects.toThrow('LEASE_LOST');
    run.generation = 2;
    await cancelRun(actor, run.id);
    expect(await heartbeat(run)).toBe(true);
    await checkpoint(run, 'completed');
    expect((await getRun(actor, run.id))?.status).toBe('cancelled');
  });
});
