import { z } from 'zod';
import { claimSchema, emptyReport, sectionKeys, type ResearchState } from './contracts';
import { coverage, hash, salvageReport } from './evidence';

export const questions = {
  products: ['business', '主要产品与收入来源', true],
  revenueMix: ['business', '最新年报收入结构', true],
  upstream: ['supplyChain', '主要原材料、能源和设备', true],
  downstream: ['supplyChain', '下游行业及应用', true],
  partners: ['supplyChain', '具体客户、供应商及集中度', false],
  reportingPeriod: ['financials', '最新已披露报告期', true],
  revenue: ['financials', '最新营收、同比及口径', true],
  profit: ['financials', '最新归母利润、同比及口径', true],
  cashflow: ['financials', '最新经营现金流总额、同比及口径', true],
} as const;
export type Question = keyof typeof questions;
export const evidenceSchema = z.object({
  question: z.enum(Object.keys(questions) as [Question, ...Question[]]),
  status: z.enum(['answered', 'not_disclosed', 'not_found', 'fetch_failed', 'conflict']),
  text: z.string().min(1).max(1800), kind: z.enum(['fact', 'opinion', 'inference']),
  citations: claimSchema.shape.citations.min(0),
  period: z.string().max(100).describe('For current financial questions use the report end date YYYY-MM-DD (latestReportDate). For revenueMix include the annual report year.').optional(),
  metric: z.object({ label: z.string(), value: z.string(), yoy: z.string(), basis: z.string() }).optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export function initializeLedger(state: ResearchState) {
  if (state.version === 2) return;
  // Legacy reports remain visible; only valid claims are retained on active recovery.
  if (state.draft) state.draft = salvageReport(state.draft, state.sources, state.asOf);
  state.version = 2; state.phase = 'investigating'; state.evidence = {}; state.sections = {};
  if (state.draft) {
    for (const [section, question] of [['business','products'],['supplyChain','upstream'],['financials','reportingPeriod']] as const) {
      const claims = state.draft[section].claims;
      if (claims.length) state.evidence[question] = { question, status: 'not_found', kind: 'fact', text: claims.map(c => c.text).join('；').slice(0, 1800), citations: claims.flatMap(c => c.citations).slice(0, 6) };
    }
  }
  if (state.draft) state.notes.push('旧版草稿已保留；新版问题清单需重新核查，调用次数与开始时间不重置。');
}

export function validateEvidence(state: ResearchState, item: Evidence): string[] {
  const required = ['answered', 'not_disclosed'].includes(item.status);
  if (required && !item.citations.length) return [`${item.question}.citations: 必须提供已读取正文的原文引用`];
  const report = emptyReport(''); report.business.claims = item.citations.length ? [{ text: item.text, kind: item.kind, citations: item.citations }] : [];
  const errors = coverage(report, state.sources, state.asOf).errors;
  if (item.status === 'not_disclosed' && item.citations.some(c => state.sources.find(s => s.id === c.sourceId)?.kind === 'financials')) errors.push(`${item.question}.citations: 财务接口缺少字段不等于公司未披露；必须引用原始披露正文`);
  if (required && ['revenueMix', 'reportingPeriod', 'revenue', 'profit', 'cashflow'].includes(item.question) && !item.period) errors.push(`${item.question}.period: 必须注明报告期`);
  if (item.status === 'answered' && ['revenue', 'profit', 'cashflow'].includes(item.question) && !item.metric) errors.push(`${item.question}.metric: 必须提供金额、同比、单位与口径`);
  if (item.question === 'revenueMix' && required) {
    const latest = state.filings?.filter(f => f.type === 'annual').map(f => f.period).sort().at(-1);
    if (latest && item.period?.match(/20\d{2}/)?.[0] !== latest) errors.push(`revenueMix.period: 必须核实最新年报 ${latest}`);
  }
  const date = item.period?.match(/(20\d{2})[年-](\d{1,2})[月-](\d{1,2})/);
  const normalizedDate = date ? `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}` : item.period;
  if (required && ['reportingPeriod','revenue','profit','cashflow'].includes(item.question) && state.latestReportDate && normalizedDate !== state.latestReportDate) errors.push(`${item.question}.period: 请使用最新报告截止日期 ${state.latestReportDate}，不能用旧期间替代`);
  return errors;
}

export function ledgerCoverage(state: ResearchState) {
  const gaps: string[] = [], errors: string[] = [];
  for (const [id, [, label, required]] of Object.entries(questions)) {
    const item = state.evidence?.[id];
    if (item) errors.push(...validateEvidence(state, item));
    if (required && (!item || !['answered', 'not_disclosed'].includes(item.status))) gaps.push(`${label}：${item?.text || '尚未核查'}`);
  }
  return { errors, gaps, complete: !errors.length && !gaps.length,
    questions: Object.entries(questions).map(([id, [, label, required]]) => ({ id, label, required, status: state.evidence?.[id]?.status || 'not_found' })) };
}

export function assembleReport(state: ResearchState) {
  if (!Object.keys(state.evidence || {}).length) return (state.draft ??= emptyReport('尚未记录有效证据'));
  const report = emptyReport(''); report.limitations = []; report.metrics = [];
  for (const key of sectionKeys) report[key] = { claims: [], gaps: [] };
  for (const [id, item] of Object.entries(state.evidence || {})) {
    const [section, label, required] = questions[id as Question];
    const valid = !validateEvidence(state, item).length;
    if (valid && item.citations.length) report[section].claims.push({ text: item.text, kind: item.kind, citations: item.citations });
    if (!valid || !['answered', 'not_disclosed'].includes(item.status)) {
      if (required) report[section].gaps.push(`${label}：${item.text}`);
      else report.limitations.push(`${label}：${item.text}`);
    }
    if (item.status === 'not_disclosed') report.limitations.push(`${label}：来源明确未披露；${item.text}`);
    if (valid && item.metric && item.citations.length) report.metrics.push({ ...item.metric, period: item.period || '', citation: item.citations[0] });
  }
  for (const [id, [section, label, required]] of Object.entries(questions)) if (!state.evidence?.[id]) {
    if (required) report[section].gaps.push(`${label}：尚未核查`);
    else report.limitations.push(`${label}：本次未核查，不据此推测具体合作关系`);
  }
  for (const key of sectionKeys) {
    const order = state.sections?.[key];
    if (order) report[key].claims.sort((a, b) => order.findIndex(id => state.evidence?.[id]?.text === a.text) - order.findIndex(id => state.evidence?.[id]?.text === b.text));
  }
  for (const id of state.sections?.limitations || []) {
    const text = state.evidence?.[id]?.text;
    if (text && !report.limitations.includes(text)) report.limitations.push(text);
  }
  report.overview = (state.sections?.overview || ['products', 'reportingPeriod']).map(id => state.evidence?.[id]?.text).filter(Boolean).join('；').slice(0, 1200) || `${state.company.name}研究草稿，资料仍在核查。`;
  state.draft = report; return report;
}

export function recordEvidence(state: ResearchState, item: Evidence) {
  const errors = validateEvidence(state, item); if (errors.length) throw new Error(`${item.question}: ${errors.join('；')}`);
  state.evidence ??= {}; const changed = hash(state.evidence[item.question] || null) !== hash(item);
  state.evidence[item.question] = item; assembleReport(state); state.lastCoverageHash = null;
  return { evidenceId: item.question, changed, coverage: ledgerCoverage(state) };
}

export function updatePhase(state: ResearchState, maxCalls: number, now = Date.now()) {
  if (state.phase !== 'finalizing' && ((state.deadline || Infinity) - now <= 120000 || maxCalls - state.toolCalls <= 3)) {
    state.phase = 'finalizing'; systemEvent(state, 'finalizing', '进入整理报告阶段，停止新增外部调查。');
  }
}
export function systemEvent(state: ResearchState, id: string, message: string) {
  state.systemEvents ??= [];
  if (!state.systemEvents.some(e => e.id === id)) state.systemEvents.push({ id, at: new Date().toISOString(), message });
}
export function automaticReport(state: ResearchState, reason: string) {
  assembleReport(state); state.stopReason = reason;
  state.draft = salvageReport(state.draft!, state.sources, state.asOf);
  if (!state.draft.limitations.includes(reason)) state.draft.limitations.push(reason);
  systemEvent(state, 'auto-save', `系统已保存已有成果：${reason}`);
}
