'use client';
import { useEffect, useRef, useState } from 'react';
import type { ResearchReportDiff } from '@/lib/company-research/revision-contracts';
import type { ResearchReportHistoryEntry } from '@/lib/company-research/report-update-store';
import type { ResearchReportRevision } from '@/lib/company-research/revision-contracts';
import type { SourceSelection } from '@/lib/company-research/reader-contracts';
import { researchApi } from './useFinancialResearch';
import { financialStatusLabels, isFinancialTerminal, type FinancialTask } from './workbench-state';

const metricLabels: Record<string, string> = { revenue: '营业收入', parent_net_profit: '归母净利润', operating_cash_flow: '经营现金流净额', total_operating_income: '营业总收入' };
const claimStatusLabels = { supported: '新增支持', revised: '结论修订', withdrawn: '结论撤回', unchanged: '保持不变' };
type HistoricalView = { report: ResearchReportRevision; spec: NonNullable<FinancialTask['reportSpec']>; changes: FinancialTask['changes']; diff: ResearchReportDiff | null };

function factValue(fact: ResearchReportDiff['facts'][number]['before']) {
  if (!fact) return '无';
  if (fact.value.status === 'known') return fact.normalization?.normalizedYuan ? `${fact.normalization.normalizedYuan} 元` : `${fact.value.raw} ${fact.value.unit}`;
  return fact.value.status === 'missing' ? `缺失：${fact.value.reason}` : `冲突：${fact.value.reason}`;
}
function ReportDiffView({ diff }: { diff: ResearchReportDiff | null }) {
  if (!diff) return null;
  if (diff.status === 'unchanged') return <section className="border-t pt-4 text-xs text-slate-600"><h3 className="font-medium">v{diff.fromRevision} → v{diff.toRevision}：没有实质差异</h3><p className="mt-1">数字、结论和引用保持不变。</p></section>;
  const factChanges = diff.facts.filter(item => item.status !== 'unchanged'), claimChanges = diff.claims.filter(item => item.status !== 'unchanged');
  return <section className="border-t pt-4"><h3 className="text-sm font-medium">报告差异 · v{diff.fromRevision} → v{diff.toRevision}</h3>
    <p className="mt-1 text-xs text-slate-500">资料截止 {new Date(diff.asOf.before).toLocaleDateString('zh-CN')} → {new Date(diff.asOf.after).toLocaleDateString('zh-CN')}</p>
    {!!factChanges.length && <div className="mt-3"><h4 className="text-xs font-medium text-slate-700">数字变化</h4><ul className="mt-2 space-y-2">{factChanges.map(item => <li key={item.key} className="border-l-2 border-emerald-700 pl-3 text-xs leading-5"><p className="font-medium">{metricLabels[item.metric]} · {item.periodId} · {item.status === 'added' ? '新增' : item.status === 'withdrawn' ? '撤回' : '修订'}</p><p className="text-slate-600">{factValue(item.before)} → {factValue(item.after)}</p><p className="text-slate-500">{item.reason}</p></li>)}</ul></div>}
    {!!claimChanges.length && <div className="mt-4"><h4 className="text-xs font-medium text-slate-700">结论变化</h4><ul className="mt-2 space-y-3">{claimChanges.map(item => <li key={item.id} className="break-words border-l-2 border-amber-500 pl-3 text-xs leading-5"><p className="font-medium">{claimStatusLabels[item.status]} · {item.questionId}</p>{item.before && <p className="mt-1 text-slate-500">旧：{item.before.text}</p>}{item.after && <p className="mt-1 text-slate-700">新：{item.after.text}</p>}<p className="mt-1 text-slate-500">{item.reason}</p></li>)}</ul></div>}
    {(diff.evidence.added.length > 0 || diff.evidence.removed.length > 0) && <div className="mt-4"><h4 className="text-xs font-medium text-slate-700">引用来源变化</h4><ul className="mt-2 space-y-1 text-xs text-slate-600">{diff.evidence.added.map((item, index) => <li key={`added-${index}`}>新增 {item.documentId} v{item.documentVersion} · {item.bytesSha256.slice(0, 12)}</li>)}{diff.evidence.removed.map((item, index) => <li key={`removed-${index}`}>移除 {item.documentId} v{item.documentVersion} · {item.bytesSha256.slice(0, 12)}</li>)}</ul></div>}
  </section>;
}

