'use client';

import { useState } from 'react';
import type { MetricComparison, TurnoverMetric } from '@/lib/quant/market-dashboard-types';
import { formatValue } from './MarketWidgets';
import styles from '../market-layout.module.css';

export function formatMetric(value: number | null | undefined, metric: TurnoverMetric) {
  return value == null ? '—' : `${formatValue(value, 'money')}${metric === 'amount' ? '元' : '手'}`;
}

export function MetricSwitch({ value, onChange, label }: { value: TurnoverMetric; onChange: (value: TurnoverMetric) => void; label: string }) {
  return <div className={styles.tabs} role="group" aria-label={label}>
    {(['amount', 'volume'] as const).map(metric => <button key={metric} aria-pressed={value === metric} onClick={() => onChange(metric)}>{metric === 'amount' ? '成交额' : '成交量'}</button>)}
  </div>;
}

export function ComparisonSummary({ data, metric }: { data?: MetricComparison; metric: TurnoverMetric }) {
  const last = data?.rows.at(-1);
  const previous = data?.rows.findLast(row => row.previous !== null);
  const ma5 = data?.rows.findLast(row => row.ma5 !== null);
  return <div className={styles.cards}>
    <article><p>当前累计{metric === 'amount' ? '成交额' : '成交量'}</p><strong>{formatMetric(last?.current, metric)}</strong><small>{data?.currentDate ?? '日期待确认'} · 截至 {data?.currentCutoff ?? '—'}</small></article>
    {([['昨日', previous, 'previous'], ['MA5', ma5, 'ma5']] as const).map(([label, row, key]) => <article key={key}>
      <p>{label}同时点累计{key === 'ma5' ? '均值' : ''}</p><strong>{formatMetric(row?.[key], metric)}</strong>
      <small>{key === 'previous' ? data?.previousDate ?? '日期待确认' : `前五日 · ${data?.sampleCount ?? 0}/5 日`} · 对比时刻 {row?.time ?? '—'}</small>
      <p className={(row?.[`${key}Difference`] ?? 0) > 0 ? styles.up : (row?.[`${key}Difference`] ?? 0) < 0 ? styles.down : undefined}>
        较{label} {formatMetric(row?.[`${key}Difference`], metric)}（{formatValue(row?.[`${key}ChangePct`], 'pct')}）
      </p>
    </article>)}
  </div>;
}

function position(time: string) {
  const [h, m] = time.split(':').map(Number), minute = h * 60 + m;
  return minute <= 690 ? minute - 570 : minute - 660;
}
const x = (time: string) => 80 + position(time) / 240 * 660;
const ticks = ['09:30', '10:30', '11:30', '14:00', '15:00'];
const axisValue = (value: number) => value >= 1e12 ? `${(value / 1e12).toFixed(1)}万亿` : value >= 1e8 ? `${(value / 1e8).toFixed(1)}亿` : value >= 1e4 ? `${(value / 1e4).toFixed(1)}万` : value.toFixed(0);

