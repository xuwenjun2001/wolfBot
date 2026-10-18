'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DashboardData, DashboardRow } from '@/lib/quant/market-dashboard-types';
import styles from '../market-dashboard.module.css';

export type Column = { key: string; label: string; format?: 'money' | 'pct' | 'number' | 'time'; signed?: boolean };
export function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
export function formatValue(value: unknown, format?: Column['format']) {
  if (value === null || value === undefined || value === '') return '—';
  if (!format) return String(value);
  if (format === 'time') { const t = String(value).padStart(6, '0'); return t === '000000' ? '—' : `${t.slice(0, 2)}:${t.slice(2, 4)}`; }
  const n = numeric(value); if (n === null) return '—';
  if (format === 'money') return Math.abs(n) >= 1e8 ? `${(n / 1e8).toFixed(2)}亿` : Math.abs(n) >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : n.toFixed(0);
  if (format === 'pct') return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}

function RetryAction({ reload, busy, retryAt }: { reload: () => void; busy: boolean; retryAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return <button className={styles.refresh} disabled={busy || seconds > 0} onClick={reload}>{busy ? '更新中…' : seconds ? `重试（${seconds}秒）` : '重试'}</button>;
}

export function DataStatus({ data, busy, error, reload, retryAt = 0 }: { data: DashboardData | null; busy: boolean; error: string; reload?: () => void; retryAt?: number }) {
  const action = reload && <RetryAction reload={reload} busy={busy} retryAt={retryAt} />;
  if (error) return <div className={styles.warning} role="alert">{error}{data ? ` · 下方保留 ${data.tradeDate ?? ''} 获取于 ${new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })} 的数据。` : ''}{action}</div>;
  if (!data) return <div className={styles.status} role="status">{busy ? '正在获取行情…' : '等待行情数据'}{!busy && action}</div>;
  return <div className={data.status === 'unavailable' || data.status === 'stale' ? styles.warning : styles.status} role="status">
    <span>{data.source || '行情数据源'} · 数据日期 <b>{data.tradeDate || '源未提供'}</b></span>
    <span>{data.dateStatus === 'historical' ? '历史 / 最近交易日数据' : data.dateStatus === 'unknown' ? '时效待确认' : '当日数据'}</span>
    <span>获取于 {new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}{data.cacheHit ? ' · 缓存' : ''}{busy ? ' · 更新中' : ''}</span>
    {data.status === 'partial' && <span>部分数据可用，缺失原因见对应模块</span>}
    {data.status === 'pending' && <span>后台统计中</span>}
    {data.status === 'empty' && <span>该查询暂无记录</span>}
    {data.fallbackReason && <strong>{data.fallbackReason}</strong>}
    {data.status === 'stale' && <span>保留上次有效数据，稍后自动检查更新。</span>}
    {(data.status === 'unavailable' || data.status === 'stale' || data.status === 'partial') && action}
  </div>;
}

export function MarketTable({ rows, columns, onSelect, search = '', selectedCode, emptyMessage }: {
  rows: DashboardRow[]; columns: Column[]; onSelect?: (row: DashboardRow) => void; search?: string; selectedCode?: string; emptyMessage?: string;
}) {
  const [sort, setSort] = useState<{ key: string; asc: boolean } | null>(null);
  const visible = useMemo(() => {
    const filtered = rows.filter(row => !search || Object.values(row).some(value => String(value ?? '').toLowerCase().includes(search.toLowerCase())));
    if (sort) filtered.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      const an = numeric(av), bn = numeric(bv);
      const order = an !== null && bn !== null ? an - bn : String(av ?? '').localeCompare(String(bv ?? ''), 'zh-CN');
      return sort.asc ? order : -order;
    });
    return filtered;
  }, [rows, sort, search]);
  return <div className={styles.tableWrap}><table className={styles.table}>
    <thead><tr>{columns.map(col => <th key={col.key} aria-sort={sort?.key === col.key ? sort.asc ? 'ascending' : 'descending' : 'none'}>
      <button onClick={() => setSort({ key: col.key, asc: sort?.key === col.key ? !sort.asc : false })}>{col.label}{sort?.key === col.key ? sort.asc ? ' ↑' : ' ↓' : ''}</button>
    </th>)}</tr></thead>
    <tbody>{visible.map((row, index) => <tr key={`${row.code ?? row.name ?? ''}-${index}`} className={selectedCode && row.code === selectedCode ? styles.selected : undefined}>
      {columns.map((col, i) => <td key={col.key} style={{ whiteSpace: col.format || i === 0 || col.key === 'code' ? 'nowrap' : undefined }} className={col.signed && numeric(row[col.key]) !== null ? Number(row[col.key]) > 0 ? styles.up : Number(row[col.key]) < 0 ? styles.down : undefined : undefined}>
        {i === 0 && onSelect ? <button className={styles.rowButton} onClick={() => onSelect(row)}>{formatValue(row[col.key], col.format)}</button> : formatValue(row[col.key], col.format)}
      </td>)}
    </tr>)}</tbody>
  </table>{!visible.length && <p className={styles.empty}>{rows.length && search ? '当前筛选无匹配记录，可调整或清空筛选条件。' : emptyMessage || '该查询暂无记录。'}</p>}</div>;
}

export function TrendChart({ rows, field, title, money = false, emptyMessage }: { rows: DashboardRow[]; field: string; title: string; money?: boolean; emptyMessage?: string }) {
  const points = rows.flatMap(row => numeric(row[field]) === null ? [] : [{ time: String(row.time), value: Number(row[field]) }]);
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <p className={styles.empty}>{emptyMessage || '暂无可绘制的走势数据。'}</p>;
  const values = points.map(p => p.value), min = Math.min(...values), max = Math.max(...values);
  const span = max - min || Math.max(1, Math.abs(max) * .02);
  const y = (v: number) => 170 - ((v - min) / span) * 140;
  const x = (i: number) => 55 + i / Math.max(1, points.length - 1) * 660;
  const active = points[Math.min(hover ?? points.length - 1, points.length - 1)];
  return <figure className={styles.chart}>
    <figcaption><strong>{title}</strong><span>{active.time} · {formatValue(active.value, money ? 'money' : 'number')}</span></figcaption>
    <svg viewBox="0 0 750 215" role="img" aria-label={`${title}，${points.length}个数据点`} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setHover(Math.max(0, Math.min(points.length - 1, Math.round(((event.clientX - rect.left) / rect.width * 750 - 55) / 660 * (points.length - 1)))));
    }} onPointerLeave={() => setHover(null)}>
      {[min, min + span / 2, min + span].map((value, i) => <g key={i}><line x1="55" x2="715" y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".12" /><text x="49" y={y(value) + 4} textAnchor="end" fill="currentColor" fontSize="10">{formatValue(value, money ? 'money' : 'number')}</text></g>)}
      <polyline points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} fill="none" stroke="var(--md-accent)" strokeWidth="2.3" />
      <circle cx={x(Math.min(hover ?? points.length - 1, points.length - 1))} cy={y(active.value)} r="4" fill="var(--md-accent)" />
      {[0, Math.floor((points.length - 1) / 2), points.length - 1].map((i, n) => <text key={n} x={x(i)} y="199" textAnchor={n === 0 ? 'start' : n === 2 ? 'end' : 'middle'} fill="currentColor" fontSize="11">{points[i].time}</text>)}
    </svg>
  </figure>;
}