export function ResearchReport({ task, onSource, onAccept, accepting }: {task: FinancialTask; onSource: (selection: SourceSelection) => void; onAccept: () => void; accepting: boolean}) {
  const [history, setHistory] = useState<ResearchReportHistoryEntry[]>([]), [latestDiff, setLatestDiff] = useState<ResearchReportDiff | null>(null);
  const [historicalView, setHistoricalView] = useState<HistoricalView | null>(null), [viewRevision, setViewRevision] = useState<number | null>(task.reportRevision || null);
  const [loadingRevision, setLoadingRevision] = useState<number | null>(null), [historyError, setHistoryError] = useState('');
  const requestSequence = useRef(0), taskId = task.id, latestRevision = task.reportRevision || 0;
  const revisionRequests = useRef(new Set<AbortController>());
  useEffect(() => {
    const controller = new AbortController(), sequence = ++requestSequence.current;
    const pending = revisionRequests.current;
    setViewRevision(latestRevision || null); setHistoricalView(null); setHistoryError(''); setLatestDiff(null); setHistory([]); setLoadingRevision(null);
    void researchApi<{ reports: ResearchReportHistoryEntry[] }>(`tasks/${taskId}/reports/history`, { signal: controller.signal })
      .then(result => { if (sequence === requestSequence.current) setHistory(result.reports); })
      .catch(error => { if (!controller.signal.aborted && sequence === requestSequence.current) setHistoryError(error instanceof Error ? error.message : '报告历史读取失败'); });
    if (latestRevision > 1) void researchApi<{ diff: ResearchReportDiff | null }>(`tasks/${taskId}/reports/${latestRevision}/diff`, { signal: controller.signal })
      .then(result => { if (sequence === requestSequence.current) setLatestDiff(result.diff); })
      .catch(error => { if (!controller.signal.aborted && sequence === requestSequence.current) setHistoryError(error instanceof Error ? error.message : '报告差异读取失败'); });
    return () => { controller.abort(); pending.forEach(request => request.abort()); pending.clear(); };
  }, [taskId, latestRevision]);

  async function selectRevision(revision: number) {
    const sequence = ++requestSequence.current;
    setLoadingRevision(revision); setHistoryError('');
    if (revision === latestRevision) { setViewRevision(revision); setHistoricalView(null); setLoadingRevision(null); return; }
    const controller = new AbortController(); revisionRequests.current.add(controller);
    try {
      const [snapshot, diff] = await Promise.all([
        researchApi<{ report: ResearchReportRevision; spec: NonNullable<FinancialTask['reportSpec']>; changes: FinancialTask['changes'] }>(`tasks/${taskId}/reports/${revision}`, { signal: controller.signal }),
        revision > 1 ? researchApi<{ diff: ResearchReportDiff | null }>(`tasks/${taskId}/reports/${revision}/diff`, { signal: controller.signal }) : Promise.resolve({ diff: null }),
      ]);
      if (!controller.signal.aborted && sequence === requestSequence.current) { setViewRevision(revision); setHistoricalView({ ...snapshot, diff: diff.diff }); }
    } catch (error) { if (!controller.signal.aborted && sequence === requestSequence.current) setHistoryError(error instanceof Error ? error.message : '历史报告读取失败'); }
    finally { revisionRequests.current.delete(controller); if (!controller.signal.aborted && sequence === requestSequence.current) setLoadingRevision(null); }
  }

  const report = historicalView?.report || task.report, currentSpec = historicalView?.spec || (report && task.reportSpec ? task.reportSpec : task.spec);
  const reportRevision = historicalView?.report.revision || report?.revision || 0;
  const reportIsCurrent = !!report && reportRevision === task.reportRevision && report.requestRevision === task.requestRevision;
  const claims = report?.claims || task.checkpoint?.claims || [], changes = historicalView?.changes || task.changes;
  const diff = historicalView ? historicalView.diff : latestDiff;
  const sourceButtons = (id: string, kind: 'factId' | 'claimId', count: number) => Array.from({ length: count }, (_, citationIndex) => <button key={citationIndex} onClick={() => onSource({ reportRevision, [kind]: id, citationIndex })} className="ml-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-900 hover:bg-emerald-100" aria-label={`查看${kind === 'factId' ? '金额' : '结论'} ${id} 的原文 ${citationIndex + 1}`}>原文 {citationIndex + 1}</button>);
  return <article className="min-w-0 space-y-7 rounded-2xl border border-slate-200 bg-white p-5 sm:p-7">
    <div><p className="text-xs font-semibold text-emerald-800">财报变化研究 · {report ? financialStatusLabels[report.status] : isFinancialTerminal(task.status) ? `${financialStatusLabels[task.status]} · 保留草稿` : '研究草稿'}</p><h2 className="mt-2 text-2xl font-semibold">{currentSpec.company.name} <span className="text-sm font-normal text-slate-500">{currentSpec.company.symbol}</span></h2><p className="mt-3 text-sm text-slate-600">{currentSpec.periods[0].end.slice(0, 4)} → {currentSpec.periods[1].end.slice(0, 4)} · {currentSpec.scope === 'consolidated' ? '合并口径' : '母公司口径'}</p><p className="mt-1 text-xs text-slate-500">资料截止 {new Date(currentSpec.asOf).toLocaleString('zh-CN')} · {report ? `报告 v${reportRevision}` : '结果尚在核查'}</p>
      {report && !reportIsCurrent && <p role="status" className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-950">{report.requestRevision === task.requestRevision ? `正在查看历史报告 v${reportRevision}，当前报告为 v${task.reportRevision}。` : `当前请求已更新至 v${task.requestRevision}。这里保留的是请求 v${report.requestRevision} 的报告。`}资料截止 {new Date(report.asOf).toLocaleString('zh-CN')}。</p>}
      {report?.status === 'completed' && reportIsCurrent && <p className="mt-3 text-xs text-emerald-800">结构、数字与语义核验已通过。语义方式：{report.method?.semanticReview === 'human' ? '人工审查' : report.method?.semanticReview === 'separate_call_same_model' ? '同模型独立调用审查' : '未完成'}；研究结果供辅助判断。</p>}
    </div>
    {history.length > 0 && <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">报告版本历史 · {history.length}</summary><ol className="mt-3 space-y-1">{history.map(item => <li key={item.revision}><button type="button" disabled={loadingRevision !== null} onClick={() => void selectRevision(item.revision)} aria-current={viewRevision === item.revision ? 'true' : undefined} className={`w-full rounded-md px-3 py-2 text-left text-xs hover:bg-slate-50 disabled:opacity-50 ${viewRevision === item.revision ? 'bg-emerald-50 text-emerald-950' : 'text-slate-600'}`}>
      <span className="font-medium">报告 v{item.revision}</span> · {financialStatusLabels[item.status]} · 请求 v{item.requestRevision} · {new Date(item.asOf).toLocaleDateString('zh-CN')}<span className="mt-1 block font-mono text-[10px] text-slate-400">{item.hash.slice(0, 16)}</span>
    </button></li>)}</ol>{historyError && <p role="alert" className="mt-2 text-xs text-red-800">{historyError}</p>}</details>}
    {report?.status === 'completed' && reportIsCurrent && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{task.acceptance?.reportRevision === reportRevision ? <p>此版本已由你核对数字和解释并验收 · {new Date(task.acceptance.reviewedAt).toLocaleString('zh-CN')}</p> : <><p className="mb-3 text-xs leading-6">自动核验已完成，等待人工验收。请打开原文核对关键数字和三问解释。</p><button disabled={accepting || !task.reportHash} onClick={onAccept} className="rounded-md border border-emerald-700 bg-white px-3 py-2 text-xs disabled:opacity-50">{accepting ? '正在记录…' : '我已核对原文，确认此版本'}</button></>}</div>}
    <ReportDiffView diff={diff} />
    <section aria-labelledby="changes-title"><h3 id="changes-title" className="mb-3 font-semibold">两期变化</h3><p className="mb-3 text-xs text-slate-500">金额单位：人民币元；增幅由已核查原始金额计算。</p><div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><caption className="sr-only">两期财务指标和引用</caption><thead><tr className="border-b text-xs text-slate-500"><th className="py-3 pr-3">指标</th>{currentSpec.periods.map(period => <th key={period.id} className="pr-3">{period.id}</th>)}<th>增幅</th></tr></thead><tbody>{changes.map(row => <tr key={row.metric} className="border-b border-slate-100"><th className="py-4 pr-3 text-xs font-medium">{metricLabels[row.metric]}</th>{[row.before, row.after].map((fact, index) => <td key={index} className="py-3 pr-4 align-top"><span className="block font-mono text-xs">{fact?.normalization?.normalizedYuan || (fact?.value.status === 'known' && fact.value.unit === 'yuan' ? fact.value.raw : '待核查')}</span>{fact && sourceButtons(fact.id, 'factId', fact.citations.length)}</td>)}<td className="text-xs">{row.comparison?.status === 'comparable' ? row.comparison.percentage === null ? '零基数，不计算' : `${row.comparison.percentage}%` : '不可计算'}</td></tr>)}</tbody></table></div></section>
    {currentSpec.questions.map((question, index) => <section key={question.id} aria-labelledby={`question-${question.id}`}><h3 id={`question-${question.id}`} className="mb-3 font-semibold"><span className="mr-2 text-emerald-700">0{index + 1}</span>{question.text}</h3><div className="space-y-3">{claims.filter(claim => claim.questionId === question.id).map(claim => <div key={claim.id} className={`rounded-md border p-4 text-sm leading-7 ${claim.status === 'supported' && report ? 'border-slate-200' : 'border-amber-200 bg-amber-50/50'}`}><div className="mb-2 flex flex-wrap gap-2 text-xs"><span className="rounded bg-slate-100 px-2 text-slate-600">{claim.kind === 'fact' ? '事实' : claim.kind === 'inference' ? '分析推断' : '观点'}</span><span className="text-slate-500">{claim.status === 'supported' ? report ? '证据支持' : '待核验草稿' : claim.status === 'conflict' ? '证据冲突' : claim.status === 'incomparable' ? '不可比较' : '证据不足'}</span></div><p className="whitespace-pre-wrap break-words">{claim.text}</p>{claim.reason && <p className="mt-2 text-xs text-amber-900">{claim.reason}</p>}<div className="mt-3 flex flex-wrap gap-y-2">{sourceButtons(claim.id, 'claimId', claim.citations.length)}</div></div>)}{!claims.some(claim => claim.questionId === question.id) && <p className="text-sm text-slate-500">{isFinancialTerminal(task.status) ? '此问题未形成可核查结论。' : '正在查找资料，尚未形成可核查结论。'}</p>}</div></section>)}
    {!!report?.gaps.length && <section className="rounded-md bg-amber-50 p-4"><h3 className="mb-2 text-sm font-semibold text-amber-900">未解决事项</h3><ul className="list-disc space-y-2 pl-4 text-xs leading-6 text-amber-900">{report.gaps.map((gap, index) => <li key={index}>{gap.message}</li>)}</ul></section>}
    {report?.method && <details className="text-xs text-slate-500"><summary className="cursor-pointer">研究方法与版本</summary><p className="mt-2 break-words leading-6">模型 {report.method.model} · Skill {report.method.skillVersion} · 工具 {report.method.toolVersion} · 合同 {report.method.contractVersion}</p></details>}
  </article>;
}