export function TurnoverChart({ data, title, metric, busy = false, error = '' }: {
  data?: MetricComparison; title: string; metric: TurnoverMetric; busy?: boolean; error?: string;
}) {
  const [selection, setSelection] = useState<number | null>(null);
  const rows = data?.rows ?? [];
  const reasons = [...new Set([data?.reason, data?.previousStatus.reason, data?.ma5Status.reason].filter(Boolean))];
  if (!rows.length) return <section className={styles.chart} aria-busy={busy}>
    <h3>{title}</h3><p className={styles.empty} role="status">{reasons.join(' ') || (busy ? '正在获取量额数据…' : error ? '暂时无法获取数据，请使用上方重试。' : '暂未取得可连续累计的分钟数据，稍后自动重试。')}</p>
  </section>;
  const index = Math.min(selection ?? rows.length - 1, rows.length - 1), active = rows[index];
  const max = Math.max(1, ...rows.flatMap(row => [row.current, row.previous ?? 0, row.ma5 ?? 0])) * 1.08;
  const y = (value: number) => 225 - value / max * 190;
  const series = [
    ['current', '当日', 'var(--layout-actual)'],
    ['previous', '昨日', 'var(--layout-leading)'],
    ['ma5', '前五日均值', 'var(--layout-ma5)'],
  ] as const;
  const lines = (key: 'current' | 'previous' | 'ma5') => {
    const segments: string[] = []; let points: string[] = [];
    rows.forEach((row, i) => {
      if (row[key] === null || (i && position(row.time) - position(rows[i - 1].time) > 1)) {
        if (points.length) segments.push(points.join(' ')); points = [];
      }
      if (row[key] !== null) points.push(`${x(row.time)},${y(row[key])}`);
    });
    if (points.length) segments.push(points.join(' '));
    return segments;
  };
  return <figure className={styles.chart} aria-busy={busy}>
    <figcaption><strong>{title}</strong><span>{data?.currentDate} · 单位：{data?.unit}</span></figcaption>
    <div className={styles.legend}>{series.map(([key, label, color]) => <span key={key} style={{ color }}>● {label}</span>)}<span>相同时点累计值</span></div>
    <svg className={styles.turnoverPlot} viewBox="0 0 800 270" role="img" aria-label={`${title}，当日、昨日与MA5，${rows.length}个分钟节点`} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect(), target = (event.clientX - rect.left) / rect.width * 800;
      setSelection(rows.reduce((best, row, i) => Math.abs(x(row.time) - target) < Math.abs(x(rows[best].time) - target) ? i : best, 0));
    }}>
      {[0, .25, .5, .75, 1].map(ratio => <g key={ratio}><line x1="80" x2="740" y1={y(max * ratio)} y2={y(max * ratio)} stroke="currentColor" opacity=".15" /><text x="72" y={y(max * ratio) + 4} textAnchor="end" fontSize="11" fill="currentColor">{axisValue(max * ratio)}</text></g>)}
      {ticks.map(time => <text key={time} x={x(time)} y="250" textAnchor="middle" fontSize="11" fill="currentColor">{time}</text>)}
      {series.map(([key, , color]) => <g key={key}>{lines(key).map((line, i) => <polyline key={i} points={line} fill="none" stroke={color} strokeWidth="2.3" strokeDasharray={key === 'ma5' ? '5 3' : undefined} />)}{active[key] !== null && <circle cx={x(active.time)} cy={y(active[key])} r="3" fill={color} />}</g>)}
      <line x1={x(active.time)} x2={x(active.time)} y1="30" y2="225" stroke="currentColor" strokeDasharray="3 4" opacity=".4" />
    </svg>
    <p className={styles.tooltip}>{active.time} · 当日 {formatMetric(active.current, metric)} · 昨日 {formatMetric(active.previous, metric)} · MA5 {formatMetric(active.ma5, metric)}</p>
    <p className={styles.tooltip}>较昨日 {formatMetric(active.previousDifference, metric)}（{formatValue(active.previousChangePct, 'pct')}） · 较 MA5 {formatMetric(active.ma5Difference, metric)}（{formatValue(active.ma5ChangePct, 'pct')}）</p>
    <input type="range" min="0" max={rows.length - 1} value={index} aria-label={`${title}查看时刻`} onChange={event => setSelection(Number(event.target.value))} />
    <p className={styles.note}>昨日：{data?.previousDate ?? '待确认'}；MA5 基准日：{data?.sampleDates.join('、') || '待积累'}（不含当日）。</p>
    {data?.retained && <p className={styles.note} role="status">部分分钟沿用上次有效记录{data.fetchedAt ? `（获取于 ${new Date(data.fetchedAt).toLocaleString('zh-CN', { hour12: false })}）` : ''}，恢复后自动更新。</p>}
    {reasons.map(reason => <p key={reason} className={styles.note} role="status">{reason}</p>)}
  </figure>;
}
