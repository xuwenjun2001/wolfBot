import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ auth: vi.fn(), queue: vi.fn(), task: vi.fn(), source: vi.fn(), events: vi.fn(), accept: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mock.auth }));
vi.mock('@/lib/company-research/execution-store', () => ({ queueFinancialResearch: mock.queue }));
vi.mock('@/lib/company-research/version-store', () => ({ getResearchTask: mock.task, researchVersionEventsAfter: mock.events }));
vi.mock('@/lib/company-research/source-reader', () => ({ readResearchSource: mock.source }));
vi.mock('@/lib/company-research/report-acceptance', () => ({ acceptResearchReport: mock.accept }));
import { POST } from './start/route';
import { GET as sourceGET } from './source/route';
import { GET as streamGET } from './events/route';
import { POST as acceptPOST } from './accept/route';
const context = { params: Promise.resolve({ id: 'task-private' }) };
beforeEach(() => { vi.clearAllMocks(); mock.auth.mockResolvedValue({ actorUserId: 'trusted-user' }); });
it('queues from the authorized identity and rejects cross-origin or malformed execution requests', async () => {
  const request = () => new Request('http://localhost/api/company-research/tasks/task-private/start', { method: 'POST', body: '{"expectedPlanRevision":0}', headers: { origin: 'http://localhost', host: 'localhost' } });
  mock.task.mockResolvedValue({ id: 'task-private', status: 'queued' });
  expect((await POST(request(), context)).status).toBe(202);
  expect(mock.queue).toHaveBeenCalledWith('trusted-user', 'task-private', 0);
  const bad = request(); bad.headers.set('origin', 'https://evil.example'); expect((await POST(bad, context)).status).toBe(403);
  expect(mock.queue).toHaveBeenCalledTimes(1);
});
it('authorizes source reads before invoking the repository and does not accept a query actor', async () => {
  mock.source.mockResolvedValue({ text: '<script>source data</script>' });
  const r = await sourceGET(new Request('http://localhost/api/company-research/tasks/task-private/source?actor=other&reportRevision=1&claimId=risk&citationIndex=0'), context);
  expect(r.status).toBe(200); expect(mock.source).toHaveBeenCalledWith('trusted-user', 'task-private', { reportRevision: 1, claimId: 'risk', citationIndex: 0 });
  mock.auth.mockRejectedValue(new Error('denied')); await sourceGET(new Request('http://localhost/api/company-research/tasks/task-private/source'), context);
  expect(mock.source).toHaveBeenCalledTimes(1);
});
it('always begins reconnect with a terminal authoritative snapshot even with a stale cursor', async () => {
  mock.task.mockResolvedValue({ id: 'task-private', sequence: 14, status: 'cancelled', generation: 2 }); mock.events.mockResolvedValue([]);
  const r = await streamGET(new Request('http://localhost/api/company-research/tasks/task-private/events', { headers: { 'last-event-id': '3' } }), context);
  const text = await r.text(); expect(text).toContain('event: snapshot'); expect(text).toContain('id: 14'); expect(text).toContain('"status":"cancelled"');
  expect(r.headers.get('cache-control')).toContain('no-store');
});
it('records only authenticated same-origin human acceptance of an explicit report revision', async () => {
  const input = { reportRevision: 1, reportHash: 'a'.repeat(64), checkedNumbersAndExplanations: true };
  const request = (origin: string) => new Request('http://localhost/api/company-research/tasks/task-private/accept', { method: 'POST', headers: { origin, host: 'localhost' }, body: JSON.stringify(input) });
  mock.accept.mockResolvedValue({ accepted: true, reportRevision: 1 });
  expect((await acceptPOST(request('https://evil.example'), context)).status).toBe(403); expect(mock.accept).not.toHaveBeenCalled();
  expect((await acceptPOST(request('http://localhost'), context)).status).toBe(200);
  expect(mock.accept).toHaveBeenCalledWith('trusted-user', 'task-private', input);
});
