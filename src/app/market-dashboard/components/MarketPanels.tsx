'use client';

import { useState } from 'react';
import type { DashboardResource, DashboardRow } from '@/lib/quant/market-dashboard-types';
import { useDashboard } from '../useDashboard';
import { observeEtf } from '../etf-observation';
import { DataStatus, MarketTable, TrendChart, formatValue, type Column } from './MarketWidgets';
import styles from '../market-dashboard.module.css';

const name: Column = { key: 'name', label: '名称' }, code: Column = { key: 'code', label: '代码' };
const pct: Column = { key: 'changePct', label: '涨跌幅', format: 'pct', signed: true };
const money = (key: string, label: string): Column => ({ key, label, format: 'money', signed: true });
const num = (key: string, label: string): Column => ({ key, label, format: 'number' });
const sectorColumns = [name, code, pct, money('mainNet', '主力净额'), money('superNet', '超大单'), money('largeNet', '大单'), { key: 'leader', label: '领涨股' }];

export function Overview({ refreshKey }: { refreshKey: number }) {
  const state = useDashboard('overview', {}, refreshKey);
  return <section aria-label="市场指数"><div className={styles.indices}>
    {(state.data?.rows ?? []).map(row => <article key={String(row.code)} className={styles.indexCard}>
      <p>{row.name}</p><strong>{formatValue(row.price, 'number')}</strong><span className={Number(row.changePct) >= 0 ? styles.up : styles.down}>{formatValue(row.changePct, 'pct')}</span>
      <small>成交额 {formatValue(row.amount, 'money')} · {String(row.quoteTime || '时间未知')}</small>
    </article>)}
    {!state.data && <div className={styles.indexCard}>{state.emptyMessage}</div>}
  </div><DataStatus {...state} /></section>;
}

function Detail({ resource, params, title, refreshKey, field = 'price', moneyChart = false }: {
  resource: DashboardResource; params: Record<string, string>; title: string; refreshKey: number; field?: string; moneyChart?: boolean;
}) {
  const state = useDashboard(resource, params, refreshKey);
  return <section className={styles.detail}><h3>{title}</h3><DataStatus {...state} />
    <TrendChart emptyMessage={state.emptyMessage} rows={state.data?.rows ?? []} field={field} title={title} money={moneyChart} />
    <p className={styles.note}>{state.data?.note}</p>
  </section>;
}

export function SectorPanel({ threeDays = false, refreshKey }: { threeDays?: boolean; refreshKey: number }) {
  const [kind, setKind] = useState('industry'), [page, setPage] = useState(1), [search, setSearch] = useState('');
  const [selected, setSelected] = useState<DashboardRow | null>(null);
  const state = useDashboard('sectors', { kind, page: String(page) }, refreshKey);
  return <section className={styles.panel}>
    <div className={styles.panelHead}><div><h2>{threeDays ? '近三日资金' : '板块资金流'}</h2><p>{threeDays ? '选择板块，查看最近三个交易日的净流入与累计曲线。' : '行业与概念主力净流入排名，点击名称展开日内资金走势。'}</p></div>
      <div className={styles.controls}><select aria-label="板块类型" value={kind} onChange={e => { setKind(e.target.value); setPage(1); setSelected(null); }}><option value="industry">行业板块</option><option value="concept">概念板块</option></select>
        <input aria-label="搜索板块" placeholder="搜索当前页板块" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
    <DataStatus {...state} /><MarketTable emptyMessage={state.emptyMessage} rows={state.data?.rows ?? []} columns={sectorColumns} search={search} selectedCode={String(selected?.code ?? '')} onSelect={setSelected} />
    <Pager page={page} total={state.data?.total} onChange={value => { setPage(value); setSelected(null); }} />
    {selected && <Detail key={`${selected.code}-${threeDays}`} resource="sector-history" params={{ code: String(selected.code), period: threeDays ? '3d' : 'intraday' }} title={`${selected.name} · ${threeDays ? '三日累计净流入' : '日内累计净流入'}`} refreshKey={refreshKey} field="cumulative" moneyChart />}
    <p className={styles.note}>{state.data?.note} {threeDays && '三日曲线使用日级节点，不将收盘点伪装成分钟数据。'}</p>
    {!threeDays && <EtfPanel refreshKey={refreshKey} />}
  </section>;
}

function Pager({ page, total, onChange }: { page: number; total?: number; onChange: (page: number) => void }) {
  return <div className={styles.pager}><button disabled={page === 1} onClick={() => onChange(page - 1)}>上一页</button><span>第 {page} 页{total !== undefined && ` · 共 ${total} 条`}</span><button disabled={page >= 10 || total === undefined || page * 100 >= total} onClick={() => onChange(page + 1)}>下一页</button></div>;
}

