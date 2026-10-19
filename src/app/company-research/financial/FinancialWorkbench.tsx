'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, FileSearch, Loader2 } from 'lucide-react';
import type { SourceSelection } from '@/lib/company-research/reader-contracts';
import { useFinancialResearch, researchApi } from './useFinancialResearch';
import { type FinancialTask, financialStatusLabels } from './workbench-state';
import { ResearchReport } from './ResearchReport';
import { EvidenceReader } from './EvidenceReader';
import { ResearchProgress } from './ResearchProgress';

export default function FinancialWorkbench() {
  const { task, tasks, selectTask, refreshList, refreshTask, connected, error, setError, selectedId } = useFinancialResearch();
  const [query, setQuery] = useState(''), [beforeYear, setBeforeYear] = useState('2023'), [afterYear, setAfterYear] = useState('2024'), [asOf, setAsOf] = useState('2025-06-30');
  const [busy, setBusy] = useState(false), [cancelPending, setCancelPending] = useState(false), [selection, setSelection] = useState<SourceSelection | null>(null);
  const [companies, setCompanies] = useState<{name: string; symbol: string}[]>([]);
  const [accepting, setAccepting] = useState(false);
  const select = (id: string) => { setSelection(null); setCancelPending(false); selectTask(id); };
  async function create(company: {name: string; symbol: string}) {
    const exchange = company.symbol.startsWith('6') ? 'SH' : /^[03]/.test(company.symbol) ? 'SZ' : 'BJ';
    const symbol = `${company.symbol.split('.')[0]}.${exchange}`;
    const spec = { schemaVersion: 1, kind: 'financial_change', requestRevision: 1, company: { name: company.name, symbol, exchange },
      periods: [beforeYear, afterYear].map(year => ({ id: `FY${year}`, start: `${year}-01-01`, end: `${year}-12-31`, kind: 'annual', basis: 'cumulative' })),
      asOf: `${asOf}T23:59:59.999+08:00`, questions: [{ id: 'income_profit', text: '收入与归母净利润如何变化？' }, { id: 'cash_flow', text: '经营现金流如何变化，原因是什么？' }, { id: 'risks', text: '主要风险有哪些延续与变化？' }], scope: 'consolidated', currency: 'CNY', comparison: { status: 'comparable' }, budget: { maxToolCalls: 40, timeoutMs: 1200000 } };
    const storageKey = `financial-research-pending:${JSON.stringify(spec)}`, key = sessionStorage.getItem(storageKey) || crypto.randomUUID(); sessionStorage.setItem(storageKey, key);
    const result = await researchApi<{task: FinancialTask}>('tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(spec) });
    select(result.task.id); setCompanies([]);
    await researchApi(`tasks/${result.task.id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedPlanRevision: result.task.planRevision }) });
    sessionStorage.removeItem(storageKey); await refreshList();
  }
  async function search() {
    setBusy(true); setError(''); setCompanies([]);
    try {
      if (Number(beforeYear) >= Number(afterYear)) throw new Error('前期年份须早于后期年份');
      const result = await researchApi<{companies: {name: string; symbol: string}[]}>(`resolve?query=${encodeURIComponent(query.trim())}`);
      if (result.companies.length === 1) await create(result.companies[0]);
      else if (result.companies.length) setCompanies(result.companies); else throw new Error('未找到公司，请检查名称或股票代码');
    } catch (e) { setError(e instanceof Error ? e.message : '创建失败'); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!task) return; setCancelPending(true);
    try { await researchApi(`tasks/${task.id}/cancel`, { method: 'POST' }); }
    catch (e) { setError(e instanceof Error ? e.message : '取消失败'); setCancelPending(false); }
  }
  async function accept() {
    if (!task?.report || !task.reportHash) return; setAccepting(true);
    try { await researchApi(`tasks/${task.id}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reportRevision: task.reportRevision, reportHash: task.reportHash, checkedNumbersAndExplanations: true }) }); await refreshTask(); }
    catch (e) { setError(e instanceof Error ? e.message : '验收记录失败'); } finally { setAccepting(false); }
  }
  return <main className="min-h-screen bg-[#f6f8f7] text-slate-900">
    <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-4 sm:px-8"><Link href="/" className="inline-flex items-center gap-2 text-sm text-slate-600"><ArrowLeft size={16} />wolfbot</Link><Link href="/company-research/legacy" className="text-xs text-slate-500 hover:text-emerald-800">主营业务研究 / 旧报告</Link></div></header>
    <div className="mx-auto max-w-[1500px] space-y-6 px-4 py-7 sm:px-8">
      <div><p className="text-xs font-semibold tracking-[0.2em] text-emerald-800">COMPANY RESEARCH</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">读懂财报里的变化</h1><p className="mt-3 text-sm leading-6 text-slate-500">从两期原始披露出发，比较经营表现，核查每条解释。</p></div>
      <form onSubmit={e => { e.preventDefault(); void search(); }} className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1fr)_120px_120px_180px_auto]"><label className="space-y-2 text-xs text-slate-600"><span>研究公司</span><input required maxLength={100} value={query} onChange={e => setQuery(e.target.value)} placeholder="公司名称或股票代码" className="block w-full rounded-lg border border-slate-200 p-3 text-sm outline-none focus:ring-2 focus:ring-emerald-700" /></label><label className="space-y-2 text-xs text-slate-600"><span>前期年报</span><input type="number" required min="2000" max="2099" value={beforeYear} onChange={e => setBeforeYear(e.target.value)} className="block w-full rounded-lg border border-slate-200 p-3 text-sm" /></label><label className="space-y-2 text-xs text-slate-600"><span>后期年报</span><input type="number" required min="2001" max="2099" value={afterYear} onChange={e => setAfterYear(e.target.value)} className="block w-full rounded-lg border border-slate-200 p-3 text-sm" /></label><label className="space-y-2 text-xs text-slate-600"><span>资料截止日期</span><input type="date" required value={asOf} onChange={e => setAsOf(e.target.value)} className="block w-full rounded-lg border border-slate-200 p-3 text-sm" /></label><button disabled={busy || !query.trim()} className="flex items-center justify-center gap-2 self-end rounded-lg bg-emerald-900 px-5 py-3 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50">{busy ? <Loader2 size={17} className="animate-spin" /> : <FileSearch size={17} />}开始研究</button></div>
        {!!companies.length && <div className="mt-4 flex flex-wrap gap-2">{companies.map(c => <button type="button" key={c.symbol} disabled={busy} onClick={() => { setBusy(true); void create(c).catch(e => setError(e.message)).finally(() => setBusy(false)); }} className="rounded-lg border px-3 py-2 text-sm">{c.name} · {c.symbol}</button>)}</div>}
        {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
      </form>
      <div className="grid items-start gap-5 xl:grid-cols-[210px_280px_minmax(0,1fr)]">
        <nav aria-label="研究记录" className="rounded-2xl border border-slate-200 bg-white p-4"><h2 className="mb-3 text-sm font-semibold">研究记录</h2>{tasks.length ? <ul className="space-y-2">{tasks.map(t => <li key={t.id}><button onClick={() => select(t.id)} aria-current={selectedId === t.id ? 'true' : undefined} className={`w-full rounded-xl p-3 text-left hover:bg-slate-50 ${selectedId === t.id ? 'bg-emerald-50 ring-1 ring-emerald-200' : ''}`}><span className="block text-sm font-medium">{t.spec.company.name}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{t.spec.periods.map(p => p.end.slice(0, 4)).join(' / ')} · {financialStatusLabels[t.status]}</span><span className="mt-1 block text-[11px] text-slate-400">{new Date(t.createdAt).toLocaleString('zh-CN')}</span></button></li>)}</ul> : <p className="text-xs leading-6 text-slate-500">创建研究后，计划与报告会保存在这里。</p>}</nav>
        {task ? <><ResearchProgress task={task} connected={connected} cancelPending={cancelPending} onCancel={() => void cancel()} onError={setError} onRevise={() => { void refreshTask().then(refreshList).catch(e => setError(e instanceof Error ? e.message : '恢复研究状态失败')); }} onStart={() => { void researchApi(`tasks/${task.id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedPlanRevision: task.planRevision }) }).then(() => refreshTask()).catch(e => setError(e.message)); }} /><ResearchReport task={task} onSource={setSelection} onAccept={() => void accept()} accepting={accepting} /></> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center xl:col-span-2"><FileSearch className="mx-auto mb-4 text-emerald-700" size={32} /><h2 className="font-medium">{selectedId ? '正在恢复研究状态…' : '用证据连接数字与解释'}</h2><p className="mx-auto mt-3 max-w-lg text-sm leading-7 text-slate-500">研究器会查找两期财报，核对收入、利润与现金流，再比较风险披露。点击结论或金额旁的“原文”，查看其具体出处。</p></div>}
      </div>
    </div>
    {selection && task && <EvidenceReader key={task.id} taskId={task.id} selection={selection} onClose={() => setSelection(null)} />}
  </main>;
}
