'use client';

import { useState } from 'react';
import type { TurnoverMetric } from '@/lib/quant/market-dashboard-types';
import { useDashboard } from '../useDashboard';
import { DataStatus } from './MarketWidgets';
import { IndexChart } from './MarketLayoutCharts';
import { ComparisonSummary, MetricSwitch, TurnoverChart } from './TurnoverChart';
import styles from '../market-layout.module.css';

const indices = [['sh', '上证指数'], ['sz', '深证成指'], ['cy', '创业板指'], ['kc', '科创50']] as const;

function Breadth({ index, refreshKey }: { index: string; refreshKey: number }) {
  const state = useDashboard('index-breadth', { index }, refreshKey);
  const row = state.data?.rows[0], valid = row ? Number(row.up) + Number(row.down) + Number(row.flat) : 0;
  return <section className={styles.breadth} aria-label="个股涨跌情况"><h3>个股涨跌情况</h3><DataStatus {...state} />
    {state.data?.refreshing && <p className={styles.note}>正在后台统计，完成后自动更新。</p>}
    {row && <><p className={styles.note}>{row.name} · 有效报价 {valid} 家</p><dl>{[['up', '上涨'], ['down', '下跌'], ['flat', '平盘'], ['missing', '无有效报价']].map(([key, label]) => <div key={key}><dt>{label}</dt><dd className={key === 'up' ? styles.up : key === 'down' ? styles.down : undefined}>{row[key]} 家</dd></div>)}</dl>
      <div className={styles.breadthBar} aria-label="涨跌家数比例">{[['up', '#ca4b3c'], ['flat', '#a5abb4'], ['down', '#20816b']].map(([key, color]) => <span key={key} style={{ width: `${valid ? Number(row[key]) / valid * 100 : 0}%`, background: color }} />)}</div>
      <p className={styles.note}>上涨 {valid ? (Number(row.up) / valid * 100).toFixed(1) : '—'}% / 下跌 {valid ? (Number(row.down) / valid * 100).toFixed(1) : '—'}%</p></>}
    <p className={styles.note}>按对应市场范围统计，非指数成分股。无报价不等于停牌。</p>
  </section>;
}

function SelectedIndex({ index, refreshKey }: { index: string; refreshKey: number }) {
  const state = useDashboard('index-session', { index }, refreshKey);
  const [metric, setMetric] = useState<TurnoverMetric>('amount');
  const name = indices.find(([key]) => key === index)![1];
  return <><DataStatus {...state} /><IndexChart rows={state.data?.rows ?? []} title={`${name}分时走势`} previousClose={state.data?.previousClose} />
    <p className={styles.note}>{state.data?.note}</p>
    <div className={styles.lower}><section>
      <MetricSwitch value={metric} onChange={setMetric} label={`${name}对比指标`} />
      <TurnoverChart data={state.data?.metrics?.[metric]} title={`${name}${metric === 'amount' ? '成交额' : '成交量'}对比`} metric={metric} busy={state.busy} error={state.error || (state.data?.status === 'unavailable' ? '数据暂不可用' : '')} />
    </section><Breadth index={index} refreshKey={refreshKey} /></div></>;
}

export function MarketLayout({ refreshKey }: { refreshKey: number }) {
  const [index, setIndex] = useState('sh');
  const [metric, setMetric] = useState<TurnoverMetric>('amount');
  const turnover = useDashboard('market-turnover', {}, refreshKey);
  const comparison = turnover.data?.metrics?.[metric];
  return <section className={styles.root} aria-label="市场成交额与四大指数">
    <header className={styles.header}><div><span className={styles.eyebrow}>MARKET OVERVIEW</span><h2>市场量额与四大指数</h2><p>观察指数分时，以及较昨日、前五个交易日同时点均值的量能变化。</p></div><span className={styles.date}>{comparison?.currentDate || '日期待确认'} {comparison?.currentCutoff || ''}</span></header>
    <MetricSwitch value={metric} onChange={setMetric} label="沪深合计对比指标" />
    <ComparisonSummary data={comparison} metric={metric} />
    <DataStatus {...turnover} />
    <div className={styles.indexShell}><div role="tablist" aria-label="四大指数" className={styles.tabs}>{indices.map(([key, label]) => <button key={key} role="tab" id={`index-${key}`} aria-selected={index === key} aria-controls="selected-index-panel" onClick={() => setIndex(key)}>{label}</button>)}</div>
      <div id="selected-index-panel" role="tabpanel" aria-labelledby={`index-${index}`}><SelectedIndex key={index} index={index} refreshKey={refreshKey} /></div>
    </div>
    <TurnoverChart data={comparison} title={`沪深合计${metric === 'amount' ? '成交额' : '成交量'}对比`} metric={metric} busy={turnover.busy} error={turnover.error || (turnover.data?.status === 'unavailable' ? '数据暂不可用' : '')} />
  </section>;
}
