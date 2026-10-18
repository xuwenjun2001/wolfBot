import { describe, expect, it } from 'vitest';
import type { DashboardData } from '@/lib/quant/market-dashboard-types';
import { dashboardEmptyMessage, retainDashboardData } from './dashboard-display';

const original: DashboardData = {
  resource: 'overview', rows: [{ name: '上证', price: 100 }], status: 'available', source: '腾讯财经',
  tradeDate: '2026-09-08', fetchedAt: '2026-09-08T02:00:00Z', stale: false,
  cacheHit: false, dateStatus: 'current', fallbackReason: null, note: '',
};

describe('dashboard refresh and empty states', () => {
  it('retains content and its original timestamp after a business-level failure', () => {
    const failed: DashboardData = { ...original, rows: [], status: 'unavailable', fetchedAt: '2026-09-08T03:00:00Z', fallbackReason: '源暂不可用' };
    const result = retainDashboardData(original, failed);
    expect(result.rows).toEqual(original.rows);
    expect(result.fetchedAt).toBe(original.fetchedAt);
    expect(result.status).toBe('stale');
    expect(result.fallbackReason).toBe('源暂不可用');
    expect(original.status).toBe('available');
    expect(retainDashboardData(null, failed)).toEqual(failed);
  });
  it('allows a successful empty response to replace older records', () => {
    const empty: DashboardData = { ...original, rows: [], status: 'empty' };
    expect(retainDashboardData(original, empty)).toBe(empty);
  });
  it('distinguishes loading, pending, unavailable and a confirmed empty result', () => {
    expect(dashboardEmptyMessage(null, true, '')).toContain('正在获取');
    expect(dashboardEmptyMessage({ ...original, status: 'pending' }, false, '')).toContain('后台');
    expect(dashboardEmptyMessage({ ...original, status: 'unavailable' }, false, '')).toContain('重试');
    expect(dashboardEmptyMessage({ ...original, status: 'empty' }, false, '')).toContain('数据源已响应');
    expect(dashboardEmptyMessage(original, false, 'network failed')).not.toContain('暂无记录');
  });
});
