'use client';
import { useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { researchApi } from './useFinancialResearch';
import type { FinancialTask } from './workbench-state';

type FilingCandidate = { id: string; periodId: string; title: string; url: string; provider: string; evidenceSha256: string;
  disclosure: { status: 'unknown'; reason: string } | { status: 'verified'; precision: 'date'; on: string; timezone: 'Asia/Shanghai' } | { status: 'verified'; precision: 'instant'; at: string };
  eligibility: 'available' | 'after_cutoff' | 'date_unverified'; warnings: string[] };
const eligibilityLabel = { available: '披露日期可用于当前截止日', after_cutoff: '晚于当前截止日', date_unverified: '披露日期待核实' };

export function ResearchUpdatePanel({ task, onChanged, onError }: { task: FinancialTask; onChanged: () => void; onError: (message: string) => void }) {
  const [asOf, setAsOf] = useState(task.spec.asOf.slice(0, 10));
  const [candidates, setCandidates] = useState<FilingCandidate[]>([]), [failures, setFailures] = useState<string[]>([]);
  const [page, setPage] = useState(0), [hasMore, setHasMore] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function check(nextPage = 1) {
    setBusy(true); setMessage(''); onError('');
    try {
      const result = await researchApi<{ candidates: FilingCandidate[]; failures: string[]; hasMore: boolean; page: number }>(`tasks/${task.id}/documents?discover=1&page=${nextPage}`);
      setCandidates(current => nextPage === 1 ? result.candidates : [...current, ...result.candidates.filter(item => !current.some(existing => existing.id === item.id))]);
      setFailures(result.failures); setHasMore(result.hasMore); setPage(nextPage);
      if (!result.candidates.length && !result.failures.length) setMessage('没有发现符合当前两个报告期的新公告。');
    } catch (error) { onError(error instanceof Error ? error.message : '公告检查失败'); }
    finally { setBusy(false); }
  }
  async function importCandidate(candidate: FilingCandidate) {
    setBusy(true); setMessage(''); onError('');
    try {
      const result = await researchApi<{ reused: boolean; eligibility: string }>(`tasks/${task.id}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'cninfo', candidateId: candidate.id, page }) });
      setMessage(result.reused ? '文件内容已存在，未新增资料版本。' : `已导入资料，${eligibilityLabel[result.eligibility as keyof typeof eligibilityLabel] || '等待解析'}`);
      onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : '公告导入失败'); }
    finally { setBusy(false); }
  }
  async function runUpdate() {
    setBusy(true); setMessage(''); onError('');
    const payload = { expectedRequestRevision: task.requestRevision, expectedPlanRevision: task.planRevision, expectedReportRevision: task.reportRevision, asOf: `${asOf}T23:59:59.999+08:00` };
    const storageKey = `financial-research-update:${task.id}:${task.reportRevision}`;
    const signature = JSON.stringify(payload), saved = sessionStorage.getItem(storageKey);
    const prior = saved ? JSON.parse(saved) as { signature: string; key: string } : null;
    const key = prior?.signature === signature ? prior.key : crypto.randomUUID();
    sessionStorage.setItem(storageKey, JSON.stringify({ signature, key }));
    try {
      const result = await researchApi<{ update: { queued: boolean; reason?: string; idempotent?: boolean } }>(`tasks/${task.id}/updates/run`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      sessionStorage.removeItem(storageKey);
      if (!result.update.queued) setMessage('没有可用于新版本的已核实来源，报告保持不变。');
      else { setMessage(result.update.idempotent ? '该更新请求已受理，已恢复当前报告状态。' : '新研究已排队，上一版报告继续保留。'); onChanged(); }
    } catch (error) { onError(error instanceof Error ? error.message : '更新研究失败'); }
    finally { setBusy(false); }
  }
  const dateValue = (candidate: FilingCandidate) => candidate.disclosure.status === 'unknown' ? '披露日期待核实'
    : candidate.disclosure.precision === 'date' ? candidate.disclosure.on : new Date(candidate.disclosure.at).toLocaleString('zh-CN');
  return <section className="border-t pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">检查新公告</h3>
      <button type="button" onClick={() => void check(1)} disabled={busy} className="inline-flex min-h-9 items-center gap-2 rounded-md border px-3 py-2 text-xs disabled:opacity-50">
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}检查新公告
      </button>
    </div>
    <p className="mt-2 text-xs leading-5 text-slate-500">仅使用披露时点不晚于所选截止日期的来源。重复文件不会单独生成报告版本。</p>
    {candidates.length > 0 && <ul className="mt-3 space-y-3">{candidates.map(candidate => {
      const imported = task.documents.some(document => document.id === candidate.id);
      return <li key={`${candidate.provider}-${candidate.id}`} className="border-l-2 border-slate-200 pl-3">
        <p className="break-words text-xs font-medium text-slate-800">{candidate.title}</p>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">{candidate.periodId} · {dateValue(candidate)} · {imported ? '已导入' : eligibilityLabel[candidate.eligibility]}</p>
        {candidate.provider === 'cninfo' ? <button type="button" disabled={busy} onClick={() => void importCandidate(candidate)} className="mt-2 inline-flex min-h-8 items-center gap-2 rounded-md border border-emerald-800 px-2.5 py-1.5 text-xs text-emerald-900 disabled:opacity-50">
          <RefreshCw size={13} />{imported ? '检查公告版本' : '导入公告'}
        </button> : <p className="mt-2 text-[11px] text-slate-500">当前仅可直接导入巨潮官方公告</p>}
      </li>;
    })}</ul>}
    {hasMore && <button type="button" disabled={busy} onClick={() => void check(page + 1)} className="mt-3 rounded-md border px-3 py-2 text-xs disabled:opacity-50">检查下一页</button>}
    {!!failures.length && <p role="status" className="mt-3 text-xs leading-5 text-amber-800">部分来源不可用：{failures.join('；')}</p>}
    {!!message && <p role="status" className="mt-3 text-xs leading-5 text-emerald-900">{message}</p>}
    <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
      <label className="space-y-1.5 text-xs text-slate-600"><span>新报告资料截止日</span><input type="date" required min={task.spec.asOf.slice(0, 10)} max={new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)} value={asOf} onChange={event => setAsOf(event.target.value)} className="block w-full rounded-md border border-slate-200 p-2 text-sm" /></label>
      <button type="button" onClick={() => void runUpdate()} disabled={busy || task.status === 'queued' || task.status === 'running'} className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-emerald-900 px-3 py-2 text-xs text-white disabled:opacity-50">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}重新研究并比较
      </button>
    </div>
  </section>;
}
