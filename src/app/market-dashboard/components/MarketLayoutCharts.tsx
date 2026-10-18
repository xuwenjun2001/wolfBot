'use client';

import { useState } from 'react';
import type { AmountComparison, DashboardRow } from '@/lib/quant/market-dashboard-types';
import { formatValue, numeric } from './MarketWidgets';
import styles from '../market-layout.module.css';

function position(time: string) {
  const [hour, minute] = time.split(':').map(Number);
  const clock = hour * 60 + minute;
  return Math.max(0, Math.min(240, clock <= 690 ? clock - 570 : clock - 660));
}
const ticks = ['09:30', '10:30', '11:30', '14:00', '15:00'];
const x = (time: string) => 70 + position(time) / 240 * 680;

function Axis({ bound, percent = false }: { bound: number; percent?: boolean }) {
  return <>{[-1, -.5, 0, .5, 1].map(ratio => <g key={ratio}>
    <line x1="70" x2="750" y1={130 - ratio * 95} y2={130 - ratio * 95} stroke="currentColor" opacity={ratio === 0 ? .4 : .12} />
    <text x="62" y={134 - ratio * 95} textAnchor="end" fontSize="11" fill="currentColor">{formatValue(ratio * bound, percent ? 'pct' : 'money')}</text>
  </g>)}{ticks.map(time => <text key={time} x={x(time)} y="250" textAnchor={time === '09:30' ? 'start' : time === '15:00' ? 'end' : 'middle'} fontSize="11" fill="currentColor">{time}</text>)}</>;
}

function nearest(rows: { time: string }[], clientX: number, rect: DOMRect) {
  const target = (clientX - rect.left) / rect.width * 800;
  return rows.reduce((best, row, i) => Math.abs(x(row.time) - target) < Math.abs(x(rows[best].time) - target) ? i : best, 0);
}

export function IndexChart({ rows, title, previousClose }: { rows: DashboardRow[]; title: string; previousClose?: number | null }) {
  const points: (DashboardRow & { time: string })[] = rows.filter(row => numeric(row.changePct) !== null).map(row => ({ ...row, time: String(row.time) }));
  const [selection, setSelection] = useState<number | null>(null);
  if (!points.length) return <p className={styles.empty}>暂无可绘制的指数走势，或源未提供有效昨收。</p>;
  const index = Math.min(selection ?? points.length - 1, points.length - 1), active = points[index];
  const bound = Math.max(.15, ...points.flatMap(p => [Math.abs(Number(p.changePct)), Math.abs(numeric(p.leadingPct) ?? 0)])) * 1.12;
  const y = (value: number) => 130 - value / bound * 95;
  const lines = (field: string) => {
    const segments: string[] = []; let segment: string[] = [];
    points.forEach((row, i) => {
      const value = numeric(row[field]);
      if (value === null || (i > 0 && position(row.time) - position(points[i - 1].time) > 1)) {
        if (segment.length) segments.push(segment.join(' ')); segment = [];
      }
      if (value !== null) segment.push(`${x(row.time)},${y(value)}`);
    });
    if (segment.length) segments.push(segment.join(' '));
    return segments;
  };
  return <figure className={styles.chart}>
    <figcaption><strong>{title}</strong><span>昨收 {formatValue(previousClose, 'number')}</span></figcaption>
    <div className={styles.legend}><span>● 实际指数</span><span className={styles.leading}>● 源领先线</span><span>以昨收为基准</span></div>
    <svg viewBox="0 0 800 265" role="img" aria-label={`${title}，实际指数与源领先线，${points.length}个分钟节点`} onPointerMove={e => setSelection(nearest(points, e.clientX, e.currentTarget.getBoundingClientRect()))} onPointerDown={e => setSelection(nearest(points, e.clientX, e.currentTarget.getBoundingClientRect()))}>
      <Axis bound={bound} percent />
      {lines('leadingPct').map((line, i) => <polyline key={`leading-${i}`} points={line} fill="none" stroke="var(--layout-leading)" strokeWidth="2" />)}
      {lines('changePct').map((line, i) => <polyline key={`actual-${i}`} points={line} fill="none" stroke="var(--layout-actual)" strokeWidth="2" />)}
      <line x1={x(active.time)} x2={x(active.time)} y1="30" y2="230" stroke="currentColor" strokeDasharray="3 4" opacity=".45" />
      <circle cx={x(active.time)} cy={y(Number(active.changePct))} r="4" fill="var(--layout-actual)" />
    </svg>
    <p className={styles.tooltip}>{active.time} · 实际 {formatValue(active.price, 'number')}（{formatValue(active.changePct, 'pct')}） · 源领先线 {formatValue(active.leading, 'number')}（{formatValue(active.leadingPct, 'pct')}）</p>
    <input type="range" min="0" max={points.length - 1} value={index} aria-label={`${title}查看时刻`} onChange={e => setSelection(Number(e.target.value))} />
  </figure>;
}

export function AmountChart({ data, title }: { data?: AmountComparison; title: string }) {
  const [selection, setSelection] = useState<number | null>(null);
  const rows = data?.rows ?? [];
  if (!rows.length) return <section className={styles.chart}><h3>{title}</h3><p className={styles.empty}>{data?.reason || '暂无可对齐的两日成交额数据。'}</p></section>;
  const index = Math.min(selection ?? rows.length - 1, rows.length - 1), active = rows[index];
  const bound = Math.max(1, ...rows.map(row => Math.abs(row.difference))) * 1.1;
  return <figure className={styles.chart}>
    <figcaption><strong>{title}</strong><span>{data?.currentDate} 对比 {data?.previousDate}</span></figcaption>
    <div className={styles.legend}><span className={styles.up}>● 增加</span><span className={styles.down}>● 减少</span><span>累计成交额较上日同时点变化</span></div>
    <svg viewBox="0 0 800 265" role="img" aria-label={`${title}，${rows.length}个分钟节点`} onPointerMove={e => setSelection(nearest(rows, e.clientX, e.currentTarget.getBoundingClientRect()))} onPointerDown={e => setSelection(nearest(rows, e.clientX, e.currentTarget.getBoundingClientRect()))}>
      <Axis bound={bound} />
      {rows.map(row => { const height = Math.abs(row.difference) / bound * 95; return <rect key={row.time} x={x(row.time) - 1} y={row.difference >= 0 ? 130 - height : 130} width="2.1" height={Math.max(.4, height)} fill={row.difference >= 0 ? '#ca4b3c' : '#20816b'} />; })}
      <line x1={x(active.time)} x2={x(active.time)} y1="30" y2="230" stroke="currentColor" strokeDasharray="3 4" opacity=".5" />
    </svg>
    <p className={styles.tooltip}>{active.time} · 当日 {formatValue(active.current, 'money')} · 上日 {formatValue(active.previous, 'money')} · 差额 {formatValue(active.difference, 'money')}（{formatValue(active.changePct, 'pct')}）</p>
    <input type="range" min="0" max={rows.length - 1} value={index} aria-label={`${title}查看时刻`} onChange={e => setSelection(Number(e.target.value))} />
    {data?.reason && <p className={styles.note}>{data.reason}</p>}
  </figure>;
}
