'use client';
import { useEffect, useRef, useState } from 'react';
import { X, ExternalLink } from 'lucide-react';
import type { readResearchSource } from '@/lib/company-research/source-reader';
import { safeResearchUrl, type SourceSelection } from '@/lib/company-research/reader-contracts';
import { researchApi } from './useFinancialResearch';
type Source = Awaited<ReturnType<typeof readResearchSource>>;
export function EvidenceReader({ taskId, selection, onClose }: {taskId: string; selection: SourceSelection; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null), [source, setSource] = useState<Source | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current; element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setSource(null); setError('');
    const q = new URLSearchParams(Object.entries(selection).map(([k, v]) => [k, String(v)]));
    void researchApi<{source: Source}>(`tasks/${taskId}/source?${q}`, { signal: controller.signal }).then(r => { if (!controller.signal.aborted) setSource(r.source); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [taskId, selection]);
  const loc = source?.citation.locator, url = source ? safeResearchUrl(source.document.url) : null;
  return <dialog ref={dialog} onCancel={onClose} onClose={() => { if (!dialog.current?.open) onClose(); }} aria-labelledby="source-reader-title" className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-2xl overflow-y-auto border-l border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/35">
    <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-5 py-4"><h2 id="source-reader-title" className="font-semibold">证据原文</h2><button autoFocus onClick={() => dialog.current?.close()} aria-label="关闭证据阅读器" className="rounded-lg p-2 hover:bg-slate-100"><X size={20} /></button></div>
    <div className="space-y-5 p-5 sm:p-7">{error ? <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">无法读取该版本原文：{error}</p> : !source ? <p role="status" className="text-sm text-slate-500">正在核对来源版本并加载原文…</p> : <>
      <div><h3 className="text-lg font-semibold">{source.document.title}</h3><p className="mt-2 text-sm text-slate-600">来源版本 {source.document.version} · {loc?.kind === 'html' ? 'HTML 文本块' : `文件第 ${loc?.filePage} 页`}{loc?.kind === 'table' ? ` · 表格第 ${loc.row + 1} 行 / ${loc.column + 1} 列` : ''}</p><p className="mt-2 text-xs text-slate-500">披露时间：{source.document.disclosure.status === 'unknown' ? `未核实 · ${source.document.disclosure.reason}` : source.document.disclosure.precision === 'date' ? `${source.document.disclosure.on}（上海日期）` : new Date(source.document.disclosure.at).toLocaleString('zh-CN')}</p></div>
      <div className={`rounded-xl p-4 text-xs leading-6 ${source.quality === 'native' ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`}><p>原文片段已核对 · {source.quality === 'native' ? '原生文本' : 'OCR / 表格内容待复核'}</p><p>结论语义：{source.verification.semantic === 'supported' ? '证据支持' : source.verification.semantic === 'conflict' ? '证据冲突' : '尚未完成'}</p><p>{source.verification.reason}</p>{source.verification.independence && <p>审查方式：{source.verification.independence === 'human' ? '人工' : '同模型的独立调用'}</p>}</div>
      <section><h3 className="mb-2 text-sm font-semibold">报告引用</h3><blockquote className="whitespace-pre-wrap break-words border-l-2 border-emerald-600 pl-4 text-sm leading-7">{source.citation.quote}</blockquote></section>
      <section><h3 className="mb-2 text-sm font-semibold">定位上下文</h3><p className="mb-3 text-xs text-slate-500">{source.highlight ? '标黄部分为原文中的逐字匹配。' : '引用经空白归一核对；当前显示页或块文本，无法逐字标黄。'}{!source.coordinate && '该来源没有坐标，使用页码与文本定位。'}</p><pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border bg-slate-50 p-4 font-sans text-sm leading-7">{source.highlight ? <>{source.text.slice(0, source.highlight.start)}<mark className="bg-yellow-200 text-slate-900">{source.text.slice(source.highlight.start, source.highlight.end)}</mark>{source.text.slice(source.highlight.end)}</> : source.text}</pre>{source.truncated && <p className="mt-2 text-xs text-slate-500">上下文已按引用截取，可下载原件查看完整资料。</p>}</section>
      {source.table && <section><h3 className="mb-2 text-sm font-semibold">解析表格</h3><div className="overflow-x-auto"><table className="w-full border-collapse text-xs"><tbody>{Array.from({ length: source.table.rows }, (_, row) => <tr key={row}>{source.table!.cells.filter(c => c.row === row).map(c => <td key={c.column} rowSpan={c.rowSpan} colSpan={c.columnSpan} className={`border p-2 ${source.selectedCell?.row === c.row && source.selectedCell.column === c.column ? 'bg-yellow-200' : ''}`}>{c.text}</td>)}</tr>)}</tbody></table></div></section>}
      <div className="flex flex-wrap gap-3 text-sm"><a className="rounded-lg border px-3 py-2 hover:bg-slate-50" href={`/api/company-research/tasks/${taskId}/documents/${encodeURIComponent(source.document.id)}/${source.document.version}?content=original`}>下载此版本原件</a>{url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 hover:bg-slate-50">来源网站<ExternalLink size={14} /></a>}</div>
      <details className="text-xs text-slate-500"><summary className="cursor-pointer">来源完整性与定位详情</summary><p className="mt-2 break-all leading-6">SHA-256：{source.document.bytesSha256}</p><p className="mt-2 break-all leading-6">{JSON.stringify(source.citation.locator)}</p>{source.coordinate && <p className="mt-2">解析器提供的归一坐标：{JSON.stringify(source.coordinate)}</p>}</details>
    </>}</div>
  </dialog>;
}
