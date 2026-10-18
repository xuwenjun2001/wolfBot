/** Self-contained client module installed into generated Next workspaces. */
export const chartPanelClientSource = String.raw`'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';

export type RecordValue = Record<string, unknown>;
type Point = {
  time: string; price: number | null; open: number | null; high: number | null; low: number | null;
  changePct: number | null; volume: number | null; minuteAmount: number | null; amount: number | null;
  previous: number | null; difference: number | null; changeAmountPct: number | null;
  averages: Array<number | null>; provisional: boolean;
};
export type Session = { symbol: string; secid: string; name: string; source: string; fetchedAt: string;
  tradeDate: string | null; previousDate: string | null; volumeUnit: string; reason: string | null;
  status: string; cacheHit: boolean; rows: Array<RecordValue> };

function record(value: unknown): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}; }
function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function positive(value: unknown) { const n = numeric(value); return n !== null && n >= 0 ? n : null; }
function format(value: number | null, kind = ''): string {
  if (value === null) return '—';
  if (kind === 'pct') return (value > 0 ? '+' : '') + value.toFixed(2) + '%';
  if (kind === 'amount') return Math.abs(value) >= 1e8 ? (value / 1e8).toFixed(2) + '亿' : Math.abs(value) >= 1e4 ? (value / 1e4).toFixed(2) + '万' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}
function clockPosition(time: string): number {
  const [h, m] = time.split(':').map(Number); const clock = h * 60 + m;
  return clock <= 690 ? clock - 570 : clock - 660;
}
function shanghaiToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function shanghaiClock() { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }

const defaultAverages = [5, 10, 20, 60];
const averageColor = (n: number) => ({5:"#d29425",10:"#387fce",20:"#b16ac5",55:"#f59e0b",60:"#508a78",233:"#e44e8d"}[n] ?? "#64748b");
export type ChartPayload = { bars?: RecordValue[]; session?: Session | null; source?: string; fetchedAt?: string; metadata?: RecordValue; tradeDate?: string | null; cacheKind?: string };
export type ChartLoader = (mode: "daily" | "session", refresh: boolean, signal: AbortSignal) => Promise<ChartPayload>;

export function dailyPoints(bars: RecordValue[], averagePeriods = defaultAverages): Point[] {
  const sorted = [...bars].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const byDate = new Map(sorted.map(bar => [String(bar.date), bar]));
  return sorted.map((bar, i) => {
    const previousDate = record(bar.metadata).previousTradeDate;
    const before = typeof previousDate === 'string' ? byDate.get(previousDate) : undefined;
    const amount = positive(bar.amount), previous = positive(before?.amount);
    const price = numeric(bar.close), previousClose = numeric(bar.previous_close) ?? numeric(before?.close);
    const difference = amount !== null && previous !== null ? amount - previous : null;
    return { time: String(bar.date), price, open: numeric(bar.open), high: numeric(bar.high), low: numeric(bar.low),
      changePct: numeric(bar.change_percent) ?? (price !== null && previousClose !== null && previousClose > 0 ? (price / previousClose - 1) * 100 : null),
      volume: positive(bar.volume), minuteAmount: amount, amount, previous, difference,
      changeAmountPct: difference !== null && previous !== null && previous > 0 ? difference / previous * 100 : null,
      averages: averagePeriods.map(window => {
        const values = sorted.slice(Math.max(0, i - window + 1), i + 1).map(b => numeric(b.close));
        return values.length === window && values.every(v => v !== null) ? values.reduce<number>((sum, v) => sum + (v ?? 0), 0) / window : null;
      }), provisional: record(bar.metadata).tacticProvisional === true || (String(bar.date).slice(0, 10) === shanghaiToday() && shanghaiClock() < '15:00') };
  }).slice(-60);
}

function sessionPoints(session: Session | null): Point[] {
  return (session?.rows ?? []).map(row => ({ time: String(row.time), price: numeric(row.price), open: null, high: null, low: null,
    changePct: numeric(row.changePct), volume: positive(row.minuteVolume), minuteAmount: positive(row.minuteAmount), amount: positive(row.amount),
    previous: positive(row.previous), difference: numeric(row.difference), changeAmountPct: numeric(row.changeAmountPct), averages: [], provisional: row.provisional === true }));
}

export default function ChartPanel({ bars: initialBars, symbol, metadata: initialMetadata = {}, source: initialSource = '', fetchedAt: initialFetchedAt = '', averagePeriods = defaultAverages, loadData }: {
  bars: RecordValue[]; symbol: string; metadata?: RecordValue; source?: string; fetchedAt?: string; averagePeriods?: number[]; loadData?: ChartLoader;
}) {
  const [daily, setDaily] = useState<ChartPayload | null>(null);
  const bars = daily?.bars ?? initialBars;
  const metadata = daily?.metadata ?? initialMetadata;
  const source = daily?.source ?? initialSource;
  const fetchedAt = daily?.fetchedAt ?? initialFetchedAt;
  const manualRefresh = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<'daily' | 'session'>('daily');
  const [selected, setSelected] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [chartWidth, setChartWidth] = useState(800);
  const [ready, setReady] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const loaded = useRef('');
  const points = useMemo(() => mode === 'daily' ? dailyPoints(bars, averagePeriods) : sessionPoints(session), [mode, bars, session, averagePeriods]);
  const activeIndex = selected === null ? points.length - 1 : Math.max(0, points.findIndex(p => p.time === selected));
  const active = points[activeIndex];
  const unit = mode === 'session' ? session?.volumeUnit ?? '单位待确认' : String(metadata.volumeUnit ?? (metadata.volume_unit === 'shares' ? '股' : metadata.volume_unit === 'hands' || ['tencent', 'eastmoney', 'baostock'].includes(source) ? '手' : '单位待确认'));

  useEffect(() => {
    const svg = panel.current?.querySelector('svg');
    if (!svg) return;
    const resize = () => setChartWidth(Math.max(280, svg.getBoundingClientRect().width));
    resize(); setReady(true); const observer = new ResizeObserver(resize); observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { loaded.current = ''; setSession(null); setError(''); setSelected(null); setTip(null); }, [symbol]);
  useEffect(() => {
    if (loadData || mode !== 'session' || !symbol) return;
    const key = symbol + ':' + revision;
    if (loaded.current === key) return;
    const controller = new AbortController(); let alive = true;
    setBusy(true); setError('');
    const timeout = setTimeout(() => controller.abort(), 12000);
    fetch('/api/market/quotes/session/' + encodeURIComponent(symbol), { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('分时请求失败（' + response.status + '）');
        const data = await response.json() as Session;
        if (!Array.isArray(data.rows) || data.status === 'unavailable') throw new Error(data.reason || '暂无分时数据');
        if (alive) { setSession(data); loaded.current = key; }
      }).catch(reason => { if (alive) setError(controller.signal.aborted ? '请求超时，请手动刷新。' : String(reason.message || reason)); })
      .finally(() => { clearTimeout(timeout); if (alive) setBusy(false); });
    return () => { alive = false; clearTimeout(timeout); controller.abort(); };
  }, [symbol, mode, revision, loadData]);

  useEffect(() => {
    if (!loadData) return;
    const controller = new AbortController(); let alive = true;
    const refresh = manualRefresh.current; manualRefresh.current = false; setRefreshing(refresh);
    setBusy(true); setError('');
    const timer = setTimeout(() => controller.abort(), 27000);
    loadData(mode, refresh, controller.signal).then(data => {
      if (!alive) return;
      if (mode === 'daily') setDaily(data); else setSession(data.session ?? null);
    }).catch(e => { if (alive) setError(controller.signal.aborted ? '请求超时，保留原数据。' : e.message || '请求失败，保留原数据。'); })
      .finally(() => { clearTimeout(timer); if (alive) setBusy(false); });
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [loadData, mode, revision]);

  const x = (i: number) => mode === 'session' ? 65 + clockPosition(points[i].time) / 240 * (chartWidth - 85) : points.length === 1 ? (chartWidth + 45) / 2 : 65 + i / Math.max(1, points.length - 1) * (chartWidth - 85);
  function inspect(event: PointerEvent<SVGSVGElement>) {
    if (!points.length) return;
    const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - position.x) < Math.abs(x(best) - position.x)) best = i;
    setSelected(points[best].time);
    const bounds = panel.current?.getBoundingClientRect();
    if (bounds) setTip({ x: Math.max(8, Math.min(bounds.width - Math.min(310, bounds.width - 16) - 8, event.clientX - bounds.left + 14)), y: Math.max(50, Math.min(Math.min(bounds.height - 350, window.innerHeight - bounds.top - 350), event.clientY - bounds.top + 16)) });
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (!points.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') { event.stopPropagation(); setSelected(null); setTip(null); return; }
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, activeIndex + (event.key === 'ArrowLeft' ? -1 : 1)));
    const width = panel.current?.getBoundingClientRect().width ?? chartWidth;
    setSelected(points[index].time); setTip({ x: Math.max(8, Math.min(75, width - Math.min(310, width - 16) - 8)), y: 70 });
  }
  function graph(kind: 'price' | 'volume' | 'amount') {
    const height = kind === 'price' ? 250 : kind === 'amount' && mode === 'session' ? 225 : 145;
    const top = 18, bottom = kind === 'amount' && mode === 'session' ? 120 : height - 27;
    const field = kind === 'price' ? 'price' : kind === 'volume' ? 'volume' : 'amount';
    const values = points.flatMap(p => kind === 'price' ? [p.price, p.high, p.low, ...p.averages] : kind === 'amount' && mode === 'session' ? [p.amount, p.previous] : [p[field]]).filter((n): n is number => n !== null);
    const low = kind === 'price' ? Math.min(...values) : 0, high = Math.max(...values, 0);
    const min = Number.isFinite(low) ? low : 0;
    const span = high - min || Math.max(1, Math.abs(high) * .02);
    const y = (value: number) => bottom - (value - min) / span * (bottom - top);
    const line = (get: (p: Point) => number | null) => {
      let started = false;
      return points.map((p, i) => {
        const value = get(p);
        if (value === null) { started = false; return ''; }
        if (mode === 'session' && i && clockPosition(p.time) - clockPosition(points[i - 1].time) > 1) started = false;
        const part = (started ? 'L' : 'M') + x(i) + ',' + y(value); started = true; return part;
      }).join(' ');
    };
    const title = kind === 'price' ? (mode === 'daily' ? 'K 线与均线' : '分时价格') : kind === 'volume' ? '成交量（' + unit + '）' : (mode === 'daily' ? '成交额（元）' : '累计成交额对比（元）');
    const last = active ? format(active[field], kind === 'amount' ? 'amount' : '') : '—';
    const maxDiff = Math.max(1, ...points.map(p => Math.abs(p.difference ?? 0)));
    const width = mode === 'session' ? 2 : Math.min(9, 500 / Math.max(1, points.length));
    return <figure className="qp-plot" data-chart={kind}>
      <figcaption><strong>{title}</strong><span>{active?.time ?? '—'} · {last}{kind === 'price' && active ? '（' + format(active.changePct, 'pct') + '）' : ''}</span></figcaption>
      {!values.length && <p className="qp-empty">{busy ? '加载中…' : '暂无可核验的' + title + '数据'}</p>}
      <svg viewBox={'0 0 ' + chartWidth + ' ' + height} preserveAspectRatio="none" role="img" aria-label={title} onPointerMove={inspect} onPointerDown={inspect}>
        {[0, .5, 1].map(r => <g key={r}><line x1="65" x2={chartWidth - 20} y1={y(min + span * r)} y2={y(min + span * r)} className="qp-grid" /><text x="58" y={y(min + span * r) + 4} textAnchor="end">{values.length ? format(min + span * r, kind === 'price' ? '' : 'amount') : '—'}</text></g>)}
        {kind === 'price' && mode === 'daily' && points.map((p, i) => {
          if (p.open === null || p.price === null || p.high === null || p.low === null) return null;
          return <g key={p.time} className={p.price >= p.open ? 'qp-rise' : 'qp-fall'}><line x1={x(i)} x2={x(i)} y1={y(p.high)} y2={y(p.low)} /><rect x={x(i) - width / 2} y={Math.min(y(p.open), y(p.price))} width={width} height={Math.max(1, Math.abs(y(p.price) - y(p.open)))} /></g>;
        })}
        {kind === 'price' && mode === 'daily' && averagePeriods.map((n, i) => <path key={n} data-ma={n} d={line(p => p.averages[i] ?? null)} stroke={averageColor(n)} fill="none" strokeWidth={n === 55 || n === 233 ? 2.3 : 1.6} />)}
        {kind === 'price' && mode === 'session' && <path d={line(p => p.price)} stroke="#cf6845" fill="none" strokeWidth="2" />}
        {(kind === 'volume' || kind === 'amount' && mode === 'daily') && points.map((p, i) => {
          const value = p[field]; if (value === null) return null;
          const up = p.open !== null && p.price !== null ? p.price >= p.open : (p.changePct ?? 0) >= 0;
          return <rect key={p.time} className={up ? 'qp-rise' : 'qp-fall'} x={x(i) - width / 2} y={y(value)} width={width} height={Math.max(value === 0 ? 0 : 1, bottom - y(value))} />;
        })}
        {kind === 'amount' && mode === 'session' && <>
          <path d={line(p => p.amount)} stroke="#cf6845" fill="none" strokeWidth="2" />
          <path d={line(p => p.previous)} stroke="#638bbd" fill="none" strokeWidth="2" strokeDasharray="5 3" />
          <line x1="65" x2={chartWidth - 20} y1="171" y2="171" className="qp-grid" />
          <text x="58" y="155" textAnchor="end">+{format(maxDiff, 'amount')}</text><text x="58" y="195" textAnchor="end">−{format(maxDiff, 'amount')}</text>
          {points.map((p, i) => p.difference === null ? null : <rect key={p.time} x={x(i) - 1} y={p.difference > 0 ? 171 - p.difference / maxDiff * 25 : 171} width="2" height={Math.abs(p.difference) / maxDiff * 25} className={p.difference >= 0 ? 'qp-rise' : 'qp-fall'} />)}
        </>}
        {active && <g className="qp-cursor" data-selected-time={active.time}><line x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={height - 24} /><text x={Math.max(100, Math.min(chartWidth - 40, x(activeIndex)))} y={height - 5} textAnchor="middle">{active.time}</text></g>}
        {mode === 'session' ? [['09:30', 65], ['11:30 / 13:00', (chartWidth + 45) / 2], ['15:00', chartWidth - 20]].map(([label, pos]) => <text key={label} x={Number(pos)} y={height - 15} textAnchor="middle">{label}</text>) : points.length > 0 && [0, Math.floor((points.length - 1) / 2), points.length - 1].map((i, n) => <text key={n} x={x(i)} y={height - 15} textAnchor={n === 0 ? 'start' : n === 2 ? 'end' : 'middle'}>{points[i].time.slice(5)}</text>)}
      </svg>
      {kind === 'amount' && active && <p className="qp-compare">{mode === 'session' ? '当日累计 ' + format(active.amount, 'amount') + ' · 上日同时点 ' : '上一交易日 '}{format(active.previous, 'amount')} · 差额 <b className={(active.difference ?? 0) >= 0 ? 'qp-rise-text' : 'qp-fall-text'}>{format(active.difference, 'amount')}（{format(active.changeAmountPct, 'pct')}）</b></p>}
    </figure>;
  }
  const missingAmounts = mode === 'daily' && points.some(p => p.amount === null);
  const amountSources = Array.isArray(metadata.amountSources) ? metadata.amountSources.map(value => ({ baidu: '百度股市通', tencent: '腾讯财经', eastmoney: '东方财富', timescaledb: '本地行情库' }[String(value)] ?? String(value))).join('、') : '';
  const missingComparison = mode === 'daily' && points.length > 0 && points.every(p => p.previous === null);
  return <section ref={panel} className="chart-panel qp-chart-panel" data-chart-panel-version="1" data-chart-ready={ready} aria-label="K 线与量价结构" tabIndex={0} onKeyDown={keyboard} onPointerLeave={event => { if (event.pointerType !== 'touch') { setSelected(null); setTip(null); } }}>
    <style>{chartCss}</style>
    <div className="panel-heading"><div><h2>K 线与量价结构</h2><p>价格、成交量、成交额联动 · 悬停或点选查看数值</p></div><span>{points.length} 条可见样本</span></div>
    <div className="qp-controls"><div role="group" aria-label="图表周期"><button type="button" aria-pressed={mode === 'daily'} onClick={() => { setMode('daily'); setSelected(null); setTip(null); }}>日线</button><button type="button" aria-pressed={mode === 'session'} onClick={() => { setMode('session'); setSelected(null); setTip(null); }}>分时</button></div>{(loadData || mode === 'session') && <button type="button" disabled={busy || !symbol} onClick={() => { manualRefresh.current = true; setRevision(r => r + 1); }}>{busy ? (loadData ? (refreshing ? '刷新中…' : '读取缓存…') : '加载中…') : mode === 'daily' ? '刷新日K' : '刷新分时'}</button>}</div>
    <p className="qp-status">{mode === 'daily' ? (loadData ? (daily?.cacheKind === 'snapshot' || !daily ? '筛选快照' : '行情缓存') + ' · 数据日期 ' + (daily?.tradeDate ?? String(bars.at(-1)?.date ?? '—')) + ' · ' : '分析快照 · ') + (source || '来源待确认') + ' · ' + (fetchedAt ? '获取于 ' + fetchedAt : '获取时间待确认') : (session ? session.source + ' · 交易日 ' + session.tradeDate + ' · 上一交易日 ' + (session.previousDate ?? '待确认') + ' · 获取于 ' + session.fetchedAt + (session.cacheHit ? ' · 缓存' : '') : (loadData ? '暂无分时缓存，请点击刷新获取。' : '分时首次打开加载，之后仅手动刷新'))}{(mode === 'daily' ? points.at(-1)?.provisional : active?.provisional) ? (mode === 'daily' ? ' · 当日未收盘' : ' · 当前周期尚未结束') : ''}</p>
    {mode === 'daily' && <p className="qp-legend">{averagePeriods.map((n, i) => <span key={n} style={{color:averageColor(n)}}>MA{n}{active?.averages[i] == null ? ' — / 历史不足' : ' ' + format(active.averages[i])}</span>)}</p>}
    {mode === 'session' && <p className="qp-legend">成交额：橙线 当日累计 · 蓝色虚线 上日累计 · 差额柱 红色增加 / 绿色减少</p>}
    {error && (loadData || mode === 'session') && <p className="qp-warning" role="alert">{error}{session ? ' 下方保留上次成功数据。' : ''}</p>}
    {session?.reason && mode === 'session' && <p className="qp-warning">{session.reason}</p>}
    {!symbol && mode === 'session' && <p className="qp-warning">缺少明确的标的代码，无法请求分时。</p>}
    {missingAmounts && <p className="qp-warning">部分历史成交额缺失，缺失值显示 —，未用价格和成交量估算。</p>}
    {mode === 'daily' && amountSources && <p className="qp-status" data-amount-source>成交额来源：{amountSources} · 已覆盖 {bars.filter(bar => positive(bar.amount) !== null).length}/{bars.length} 个交易日 · 金额单位：元</p>}
    {missingComparison && <p className="qp-status">上一交易日或对应成交额尚未核验，暂不计算日线成交额变化。</p>}
    {graph('price')}{graph('volume')}{graph('amount')}
    {tip && active && <div role="tooltip" className="qp-tooltip" style={{left:tip.x,top:tip.y}}><strong>{active.time}{active.provisional ? ' · 未完成' : ''}</strong><dl>
      {(mode === 'daily' ? [['开 / 高', format(active.open) + ' / ' + format(active.high)], ['低 / 收', format(active.low) + ' / ' + format(active.price)], ...averagePeriods.map((n, i) => ['MA' + n, format(active.averages[i])])] : [['价格', format(active.price)]]).concat([
        ['涨跌幅', format(active.changePct, 'pct')], [mode === 'daily' ? '成交量' : '分钟成交量', format(active.volume) + ' ' + unit],
        [mode === 'daily' ? '成交额' : '分钟成交额', format(active.minuteAmount, 'amount')],
        ...(mode === 'session' ? [['当日累计成交额', format(active.amount, 'amount')]] : []),
        [mode === 'daily' ? '上日成交额' : '上日同时点累计', format(active.previous, 'amount')], ['成交额差额', format(active.difference, 'amount')], ['成交额变化率', format(active.changeAmountPct, 'pct')]
      ]).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl></div>}
    <p className="qp-status">成交量、成交额使用独立纵轴。左右方向键切换时间点，Home / End 跳到首尾，Esc 关闭读数。</p>
  </section>;
}

const chartCss = '.qp-chart-panel{position:relative;min-width:0;overflow:visible!important;font-variant-numeric:tabular-nums}.qp-controls{display:flex;justify-content:space-between;gap:10px;margin:12px 0}.qp-controls button{font:inherit;font-size:12px;padding:7px 14px;border:1px solid var(--border,#8b919a66);border-radius:6px;background:transparent;color:inherit;cursor:pointer}.qp-controls button[aria-pressed=true]{background:#cf68451c;border-color:#cf6845}.qp-controls button:disabled{opacity:.5}.qp-controls div{display:flex;gap:6px}.qp-chart-panel:focus-visible,.qp-controls button:focus-visible{outline:2px solid #cf6845;outline-offset:3px}.qp-status,.qp-warning,.qp-legend{font-size:11px;line-height:1.7;overflow-wrap:anywhere;margin:8px 0;opacity:.8}.qp-warning{padding:8px 10px;background:#d99c2520;border-radius:6px}.qp-legend{display:flex;gap:15px;flex-wrap:wrap}.qp-plot{margin:0;padding:12px 0 6px;border-top:1px solid #8b919a33;position:relative}.qp-plot figcaption{display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:0 4px;margin-bottom:8px}.qp-plot figcaption span{opacity:.8}.qp-plot svg{display:block;width:100%;height:145px;touch-action:pan-y;overflow:visible}.qp-plot[data-chart=price] svg{height:250px}.qp-plot[data-chart=amount] svg{height:auto;min-height:145px;max-height:225px}.qp-plot svg text{font-size:10px;fill:currentColor;opacity:.7}.qp-grid{stroke:currentColor;opacity:.12}.qp-rise{fill:#c65448;stroke:#c65448}.qp-fall{fill:#278574;stroke:#278574}.qp-rise-text{color:#c65448}.qp-fall-text{color:#278574}.qp-cursor line{stroke:currentColor;stroke-dasharray:4 3;opacity:.55}.qp-cursor text{font-size:10px;opacity:1!important}.qp-tooltip{position:absolute;z-index:20;pointer-events:none;width:310px;max-width:calc(100% - 16px);box-sizing:border-box;padding:12px 14px;border:1px solid #a2a7ae80;border-radius:9px;background:var(--card-bg,#fff);color:var(--text-main,#182432);box-shadow:0 8px 30px #0002;font-size:11px;line-height:1.65}.qp-tooltip strong{font-size:12px}.qp-tooltip dl{display:block!important;gap:0!important;margin:5px 0 0!important}.qp-tooltip dl>div{margin:0!important;padding:0!important;display:flex;justify-content:space-between;gap:12px}.qp-tooltip dt,.qp-tooltip dd{color:inherit!important;font-size:11px!important;line-height:1.65!important;padding:0!important;margin:0!important}.qp-tooltip dt{opacity:.75}.qp-tooltip dd{margin:0;text-align:right}.qp-empty{position:absolute;left:30%;top:45%;font-size:12px;opacity:.6}.qp-compare{font-size:11px;line-height:1.8;margin:2px 0 6px;padding-left:8px}.dark .qp-tooltip,[data-theme=dark] .qp-tooltip{background:#19232f;color:#e0e7ee}@media(max-width:600px){.qp-plot figcaption{flex-wrap:wrap}.qp-plot[data-chart=price] svg{height:220px}.qp-plot svg text{font-size:11px}.qp-chart-panel .panel-heading{flex-wrap:wrap}.qp-tooltip{font-size:10px}}';
`;
