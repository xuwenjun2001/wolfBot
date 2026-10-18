import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AmountChart, IndexChart } from './MarketLayoutCharts';
import { dashboardDataSchema } from '@/lib/quant/market-dashboard-types';

describe('market layout chart contracts', () => {
  it('renders actual and source leading lines plus accessible inspection', () => {
    const html = renderToStaticMarkup(createElement(IndexChart, { title: '上证指数', previousClose: 100, rows: [
      { time: '09:30', price: 101, changePct: 1, leading: 100.5, leadingPct: .5 },
      { time: '09:31', price: 102, changePct: 2, leading: 101, leadingPct: 1 },
    ] }));
    expect(html.match(/<polyline/g)).toHaveLength(2);
    expect(html).toContain('上证指数查看时刻');
    expect(html).toContain('源领先线');
  });
  it('preserves the missing previous-day explanation', () => {
    const html = renderToStaticMarkup(createElement(AmountChart, { title: '成交额对比', data: { rows: [], currentDate: '2026-09-04', previousDate: null, cutoff: null, complete: false, reason: '缺少上一交易日' } }));
    expect(html).toContain('缺少上一交易日');
    expect(html).not.toContain('<rect');
  });
  it('renders increases and decreases with their date pair', () => {
    const html = renderToStaticMarkup(createElement(AmountChart, { title: '成交额对比', data: { rows: [
      { time: '09:30', current: 20, previous: 10, difference: 10, changePct: 100 },
      { time: '09:31', current: 30, previous: 40, difference: -10, changePct: -25 },
    ], currentDate: '2026-09-04', previousDate: '2026-09-03', cutoff: '09:31', complete: true, reason: null } }));
    expect(html).toContain('#ca4b3c'); expect(html).toContain('#20816b');
    expect(html).toContain('2026-09-03'); expect(html).toContain('2026-09-04');
  });
  it('accepts pending breadth independently of chart data', () => {
    const parsed = dashboardDataSchema.parse({ resource: 'index-breadth', rows: [], source: '东方财富', tradeDate: null, fetchedAt: '2026-09-06T10:00:00Z', status: 'pending', stale: true, cacheHit: false, dateStatus: 'unknown', fallbackReason: null, note: '统计中', complete: false, refreshing: true });
    expect(parsed.refreshing).toBe(true); expect(parsed.rows).toEqual([]);
  });
});
