'use client';
import type { FinancialTask } from './workbench-state';
import { financialStatusLabels, isFinancialTerminal } from './workbench-state';
import { ResearchPlanEditor } from './ResearchPlanEditor';
export function ResearchProgress({task, connected, cancelPending, onCancel, onStart, onRevise, onError}: {task: FinancialTask; connected: boolean; cancelPending: boolean; onCancel: () => void; onStart: () => void; onRevise: () => void; onError: (message: string) => void}) {
  const stepLabel = (id: string) => {
    const status = task.checkpoint?.steps[id] || 'pending';
    if (isFinancialTerminal(task.status) && status === 'running') return '已停止';
    if (isFinancialTerminal(task.status) && status === 'pending') return '未执行';
    return ({ pending: '待执行', running: '进行中', completed: '已完成', partial: '待补证' } as Record<string, string>)[status];
  };
  return <aside className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5">
    <div className="flex items-center justify-between"><h2 className="font-semibold">研究计划</h2><span className="rounded-md bg-slate-100 px-2 py-1 text-xs">{financialStatusLabels[task.status]}</span></div>
    <div role="status" aria-live="polite" className="rounded-xl bg-slate-50 p-3 text-xs leading-6 text-slate-600"><p>计划 v{task.planRevision} · {task.usage.toolCalls}/{task.spec.budget.maxToolCalls} 次工具调用</p><p>{task.status === 'queued' ? task.report && task.report.requestRevision < task.requestRevision ? `修订 v${task.requestRevision} 已接收，等待新版本执行。` : '已排队，等待研究 Worker 接取。' : task.checkpoint?.observations.at(-1)?.tool ? `最近动作：${task.checkpoint.observations.at(-1)?.tool}` : isFinancialTerminal(task.status) ? '研究已结束，保留当前证据。' : '从原始财报开始查证。'}</p>{!connected && !isFinancialTerminal(task.status) && <p className="text-amber-800">连接中断，正在恢复最新状态…</p>}{task.checkpoint?.stopReason && <p className="text-amber-800">{task.checkpoint.stopReason}</p>}</div>
    {task.status === 'draft' ? <button onClick={onStart} className="w-full rounded-lg bg-emerald-900 px-3 py-2 text-sm text-white">执行三问研究</button> : !isFinancialTerminal(task.status) && <button onClick={onCancel} disabled={cancelPending} className="w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-50">{cancelPending ? '正在停止…' : '停止研究'}</button>}
    {task.status !== 'cancelled' && <ResearchPlanEditor key={`${task.id}:${task.requestRevision}`} task={task} onAccepted={onRevise} onError={onError} />}
    <ol className="space-y-4">{task.spec.questions.map((q, i) => <li key={q.id}><p className="text-sm font-medium">{i + 1}. {q.text}</p><ul className="mt-2 space-y-2 border-l border-slate-200 pl-3 text-xs text-slate-500">{task.plan?.steps.filter(s => s.questionId === q.id).map(s => <li key={s.id} className="flex items-start justify-between gap-2"><span>{s.title.split(' · ').at(-1)}</span><span className="shrink-0">{stepLabel(s.id)}</span></li>) || <li>执行后生成检索、比较、核验和报告步骤</li>}</ul></li>)}</ol>
    <section className="border-t pt-4"><h3 className="mb-3 text-sm font-medium">研究资料 · {task.documents.length} 个版本</h3>{task.documents.length ? <ul className="space-y-3 text-xs text-slate-500">{task.documents.map(d => <li key={`${d.id}-${d.version}`}><p className="break-words text-slate-700">{d.title}</p><p className="mt-1">v{d.version} · {({ ready: '已解析', acquired: '待解析', partial: '部分可读', unreadable: '不可用', parse_pending: '解析中' } as Record<string, string>)[d.state]} · {d.disclosure.status === 'verified' ? '披露时间已核实' : '披露时间待核实'}</p></li>)}</ul> : <p className="text-xs text-slate-500">尚未导入财报，研究器将查找官方公告。</p>}</section>
    <details className="border-t pt-4 text-xs text-slate-500"><summary className="cursor-pointer">运行用量</summary><p className="mt-2 leading-6">输入 {task.usage.inputTokens ?? '未知'} / 输出 {task.usage.outputTokens ?? '未知'} Token；{task.usage.unknownModelRequests} 次请求用量未完整确认。费用未知。</p></details>
  </aside>;
}