function EtfPanel({ refreshKey }: { refreshKey: number }) {
  const state = useDashboard('etfs', {}, refreshKey);
  const [monitor, setMonitor] = useState(false);
  const [selected, setSelected] = useState<DashboardRow | null>(null);
  return <section className={styles.detail}><h3>宽基 ETF 观察</h3><p className={styles.note}>13 只宽基 ETF，点击查看分时。价格和成交额变化是量价观察，不能据此识别“国家队”或其他资金主体。</p>
    <DataStatus {...state} /><MarketTable emptyMessage={state.emptyMessage} rows={state.data?.rows ?? []} columns={[name, code, num('price', '现价'), pct, money('amount', '成交额'), { key: 'turnover', label: '换手率', format: 'pct' }]} onSelect={setSelected} />
    <button className={styles.refresh} aria-pressed={monitor} onClick={() => setMonitor(value => !value)}>{monitor ? '暂停 ETF 异动观察' : '启用 ETF 异动观察'}</button>
    {monitor && <><p className={styles.note}>仅观察盘中分钟，以最近30个已完成分钟的成交额中位数为基线，1.6倍标为放大，2.4倍标为脉冲；排除盘前、午休、盘后及最后一个可能未完成的分钟。离开本页后停止观察。</p><div className={styles.observations}>{(state.data?.rows ?? []).map(row => <EtfObservation key={String(row.code)} row={row} refreshKey={refreshKey} />)}</div></>}
    {selected && <Detail key={String(selected.code)} resource="minute" params={{ code: String(selected.code).slice(-6) }} title={`${selected.name} · 分时价格`} refreshKey={refreshKey} />}
  </section>;
}

function EtfObservation({ row, refreshKey }: { row: DashboardRow; refreshKey: number }) {
  const state = useDashboard('minute', { code: String(row.code).slice(-6) }, refreshKey);
  const observation = observeEtf(state.data?.rows ?? []);
  return <article className={styles.observation}><strong>{row.name}</strong><span>{state.error || state.data?.status === 'unavailable' ? '数据不可用' : observation.label}</span><small>{state.data?.tradeDate || '日期待确认'} {observation.time || ''}</small><b>{observation.ratio === null ? '—' : `${observation.ratio.toFixed(2)} 倍`} · {observation.direction}</b></article>;
}

export function LimitPanel({ date, refreshKey }: { date: string; refreshKey: number }) {
  const [pool, setPool] = useState('up'), [search, setSearch] = useState('');
  const [selected, setSelected] = useState<DashboardRow | null>(null);
  const state = useDashboard(pool === 'strong' ? 'strong' : 'limits', pool === 'strong' ? {} : { pool, date }, refreshKey);
  const columns: Column[] = pool === 'strong' ? [name, code, pct, { key: 'industry', label: '行业' }, { key: 'reason', label: '强势原因' }] :
    [name, code, pct, num('boards', '连板/连续天数'), money('fund', '封单金额'), num('openCount', '开板次数'), { key: 'firstTime', label: '首次封板', format: 'time' }, { key: 'industry', label: '行业' }];
  return <section className={styles.panel}><div className={styles.panelHead}><div><h2>涨跌停分析</h2><p>按日期查看四类股票池，强势股复盘使用源提供的业务日期。</p></div><input aria-label="搜索涨跌停股票" placeholder="代码、名称或行业" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <div className={styles.segmented}>{[['up', '涨停'], ['down', '跌停'], ['blow', '炸板'], ['yesterday', '昨日涨停'], ['strong', '强势股复盘']].map(([key, label]) => <button key={key} aria-pressed={pool === key} onClick={() => { setPool(key); setSelected(null); }}>{label}</button>)}</div>
    <DataStatus {...state} /><MarketTable emptyMessage={state.emptyMessage} rows={state.data?.rows ?? []} columns={columns} search={search} onSelect={setSelected} />
    {selected && <Detail key={String(selected.code)} resource="kline" params={{ code: String(selected.code) }} title={`${selected.name} · 近90日前复权收盘走势`} refreshKey={refreshKey} />}
    <p className={styles.note}>{state.data?.note}</p>
  </section>;
}

export function WatchPanel({ refreshKey }: { refreshKey: number }) {
  const state = useDashboard('watch', {}, refreshKey), [search, setSearch] = useState('');
  return <section className={styles.panel}><div className={styles.panelHead}><div><h2>异动监管</h2><p>监管期、今日监控与次日预警。</p></div><input aria-label="搜索监管名单" placeholder="代码、名称或规则" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <DataStatus {...state} /><MarketTable emptyMessage={state.emptyMessage} rows={state.data?.rows ?? []} search={search} columns={[name, code, { key: 'type', label: '类别' }, { key: 'rule', label: '规则 / 监管期' }, pct, { key: 'deviation', label: '偏离值', format: 'pct' }, { key: 'trigger', label: '触发说明' }]} /><p className={styles.note}>{state.data?.note}</p></section>;
}

