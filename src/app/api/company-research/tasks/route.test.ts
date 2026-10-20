import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { specFixture } from '@/lib/company-research/version-test-fixtures';
import { ResearchPersistenceError } from '@/lib/company-research/repository-errors';
import { AuthorizationError } from '@/lib/auth/authorization';

const mocked = vi.hoisted(() => ({ action: vi.fn(), create: vi.fn(), task: vi.fn(), report: vi.fn(), snapshot: vi.fn(), document: vi.fn(), artifact: vi.fn(), cancel: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocked.action }));
vi.mock('@/lib/company-research/version-store', () => ({ createResearchTask: mocked.create, getResearchTask: mocked.task, getResearchReportRevision: mocked.report }));
vi.mock('@/lib/company-research/report-update-store', () => ({ getResearchReportSnapshot: mocked.snapshot }));
vi.mock('@/lib/company-research/document-store', () => ({ getResearchDocument: mocked.document, readResearchDocumentArtifact: mocked.artifact }));
vi.mock('@/lib/company-research/attempt-store', () => ({ cancelResearchTask: mocked.cancel }));
import { POST as create } from '@/app/api/company-research/tasks/route';
import { GET as resolve } from '@/app/api/company-research/resolve/route';
import { GET as getTask } from '@/app/api/company-research/tasks/[id]/route';
import { GET as getDocument } from '@/app/api/company-research/tasks/[id]/documents/[documentId]/[version]/route';
import { GET as getReport } from '@/app/api/company-research/tasks/[id]/reports/[revision]/route';
import { POST as cancel } from '@/app/api/company-research/tasks/[id]/cancel/route';

const request = (body: unknown, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/company-research/tasks', { method: 'POST', headers: { origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
describe('versioned research HTTP identity boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocked.action.mockResolvedValue({ actorUserId: 'authenticated-user' });
    vi.stubGlobal('fetch', mocked.fetch);
    mocked.fetch.mockImplementation(async () => new Response(JSON.stringify({ results: [{ symbol: '600519', name: '贵州茅台', asset_type: 'stock' }] })));
    mocked.create.mockResolvedValue({ id: randomUUID(), status: 'draft' });
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([['安迪苏', '600299', '安迪苏'], ['601919', '601919', '中远海控']])('resolves %s and confirms its saved identity through the real connector', async (query, code, name) => {
    mocked.fetch.mockImplementation(async (input: string) => {
      const lookup = new URL(input).searchParams.get('query');
      return new Response(JSON.stringify({ results: lookup === query || lookup === code ? [{ symbol: code, name, asset_type: 'stock' }] : [] }));
    });
    const found = await resolve(new Request(`http://localhost:3000/api/company-research/resolve?query=${encodeURIComponent(query)}`));
    expect((await found.json()).companies).toEqual([{ symbol: code, name }]);
    const spec = { ...specFixture(), company: { symbol: `${code}.SH`, name, exchange: 'SH' } };
    expect((await create(request(spec))).status).toBe(201);
    expect(new URL(mocked.fetch.mock.calls[1][0]).searchParams.get('query')).toBe(code);
    expect(mocked.create).toHaveBeenCalledWith('authenticated-user', spec, expect.any(String));
  });
  it.each([{ results: [] }, { results: [{ symbol: '600519.SZ', name: '贵州茅台', asset_type: 'stock' }] }, { results: [{ symbol: '601919', name: '中远海控', asset_type: 'stock' }] }])('rejects absent or mismatched authoritative identities: $results', async ({ results }) => {
    mocked.fetch.mockImplementation(async () => new Response(JSON.stringify({ results })));
    expect((await create(request(specFixture()))).status).toBe(400);
    expect(mocked.create).not.toHaveBeenCalled();
  });
  it('uses trusted identity and creates a draft without dispatching legacy research', async () => {
    const spec = specFixture(), response = await create(request(spec));
    expect(response.status).toBe(201); expect((await response.json()).task.status).toBe('draft');
    expect(mocked.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'research.report.run' }));
    expect(mocked.create).toHaveBeenCalledWith('authenticated-user', spec, expect.any(String));
  });
  it('rejects cross origin requests and denies missing permission before storage', async () => {
    expect((await create(request(specFixture(), 'https://other.example'))).status).toBe(403);
    expect(mocked.create).not.toHaveBeenCalled();
    mocked.action.mockRejectedValue(new AuthorizationError('FORBIDDEN', 403, '无权限'));
    expect((await create(request(specFixture()))).status).toBe(403);
    expect(mocked.create).not.toHaveBeenCalled();
  });
  it('rejects actor injection, fabricated company identity, bad JSON and changed idempotent payloads', async () => {
    expect((await create(request({ ...specFixture(), actorId: 'victim' }))).status).toBe(400);
    expect((await create(request({ ...specFixture(), company: { ...specFixture().company, name: '伪造公司' } }))).status).toBe(400);
    const malformed = new Request('http://localhost:3000/api/company-research/tasks', { method: 'POST', body: '{' });
    expect((await create(malformed)).status).toBe(400);
    mocked.create.mockRejectedValue(new ResearchPersistenceError('IDEMPOTENCY_CONFLICT'));
    expect((await create(request(specFixture()))).status).toBe(409);
  });
  it('does not expose an inaccessible task or report and always derives read scope', async () => {
    mocked.task.mockResolvedValue(null); mocked.snapshot.mockResolvedValue(null);
    const response = await getTask(new Request('http://localhost/tasks/victim'), { params: Promise.resolve({ id: 'victim' }) });
    expect(response.status).toBe(404); expect(mocked.task).toHaveBeenCalledWith('authenticated-user', 'victim');
    expect((await getReport(new Request('http://localhost/reports/2'), { params: Promise.resolve({ id: 'victim', revision: '2' }) })).status).toBe(404);
    expect(mocked.snapshot).toHaveBeenCalledWith('authenticated-user', 'victim', 2);
  });
  it('checks ownership for original bytes and returns private attachments', async () => {
    const params = Promise.resolve({ id: 'task', documentId: 'annual', version: '1' });
    mocked.artifact.mockRejectedValue(new ResearchPersistenceError('NOT_FOUND'));
    expect((await getDocument(new Request('http://localhost/document?content=original'), { params })).status).toBe(404);
    expect(mocked.artifact).toHaveBeenCalledWith('authenticated-user', 'task', 'annual', 1, 'original');
    mocked.artifact.mockResolvedValue({ document: { mediaType: 'application/pdf' }, bytes: Buffer.from('%PDF-test') });
    const response = await getDocument(new Request('http://localhost/document?content=original'), { params });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Disposition')).toContain('attachment'); expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await response.text()).toBe('%PDF-test');
  });
  it('scopes cancellation to authenticated actor and maps a missing owned task to 404', async () => {
    mocked.cancel.mockRejectedValue(new ResearchPersistenceError('NOT_FOUND'));
    const response = await cancel(new Request('http://localhost/cancel', { method: 'POST' }), { params: Promise.resolve({ id: 'victim' }) });
    expect(response.status).toBe(404); expect(mocked.cancel).toHaveBeenCalledWith('authenticated-user', 'victim');
  });
});
