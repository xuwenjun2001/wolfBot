import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MetricComparison } from '@/lib/quant/market-dashboard-types';
import { ComparisonSummary, MetricSwitch, TurnoverChart } from './TurnoverChart';
import { DataStatus, MarketTable } from './MarketWidgets';

const metric: MetricComparison = {
  currentDate: '2026-09-08', currentCutoff: '09:31', unit: '元', previousDate: '2026-09-07',
  sampleDates: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07'],
  sampleCount: 5, reason: null,
  previousStatus: { cutoff: '09:31', complete: true, reason: null, reasonCode: null },
  ma5Status: { cutoff: '09:31', complete: true, reason: null, reasonCode: null },
  rows: [
    { time: '09:30', current: 10, previous: 5, ma5: 4, previousDifference: 5, previousChangePct: 100, ma5Difference: 6, ma5ChangePct: 150 },
    { time: '09:31', current: 20, previous: 10, ma5: 8, previousDifference: 10, previousChangePct: 100, ma5Difference: 12, ma5ChangePct: 150 },
  ],
};

describe('yesterday and MA5 comparison presentation', () => {
  it('draws three cumulative series and exposes dates, units and keyboard inspection', () => {
    const html = renderToStaticMarkup(createElement(TurnoverChart, { title: '沪深合计成交额对比', metric: 'amount', data: metric }));
    expect(html.match(/<polyline/g)).toHaveLength(3);
    expect(html).toContain('沪深合计成交额对比查看时刻');
    expect(html).toContain('不含当日');
    expect(html).toContain('2026-09-01');
    expect(html).toContain('较 MA5');
  });
  it('draws the current series while unavailable baselines stay empty', () => {
    const data: MetricComparison = { ...metric, sampleCount: 0, previousDate: null,
      rows: metric.rows.map(row => ({ ...row, previous: null, ma5: null, previousDifference: null, previousChangePct: null, ma5Difference: null, ma5ChangePct: null })),
      ma5Status: { cutoff: null, complete: false, reason: '历史数据积累中，当前时点已具备 0/5 日。', reasonCode: 'history_incomplete' },
    };
    const html = renderToStaticMarkup(createElement(TurnoverChart, { title: '成交量', metric: 'volume', data: { ...data, unit: '手' } }));
    expect(html.match(/<polyline/g)).toHaveLength(1);
    expect(html).toContain('0/5');
    expect(html).toContain('20手');
    expect(html).not.toContain('NaN');
  });
  it('labels older comparison cutoffs rather than calling them current', () => {
    const data = { ...metric, rows: [metric.rows[0], { ...metric.rows[1], previous: null, previousDifference: null, previousChangePct: null }] };
    const html = renderToStaticMarkup(createElement(ComparisonSummary, { data, metric: 'amount' }));
    expect(html).toContain('截至 09:31');
    expect(html).toContain('对比时刻 09:30');
  });
  it('offers a distinct volume selection and correct pressed state', () => {
    const html = renderToStaticMarkup(createElement(MetricSwitch, { value: 'volume', onChange: () => {}, label: '指标' }));
    expect(html).toContain('aria-pressed="true">成交量');
  });
  it('keeps source errors separate from empty filter results and exposes retry', () => {
    const html = renderToStaticMarkup(createElement(DataStatus, { data: null, error: '网络失败', busy: false, reload: () => {} }));
    expect(html).toContain('重试');
    expect(html).toContain('role="alert"');
    const filtered = renderToStaticMarkup(createElement(MarketTable, { rows: [{ name: '上证' }], columns: [{ key: 'name', label: '名称' }], search: '不存在', emptyMessage: '接口失败' }));
    expect(filtered).toContain('筛选无匹配');
    expect(filtered).not.toContain('接口失败');
    const unavailable = renderToStaticMarkup(createElement(MarketTable, { rows: [], columns: [], emptyMessage: '接口失败，请重试' }));
    expect(unavailable).toContain('接口失败，请重试');
    expect(unavailable).not.toContain('暂无记录');
  });
});
