'use client';
import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { ResearchTaskRevisionChanges } from '@/lib/company-research/task-contracts';
import { researchApi } from './useFinancialResearch';
import type { FinancialTask } from './workbench-state';

function annualPeriod(year: string, template: FinancialTask['spec']['periods'][number]) {
  return { ...template, id: `FY${year}`, start: `${year}-01-01`, end: `${year}-12-31` };
}

export function ResearchPlanEditor({ task, onAccepted, onError }: { task: FinancialTask; onAccepted: () => void; onError: (message: string) => void }) {
  const [questions, setQuestions] = useState(task.spec.questions.map(question => question.text));
  const [beforeYear, setBeforeYear] = useState(task.spec.periods[0].end.slice(0, 4));
  const [afterYear, setAfterYear] = useState(task.spec.periods[1].end.slice(0, 4));
  const [asOf, setAsOf] = useState(task.spec.asOf.slice(0, 10));
  const [busy, setBusy] = useState(false);
  const annual = task.spec.periods.every(period => period.kind === 'annual' && period.basis === 'cumulative');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); onError('');
    try {
      if (annual && Number(beforeYear) >= Number(afterYear)) throw new Error('前期年份须早于后期年份');
      const changes: ResearchTaskRevisionChanges = {};
      const nextQuestions = task.spec.questions.map((question, index) => ({ ...question, text: questions[index].trim() }));
      if (nextQuestions.some((question, index) => question.text !== task.spec.questions[index].text)) changes.questions = nextQuestions;
      if (asOf !== task.spec.asOf.slice(0, 10)) changes.asOf = `${asOf}T23:59:59.999+08:00`;
      if (annual) {
        const periods: NonNullable<ResearchTaskRevisionChanges['periods']> = [annualPeriod(beforeYear, task.spec.periods[0]), annualPeriod(afterYear, task.spec.periods[1])];
        if (periods.some((period, index) => period.id !== task.spec.periods[index].id || period.start !== task.spec.periods[index].start || period.end !== task.spec.periods[index].end)) changes.periods = periods;
      }
      if (!Object.keys(changes).length) throw new Error('没有需要提交的改动');
      const payload = { expectedRequestRevision: task.requestRevision, expectedPlanRevision: task.planRevision, changes };
      const storageKey = `financial-research-revision:${task.id}:${task.requestRevision}`;
      const saved = sessionStorage.getItem(storageKey);
      const entry = saved ? JSON.parse(saved) as { signature: string; key: string } : null;
      const signature = JSON.stringify(payload);
      const requestKey = entry?.signature === signature ? entry.key : crypto.randomUUID();
      sessionStorage.setItem(storageKey, JSON.stringify({ signature, key: requestKey }));
      setBusy(true);
      await researchApi(`tasks/${task.id}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey }, body: JSON.stringify(payload) });
      sessionStorage.removeItem(storageKey);
      onAccepted();
    } catch (error) { onError(error instanceof Error ? error.message : '计划修改失败'); }
    finally { setBusy(false); }
  }

  return <details className="border-t pt-4">
    <summary className="cursor-pointer text-sm font-medium text-emerald-900">修改研究计划</summary>
    <form onSubmit={submit} className="mt-4 space-y-4">
      <fieldset disabled={busy} className="space-y-3">
        <legend className="mb-2 text-xs text-slate-500">研究问题</legend>
        {task.spec.questions.map((question, index) => <label key={question.id} className="block space-y-1.5 text-xs text-slate-600">
          <span>{question.id === 'income_profit' ? '收入与利润' : question.id === 'cash_flow' ? '经营现金流' : '风险披露'}</span>
          <textarea required maxLength={1000} value={questions[index]} onChange={event => setQuestions(current => current.map((value, i) => i === index ? event.target.value : value))} rows={2} className="block w-full resize-y rounded-md border border-slate-200 p-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-emerald-700" />
        </label>)}
      </fieldset>
      {annual ? <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1.5 text-xs text-slate-600"><span>前期年报</span><input type="number" required min="2000" max="2099" value={beforeYear} onChange={event => setBeforeYear(event.target.value)} className="block w-full rounded-md border border-slate-200 p-2 text-sm" /></label>
        <label className="space-y-1.5 text-xs text-slate-600"><span>后期年报</span><input type="number" required min="2001" max="2099" value={afterYear} onChange={event => setAfterYear(event.target.value)} className="block w-full rounded-md border border-slate-200 p-2 text-sm" /></label>
      </div> : <p className="text-xs leading-5 text-slate-500">当前非年度区间可修改问题与资料截止日；区间调整请创建新任务。</p>}
      <label className="block space-y-1.5 text-xs text-slate-600"><span>资料截止日期</span><input type="date" required value={asOf} onChange={event => setAsOf(event.target.value)} className="block w-full rounded-md border border-slate-200 p-2 text-sm" /></label>
      <p className="text-xs leading-5 text-slate-500">公司身份和累计预算保持不变。更换公司请创建新任务；修订会使当前执行失效并沿用本任务原始截止时间与剩余预算。</p>
      <button disabled={busy} className="flex min-h-9 items-center justify-center gap-2 rounded-md bg-emerald-900 px-3 py-2 text-sm text-white disabled:opacity-50">{busy && <Loader2 size={15} className="animate-spin" />}提交修订并重新研究</button>
    </form>
  </details>;
}