export function DragonTigerPanel({ date, refreshKey }: { date: string; refreshKey: number }) {
  const state = useDashboard('dragon-tiger', { date }, refreshKey), [search, setSearch] = useState('');
  const [selected, setSelected] = useState<DashboardRow | null>(null);
  return <section className={styles.panel}><div className={styles.panelHead}><div><h2>龙虎榜</h2><p>按上榜原因查看买卖金额，点击股票展开营业部席位。</p></div><input aria-label="搜索龙虎榜" placeholder="代码、名称或原因" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <DataStatus {...state} /><MarketTable emptyMessage={state.emptyMessage} rows={state.data?.rows ?? []} search={search} onSelect={setSelected} columns={[name, code, pct, money('net', '净买入'), money('buy', '买入'), money('sell', '卖出'), { key: 'reason', label: '上榜原因' }]} />
    {selected && <Seats key={`${date}-${selected.code}`} date={date} row={selected} refreshKey={refreshKey} />}
    <p className={styles.note}>{state.data?.note}</p></section>;
}
function Seats({ date, row, refreshKey }: { date: string; row: DashboardRow; refreshKey: number }) {
  const state = useDashboard('seats', { date, code: String(row.code) }, refreshKey);
  return <section className={styles.detail}><h3>{row.name} · 营业部席位</h3><DataStatus {...state} /><MarketTable emptyMessage={state.emptyMessage} rows={state.data?.rows ?? []} columns={[{ key: 'name', label: '营业部' }, money('buy', '买入'), money('sell', '卖出'), money('net', '净额'), { key: 'reason', label: '原因' }]} /></section>;
}

export function ThemesPanel({ refreshKey }: { refreshKey: number }) {
  const [page, setPage] = useState(1), [search, setSearch] = useState('');
  const state = useDashboard('themes', { page: String(page) }, refreshKey);
  const [selected, setSelected] = useState<DashboardRow | null>(null);
  return <section className={styles.panel}><div className={styles.panelHead}><div><h2>概念题材库</h2><p>东方财富概念板块与成分股，可按行业筛选。</p></div><input aria-label="搜索概念" placeholder="搜索当前页概念" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <DataStatus {...state} /><MarketTable emptyMessage={state.emptyMessage} rows={state.data?.rows ?? []} search={search} columns={[name, code, pct, money('mainNet', '主力净额')]} onSelect={setSelected} /><Pager page={page} total={state.data?.total} onChange={value => { setPage(value); setSelected(null); }} />
    {selected && <ThemeStocks key={String(selected.code)} row={selected} refreshKey={refreshKey} />}</section>;
}
function ThemeStocks({ row, refreshKey }: { row: DashboardRow; refreshKey: number }) {
  const [page, setPage] = useState(1), [industry, setIndustry] = useState('');
  const state = useDashboard('theme-stocks', { code: String(row.code), page: String(page) }, refreshKey);
  const rows = state.data?.rows ?? [];
  return <section className={styles.detail}><h3>{row.name} · 成分股</h3><select aria-label="成分股行业" value={industry} onChange={e => setIndustry(e.target.value)}><option value="">全部行业</option>{[...new Set(rows.map(r => String(r.industry || '')).filter(Boolean))].map(name => <option key={name}>{name}</option>)}</select>
    <DataStatus {...state} /><MarketTable emptyMessage={industry && rows.length ? '当前行业无匹配记录，可切换全部行业。' : state.emptyMessage} rows={industry ? rows.filter(r => r.industry === industry) : rows} columns={[name, code, num('price', '现价'), pct, money('mainNet', '主力净额'), { key: 'industry', label: '行业' }]} /><Pager page={page} total={state.data?.total} onChange={value => { setPage(value); setIndustry(''); }} /></section>;
}

export function InstitutionsPanel({ refreshKey }: { refreshKey: number }) {
  const state = useDashboard('institutions', {}, refreshKey), [date, setDate] = useState('');
  const sections = state.data?.sections ?? [], section = sections.find(s => s.date === date) ?? sections[0];
  return <section className={styles.panel}><div className={styles.panelHead}><div><h2>机构多空</h2><p>股指期货机构及中信持仓，单位：手。</p></div><select aria-label="机构持仓日期" value={section?.date ?? ''} onChange={e => setDate(e.target.value)}>{sections.map((s, i) => <option key={s.date ?? i} value={s.date ?? ''}>{s.date || '日期未知'}</option>)}</select></div>
    <DataStatus {...state} />{section && <p className={styles.summary}>当前日期 {section.date || '未知'} · 机构净持仓 {formatValue(section.allNet, 'number')} 手 · 中信净持仓 {formatValue(section.citicNet, 'number')} 手</p>}
    <MarketTable emptyMessage={state.emptyMessage} rows={section?.rows ?? []} columns={[{ key: 'index_name', label: '指数' }, { key: 'variety_code', label: '品种' }, num('long_position', '多单'), num('short_position', '空单'), { ...num('institution_net', '机构净额'), signed: true }, { key: 'institution_action', label: '机构动作' }, num('citic_long', '中信多单'), num('citic_short', '中信空单'), { ...num('citic_net', '中信净额'), signed: true }, { key: 'citic_action', label: '中信动作' }]} /><p className={styles.note}>{state.data?.note}</p></section>;
}
