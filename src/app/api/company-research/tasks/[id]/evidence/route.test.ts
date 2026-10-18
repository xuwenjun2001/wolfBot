import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '@/lib/auth/authorization';
import { ResearchPersistenceError } from '@/lib/company-research/repository-errors';

const mocked = vi.hoisted(() => ({ action: vi.fn(), reader: vi.fn(), search: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocked.action }));
vi.mock('@/lib/company-research/evidence-retrieval', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/company-research/evidence-retrieval')>(),
  researchEvidenceReader: mocked.reader,
}));
import { POST } from './route';

const params = { params: Promise.resolve({ id: 'owned-task' }) };
function request(body: unknown, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/api/company-research/tasks/owned-task/evidence', {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
describe('private research evidence HTTP boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocked.action.mockResolvedValue({ actorUserId: 'authenticated-user' });
    mocked.reader.mockReturnValue({ search: mocked.search, read: mocked.read });
    mocked.search.mockResolvedValue({ hits: [] }); mocked.read.mockResolvedValue({ text: '原文', nextOffset: null });
  });
  it('derives actor/task server-side and prevents shared caching for both operations', async () => {
    const search = await POST(request({ operation: 'search', input: { query: '现金流', fields: ['cash_flow'] } }), params);
    expect(search.status).toBe(200); expect(await search.json()).toEqual({ hits: [] });
    expect(mocked.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'research.report.read' }));
    expect(mocked.reader).toHaveBeenCalledWith('authenticated-user', 'owned-task');
    expect(mocked.search).toHaveBeenCalledWith(expect.objectContaining({ fields: ['cash_flow'] }));
    const read = await POST(request({ operation: 'read', input: { documentId: 'annual', documentVersion: 1, locator: { kind: 'page', filePage: 5 } } }), params);
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ text: '原文' });
    for (const response of [search, read]) expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('denies cross-origin and forbidden requests before constructing an evidence reader', async () => {
    expect((await POST(request({ operation: 'search', input: { query: '风险' } }, 'https://other.example'), params)).status).toBe(403);
    expect(mocked.reader).not.toHaveBeenCalled();
    mocked.action.mockRejectedValue(new AuthorizationError('FORBIDDEN', 403, '无权限'));
    expect((await POST(request({ operation: 'search', input: { query: '风险' } }), params)).status).toBe(403);
    expect(mocked.reader).not.toHaveBeenCalled();
  });
  it('rejects scope injection and oversized or malformed input before accessing evidence', async () => {
    for (const input of [{ query: '风险', actor: 'victim' }, { query: '风险', asOf: '2030-01-01' }, { query: '风险', topK: 21 }]) {
      expect((await POST(request({ operation: 'search', input }), params)).status).toBe(400);
    }
    expect((await POST(request({ operation: 'search', input: { query: 'x'.repeat(9000) } }), params)).status).toBe(413);
    expect((await POST(new Request('http://localhost:3000/evidence', { method: 'POST', body: '{' }), params)).status).toBe(400);
    expect(mocked.reader).not.toHaveBeenCalled();
  });
  it('returns 404 for an inaccessible task without exposing evidence', async () => {
    mocked.search.mockRejectedValue(new ResearchPersistenceError('NOT_FOUND'));
    const response = await POST(request({ operation: 'search', input: { query: '现金流' } }), params);
    expect(response.status).toBe(404); expect(await response.text()).not.toContain('原文');
  });
});
