import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '@/lib/auth/authorization';
const mocks = vi.hoisted(() => ({ requireAction: vi.fn(), getMarketDashboard: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/quant/market-dashboard', () => ({ getMarketDashboard: mocks.getMarketDashboard }));
import { GET } from './route';

function get(resource: string, query = '') {
  return GET(new NextRequest(`http://localhost/api/quant/market-dashboard/${resource}?${query}`), { params: Promise.resolve({ resource }) });
}
describe('integrated dashboard API', () => {
  beforeEach(() => { mocks.requireAction.mockReset().mockResolvedValue({}); mocks.getMarketDashboard.mockReset().mockResolvedValue({ rows: [] }); });
  it('requires data permission before querying the backend', async () => {
    mocks.requireAction.mockRejectedValue(new AuthorizationError('CAPABILITY_DENIED', 403, '无权读取行情'));
    expect((await get('overview')).status).toBe(403);
    expect(mocks.getMarketDashboard).not.toHaveBeenCalled();
  });
  it.each([['overview', 'url=http://localhost'], ['themes', 'page=11'], ['themes', 'page=1&page=2'], ['institutions', 'refresh=1'], ['sector-history', 'code=../../file'], ['limits', 'date=2026-02-30'], ['minute', 'code=832982']])('rejects invalid %s queries', async (resource, query) => {
    expect((await get(resource, query)).status).toBe(400);
    expect(mocks.getMarketDashboard).not.toHaveBeenCalled();
  });
  it('rejects a future business date before contacting the backend', async () => {
    expect((await get('limits', 'date=2099-01-01')).status).toBe(400);
    expect(mocks.getMarketDashboard).not.toHaveBeenCalled();
  });
  it('only routes known resources', async () => { expect((await get('admin')).status).toBe(404); });
  it.each([['index-session', 'index=sh'], ['index-breadth', 'index=cy'], ['index-session', 'index=kc'], ['market-turnover', '']])('authorizes and routes %s', async (resource, query) => {
    const response = await get(resource, query);
    expect(response.status).toBe(200);
    expect(mocks.requireAction).toHaveBeenCalled();
    expect(mocks.getMarketDashboard).toHaveBeenCalledWith(resource, Object.fromEntries(new URLSearchParams(query)));
  });
  it.each([['index-session', ''], ['index-session', 'index=000001'], ['index-breadth', 'index=sh&index=sz'], ['market-turnover', 'index=cy']])('rejects invalid layout %s', async (resource, query) => {
    expect((await get(resource, query)).status).toBe(400);
    expect(mocks.getMarketDashboard).not.toHaveBeenCalled();
  });
  it('normalizes defaults and prevents caching authenticated responses publicly', async () => {
    const response = await get('sectors');
    expect(response.status).toBe(200);
    expect(mocks.requireAction).toHaveBeenCalledWith({ headers: expect.any(Headers), action: 'quant.data.read' });
    expect(mocks.getMarketDashboard).toHaveBeenCalledWith('sectors', { kind: 'industry', page: '1' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('does not expose backend URLs or credential details on failure', async () => {
    mocks.getMarketDashboard.mockRejectedValue(new Error('secret token private host'));
    const response = await get('overview');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
  });
});
