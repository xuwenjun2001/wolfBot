'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Building2, Check, ChevronDown, Circle, Loader2, Search, Square, X } from 'lucide-react';
import { PlatformSwitcher } from '@/components/layout/PlatformSwitcher';
import type { Company, PublicRun, ResearchStatus, SectionKey } from '@/lib/company-research/contracts';

// Keep this legacy view's display values local. The server contract barrel also
// exports hashing and artifact verification, which cannot enter a client bundle.
const sectionKeys = ['business', 'supplyChain', 'financials'] as const satisfies readonly SectionKey[];
const sectionLabels: Record<SectionKey, string> = { business: '主营业务', supplyChain: '上下游产业链', financials: '近期财报' };
const terminalStatuses: readonly ResearchStatus[] = ['completed', 'partial', 'failed', 'cancelled'];
const statusLabels: Record<ResearchStatus, string> = { queued: '等待研究', running: '研究中', completed: '研究完成', partial: '部分完成', failed: '执行失败', cancelled: '已取消' };
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/company-research/${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body as T;
}
function elapsed(start: string | null, end?: string | null, now = Date.now()) {
  if (!start) return '尚未开始';
  const seconds = Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}
export default function CompanyResearchClient() {
  const [query, setQuery] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [runs, setRuns] = useState<PublicRun[]>([]);
  const [run, setRun] = useState<PublicRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [cancelPending, setCancelPending] = useState(false);
  const refresh = useCallback(async () => {
    const data = await api<{ runs: PublicRun[] }>('runs'); setRuns(data.runs);
  }, []);
  const selectRun = useCallback(async (id: string) => {
    const data = await api<{ run: PublicRun }>(`runs/${id}`); setRun(data.run); setCancelPending(false);
    const url = new URL(window.location.href); url.searchParams.set('run', id); window.history.replaceState(null, '', url);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    setQuery(url.searchParams.get('company') || '');
    void refresh().catch(e => setError(e.message));
    const id = url.searchParams.get('run'); if (id) void selectRun(id).catch(e => setError(e.message));
    const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [refresh, selectRun]);
  const activeId = run && !terminalStatuses.includes(run.status) ? run.id : null;
  useEffect(() => {
    if (!activeId) return;
    const events = new EventSource(`/api/company-research/runs/${activeId}/events`);
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    const update = (event: MessageEvent) => {
      const next = JSON.parse(event.data) as PublicRun;
      setRun(next); setConnected(true);
      if (terminalStatuses.includes(next.status)) { events.close(); void refresh().catch(() => undefined); }
    };
    events.addEventListener('snapshot', update as EventListener);
    events.addEventListener('unavailable', () => { setConnected(false); });
    return () => events.close();
  }, [activeId, refresh]);
  async function start(company: Company) {
    const keyName = `company-research-pending:${company.symbol}`;
    const key = sessionStorage.getItem(keyName) || crypto.randomUUID(); sessionStorage.setItem(keyName, key);
    const data = await api<{ run: PublicRun }>('runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ symbol: company.symbol }) });
    sessionStorage.removeItem(keyName); setCompanies([]); await selectRun(data.run.id); await refresh();
  }
  async function search() {
    if (!query.trim()) return;
    setBusy(true); setError(''); setCompanies([]);
    try {
      const data = await api<{ companies: Company[] }>(`resolve?query=${encodeURIComponent(query.trim())}`);
      const exact = data.companies.filter(c => c.name === query.trim() || c.symbol === query.trim());
      if (exact.length === 1) await start(exact[0]);
      else if (data.companies.length === 1) await start(data.companies[0]);
      else if (data.companies.length) setCompanies(data.companies);
      else setError('未找到匹配的 A 股公司，请输入公司名称或六位股票代码。');
    } catch (e) { setError(e instanceof Error ? e.message : '研究启动失败'); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!run) return; setCancelPending(true);
    try { await api(`runs/${run.id}/cancel`, { method: 'POST' }); }
    catch (e) { setError(e instanceof Error ? e.message : '取消失败'); setCancelPending(false); }
  }
  const sourceLink = (sourceId: string, quote: string, locator: string, index: number) => {
    const source = run?.sources.find(s => s.id === sourceId);
    return source ? <a key={`${sourceId}-${index}`} href={source.url} target="_blank" rel="noopener noreferrer" title={`${locator}\n${quote}`} className="ml-1 inline-flex rounded bg-emerald-50 px-1.5 text-xs text-emerald-800 hover:bg-emerald-100">[{run!.sources.indexOf(source) + 1}]</a> : null;
  };
  return <main className="min-h-screen bg-[#f7f8fa] text-slate-900">
    <header className="border-b bg-white"><div className="mx-auto flex max-w-[1500px] items-center justify-between px-6 py-4"><Link href="/" className="flex items-center gap-2 text-sm text-slate-500"><ArrowLeft size={16} /> 研究工作台</Link><PlatformSwitcher /></div></header>
    <div className="mx-auto max-w-[1500px] px-5 py-8 md:px-8">
      <div className="mb-7 flex items-center gap-4"><span className="rounded-2xl bg-emerald-900 p-3 text-white"><Building2 size={27} /></span><div><h1 className="text-2xl font-semibold tracking-tight">公司研究</h1><p className="mt-1 text-sm text-slate-500">从主营业务到产业链，再到最新财报。每一步调查都有迹可循。</p></div></div>
      <form onSubmit={e => { e.preventDefault(); void search(); }} className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <label htmlFor="company-query" className="mb-2 block text-sm font-medium">你想了解哪家公司？</label>
        <div className="flex gap-3"><input id="company-query" value={query} onChange={e => setQuery(e.target.value)} maxLength={100} placeholder="输入 A 股公司名称或代码，例如：宁德时代 / 300750" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emerald-600" /><button disabled={busy || !query.trim()} className="flex items-center gap-2 rounded-lg bg-emerald-900 px-5 text-sm font-medium text-white disabled:opacity-50">{busy ? <Loader2 size={17} className="animate-spin" /> : <Search size={17} />}<span className="hidden sm:inline">开始研究</span></button></div>
        <p className="mt-3 text-xs text-slate-400">主营业务与收入结构 · 上游供应与下游应用 · 近期财报与同比变化</p>
        {companies.length > 0 && <div className="mt-4"><p className="mb-2 text-sm">找到多个结果，请确认研究对象：</p><div className="flex flex-wrap gap-2">{companies.map(c => <button type="button" disabled={busy} key={c.symbol} onClick={() => { setBusy(true); void start(c).catch(e => setError(e.message)).finally(() => setBusy(false)); }} className="rounded-lg border px-4 py-2 text-sm hover:bg-emerald-50">{c.name} · {c.symbol}</button>)}</div></div>}
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      </form>
      <div className="grid items-start gap-5 xl:grid-cols-[230px_340px_minmax(0,1fr)]">
        <aside className="rounded-2xl border bg-white p-4"><h2 className="mb-3 text-sm font-semibold">研究记录</h2>{runs.length ? <div className="space-y-2">{runs.map(item => <button key={item.id} onClick={() => void selectRun(item.id).catch(e => setError(e.message))} className={`w-full rounded-xl p-3 text-left ${item.id === run?.id ? 'bg-emerald-50 ring-1 ring-emerald-100' : 'hover:bg-slate-50'}`}><span className="block text-sm font-medium">{item.company.name}</span><span className="mt-1 block text-xs text-slate-500">{new Date(item.createdAt).toLocaleDateString('zh-CN')} · {statusLabels[item.status]}</span></button>)}</div> : <p className="py-5 text-sm text-slate-400">开始第一次公司研究</p>}</aside>
        <section className="rounded-2xl border bg-white p-5"><div className="flex items-center justify-between"><h2 className="font-semibold">研究过程</h2>{activeId && <button onClick={() => void cancel()} disabled={cancelPending} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50"><Square size={10} />{cancelPending ? '正在停止' : '停止'}</button>}</div>
          {run ? <><div className="my-4 rounded-xl bg-slate-50 p-3"><div className="flex items-center justify-between text-sm"><span className="font-medium">{run.steps.length ? `当前第 ${run.steps.length} 步` : '等待开始'}</span><span className="text-emerald-800">{statusLabels[run.status]}</span></div><p className="mt-2 text-xs text-slate-500">{elapsed(run.startedAt, run.finishedAt, now)}{activeId && !connected ? ' · 连接中断，正在重连' : ''}</p>{run.status === 'running' && <p className="mt-2 text-xs text-slate-500">{run.steps.at(-1)?.status === 'running' ? run.steps.at(-1)?.title : '正在分析资料并选择下一步'}</p>}</div>
            {activeId && run.phase && <p className="mb-3 text-xs text-emerald-800">{run.phase === 'finalizing' ? '整理报告' : '调查中'}{activeId && run.deadline ? ` · 剩余 ${Math.max(0, Math.ceil((run.deadline - now) / 60000))} 分钟` : ''}</p>}
            {run.systemEvents?.map(event => <p key={event.id} className="mb-2 rounded bg-slate-50 p-2 text-xs text-slate-600">系统：{event.message}</p>)}
            {run.status === 'queued' && <p className="mb-4 text-sm text-slate-500">已加入研究队列，后台开始后会显示调查步骤。</p>}
            {!!run.coverage?.questions?.length && <details className="mb-4 rounded-lg border p-3 text-xs"><summary className="cursor-pointer font-medium">研究问题覆盖</summary><ul className="mt-2 space-y-2">{run.coverage.questions.map(q => <li key={q.id}>{q.label}{!q.required ? '（补充）' : ''}：{({ answered: '已回答', not_disclosed: '来源明确未披露', not_found: '尚未找到或核查', fetch_failed: '获取失败', conflict: '存在冲突' } as Record<string, string>)[q.status] || q.status}</li>)}</ul></details>}
            <ol className="space-y-1">{run.steps.map(step => <li key={step.number} className="border-l border-slate-200 pl-3 py-2"><details open={step.status === 'running'}><summary className="flex cursor-pointer list-none items-center gap-2 text-sm">{step.status === 'running' ? <Loader2 size={15} className="animate-spin text-emerald-700" /> : step.status === 'failed' ? <X size={15} className="text-amber-600" /> : <Check size={15} className="text-emerald-700" />}<span className="flex-1">{step.number}. {step.title}</span><ChevronDown size={12} className="text-slate-400" /></summary><div className="mt-2 space-y-2 break-words pl-5 text-xs leading-relaxed text-slate-500">{step.retryOf && <p>重试第 {step.retryOf} 步</p>}{Object.keys(step.input).length > 0 && <p className="whitespace-pre-wrap">{Object.values(step.input).flat().join('\n')}</p>}<p className="whitespace-pre-wrap">{step.summary || '正在执行…'}</p><p>{elapsed(step.startedAt, step.finishedAt, now)}</p></div></details></li>)}</ol>
            {run.error && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{run.error}</p>}</> : <div className="py-14 text-center text-sm text-slate-400"><Circle className="mx-auto mb-3" size={24} />搜索、阅读和补查步骤将显示在这里</div>}
        </section>
        <article className="min-w-0 rounded-2xl border bg-white p-6 md:p-8">
          {run?.report ? <><div className="mb-6 border-b pb-5"><p className="text-xs font-medium tracking-widest text-emerald-800">公司研究报告 · {statusLabels[run.status]}</p><h2 className="mt-2 text-2xl font-semibold">{run.company.name}<span className="ml-2 text-sm font-normal text-slate-400">{run.company.symbol}</span></h2><p className="mt-2 text-xs text-slate-400">研究截止：{new Date(run.asOf).toLocaleString('zh-CN')}</p><p className="mt-4 text-sm leading-7 text-slate-600">{run.report.overview}</p>{activeId && <p className="mt-2 text-xs text-amber-700">研究草稿，证据和结论仍在核查中。</p>}</div>
            {sectionKeys.map((key, i) => <section key={key} className="mb-8"><h3 className="mb-4 text-lg font-semibold"><span className="mr-2 text-emerald-700">0{i + 1}</span>{sectionLabels[key]}</h3><div className="space-y-4">{run.report![key].claims.map((claim, index) => <div key={index} className="text-sm leading-7 text-slate-700">{claim.kind !== 'fact' && <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{claim.kind === 'inference' ? '分析推断' : '第三方观点'}</span>}{claim.text}{claim.citations.map((c, j) => sourceLink(c.sourceId, c.quote, c.locator, j))}</div>)}</div>{run.report![key].gaps.map((gap, index) => <p key={index} className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">待核实：{gap}</p>)}
              {key === 'financials' && run.report!.metrics.length > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b text-slate-500"><th className="py-3 pr-3">指标</th><th>数值</th><th>同比</th><th>期间 / 口径</th></tr></thead><tbody>{run.report!.metrics.map((m, index) => <tr key={index} className="border-b border-slate-100"><td className="py-3 pr-3">{m.label}</td><td className="pr-3">{m.value}{sourceLink(m.citation.sourceId, m.citation.quote, m.citation.locator, 0)}</td><td className="pr-3">{m.yoy || '未披露'}</td><td>{m.period}<br /><span className="text-slate-400">{m.basis}</span></td></tr>)}</tbody></table></div>}
            </section>)}
            {run.report.limitations.length > 0 && <section className="mb-6"><h3 className="mb-2 font-semibold">资料限制与待核实事项</h3><ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-slate-600">{run.report.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></section>}
          </> : <div className="py-24 text-center"><Building2 className="mx-auto mb-4 text-slate-300" size={40} /><h2 className="text-lg font-medium">读懂一家公司的生意</h2><p className="mx-auto mt-3 max-w-sm text-sm leading-7 text-slate-400">研究报告将在搜集资料后逐步形成。你可以在左侧查看每一步搜索、阅读与补充调查。</p></div>}
          {!!run?.sources.length && <section className="border-t pt-5"><h3 className="mb-3 text-sm font-semibold">已读取资料 · {run.sources.length} 份</h3><ol className="space-y-3">{run.sources.map((source, i) => <li key={source.id} className="text-xs"><a className="inline-flex max-w-full items-start gap-1 text-emerald-800 hover:underline" href={source.url} target="_blank" rel="noopener noreferrer"><span>[{i + 1}] {source.title}</span><ArrowUpRight size={13} className="shrink-0" /></a><p className="mt-1 text-slate-400">获取于 {new Date(source.fetchedAt).toLocaleString('zh-CN')}</p></li>)}</ol></section>}
        </article>
      </div>
    </div>
  </main>;
}
