'use client';

import { useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Overview, SectorPanel, LimitPanel, WatchPanel, DragonTigerPanel, ThemesPanel, InstitutionsPanel } from './components/MarketPanels';
import styles from './market-dashboard.module.css';
import { MarketLayout } from './components/MarketLayout';

const tabs = [
  ['funds', '板块资金'], ['history', '近三日资金'], ['limits', '涨跌停分析'],
  ['watch', '异动监管'], ['dragon', '龙虎榜'], ['themes', '概念题材库'], ['institutions', '机构多空'],
] as const;
type Tab = typeof tabs[number][0];

function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export default function MarketDashboardClient() {
  const [tab, setTab] = useState<Tab>('funds');
  const [date, setDate] = useState(shanghaiDate), [refreshKey, setRefreshKey] = useState(0);
  const [cooldown, setCooldown] = useState(false);
  return <div className={styles.root}>
    <PageHeader title="行情看板" subtitle="市场脉搏 · 资金流向 · 交易结构" badge={<span className={styles.badge}><Activity size={12} />市场观察</span>} compactOnMobile>
      <button className={styles.refresh} disabled={cooldown} onClick={() => { setRefreshKey(value => value + 1); setCooldown(true); setTimeout(() => setCooldown(false), 3000); }}><RefreshCw size={15} />刷新行情</button>
    </PageHeader>
    <main className={styles.main}>
      <div className={styles.intro}><div><span className={styles.eyebrow}>MARKET OBSERVATORY</span><h1>从资金流向，读懂市场结构。</h1><p>统一观察指数、板块与交易行为，数据来源和业务日期随结果显示。</p></div><span className={styles.liveDot}>可见页面每分钟检查更新</span></div>
      <Overview refreshKey={refreshKey} />
      <MarketLayout refreshKey={refreshKey} />
      <nav className={styles.tabs} aria-label="行情看板模块" role="tablist">{tabs.map(([key, label]) => <button key={key} id={`tab-${key}`} role="tab" aria-controls={`panel-${key}`} aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}</nav>
      {(tab === 'limits' || tab === 'dragon') && <div className={styles.dateBar}><label>查询日期 <input type="date" value={date} max={shanghaiDate()} onInput={e => { if (e.currentTarget.value) setDate(e.currentTarget.value); }} onChange={e => { if (e.target.value) setDate(e.target.value); }} /></label><span>非交易日或盘后尚未发布时，可能没有记录；不会自动替换为其他日期。</span></div>}
      <div key={`${tab}-${date}`} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'funds' && <SectorPanel refreshKey={refreshKey} />}
        {tab === 'history' && <SectorPanel threeDays refreshKey={refreshKey} />}
        {tab === 'limits' && <LimitPanel date={date} refreshKey={refreshKey} />}
        {tab === 'watch' && <WatchPanel refreshKey={refreshKey} />}
        {tab === 'dragon' && <DragonTigerPanel date={date} refreshKey={refreshKey} />}
        {tab === 'themes' && <ThemesPanel refreshKey={refreshKey} />}
        {tab === 'institutions' && <InstitutionsPanel refreshKey={refreshKey} />}
      </div>
      <footer className={styles.footer}>金额默认人民币元，页面自动换算万 / 亿；期货持仓单位为手。数据源不可用时保留明确提示，历史数据不视为实时行情。</footer>
    </main>
  </div>;
}
