import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ auth: vi.fn(), queue: vi.fn(), history: vi.fn(), diff: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mock.auth }));
vi.mock('@/lib/company-research/report-update-store', () => ({ queueResearchReportUpdate: mock.queue, listResearchReportHistory: mock.history, getResearchReportDiff: mock.diff }));
vi.mock('@/lib/company-research/version-store', () => ({ getResearchTask: vi.fn() }));
import { POST as runUpdate } from './updates/run/route';
import { GET as listReports } from './reports/history/route';
import { GET as readDiff } from './reports/[revision]/diff/route';

const context = { params: Promise.resolve({ id: 'task-private', revision: '2' }) };
const body = { expectedRequestRevision: 1, expectedPlanRevision: 2, expectedReportRevision: 1, asOf: '2025-06-30T23:59:59.999+08:00' };
function request(url: string, method: string, origin = 'http://localhost') {
  return new Request(url, { method, headers: { origin, host: 'localhost', 'Content-Type': 'application/json', 'Idempotency-Key': 'research-update-key-01' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
}
beforeEach(() => { vi.clearAllMocks(); mock.auth.mockResolvedValue({ actorUserId: 'trusted-user' }); });

it('queues report updates only from authenticated same-origin requests with an idempotency key', async () => {
  mock.queue.mockResolvedValue({ queued: true, requestRevision: 1, planRevision: 3, affectedPeriods: ['fy2024'], sourceHashes: ['a'.repeat(64)] });
  const denied = await runUpdate(request('http://localhost/api/company-research/tasks/task-private/updates/run', 'POST', 'https://evil.example'), context);
  expect(denied.status).toBe(403);
  expect(mock.queue).not.toHaveBeenCalled();

  const response = await runUpdate(request('http://localhost/api/company-research/tasks/task-private/updates/run', 'POST'), context);
  expect(response.status).toBe(202);
  expect(mock.queue).toHaveBeenCalledWith('trusted-user', 'task-private', 'research-update-key-01', body);
});

it('returns an explicit no-change result without pretending a report was queued', async () => {
  mock.queue.mockResolvedValue({ queued: false, reason: 'no_new_evidence' });
  const response = await runUpdate(request('http://localhost/api/company-research/tasks/task-private/updates/run', 'POST'), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ update: { queued: false, reason: 'no_new_evidence' } });
});

it('scopes report history and adjacent diffs to the authenticated actor', async () => {
  mock.history.mockResolvedValue([{ revision: 1 }, { revision: 2 }]);
  mock.diff.mockResolvedValue({ fromRevision: 1, toRevision: 2 });
  const history = await listReports(request('http://localhost/api/company-research/tasks/task-private/reports/history', 'GET'), context);
  const diff = await readDiff(request('http://localhost/api/company-research/tasks/task-private/reports/2/diff', 'GET'), context);
  expect(await history.json()).toMatchObject({ reports: [{ revision: 1 }, { revision: 2 }] });
  expect(await diff.json()).toMatchObject({ diff: { fromRevision: 1, toRevision: 2 } });
  expect(mock.history).toHaveBeenCalledWith('trusted-user', 'task-private');
  expect(mock.diff).toHaveBeenCalledWith('trusted-user', 'task-private', 2);
});
