import { hash } from './evidence';
import { researchConfig } from './config';
import { boundedJson, downloadPdf, validatePublicUrl } from './network';
import { aShareSymbolPattern, type Company, type Source } from './contracts';

const marketOrigin = () => (process.env.QUANTPILOT_MARKET_API_URL || process.env.QUANTPILOT_MARKET_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
export async function marketGet(path: string, signal?: AbortSignal) {
  return boundedJson(await fetch(`${marketOrigin()}/api/v1/${path}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000), redirect: 'error' }));
}
export async function resolveCompanies(query: string, signal?: AbortSignal): Promise<Company[]> {
  const data = await marketGet(`symbols/resolve?query=${encodeURIComponent(query)}&count=10`, signal) as { results?: { symbol: string; name: string; asset_type: string }[] };
  return [...new Map((data.results || []).filter(c => c.asset_type === 'stock' && aShareSymbolPattern.test(c.symbol))
    .map(c => [c.symbol, { symbol: c.symbol, name: c.name || c.symbol }])).values()];
}
export async function deepSeekTools(operation: 'search' | 'fetch', body: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  const key = researchConfig().searchApiKey;
  if (!key) throw new Error('缺少 COMPANY_RESEARCH_SEARCH_API_KEY 或 DEEPSEEK_API_KEY');
  return boundedJson(await fetch(`https://api.deepseek.com/v1/tools/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(50000)]), redirect: 'error',
  }));
}
export function makeSource(input: Omit<Source, 'id' | 'hash' | 'fetchedAt'>): Source {
  return { ...input, id: `src_${hash(input.url).slice(0, 16)}`, hash: hash(input.content), fetchedAt: new Date().toISOString() };
}

export function financialSourceText(reports: Record<string, unknown>[]): string {
  const amount = (value: unknown) => {
    if (value === null || value === undefined || value === '') return '未披露';
    const n = Number(value); return Number.isFinite(n) ? `${String(value)} 元（${(n / 1e8).toFixed(2)} 亿元）` : '未披露';
  };
  const ratio = (value: unknown) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '未披露' : `${Number(value).toFixed(2)}%`;
  return '来源：东方财富财务摘要接口。金额为人民币；财报指标采用累计口径。接口 revenue 来自 TOTAL_OPERATE_INCOME，口径为营业总收入，不得与单独披露的营业收入混用。每股现金流不能代替现金流总额。\n\n' + reports.map(r => [
    `报告期：${String(r.data_type || '')}，截至 ${String(r.report_date || '').slice(0, 10)}；公告日期：${String(r.notice_date || '').slice(0, 10)}。`,
    `营业总收入（接口口径）：${amount(r.revenue)}；接口披露同比：${ratio(r.revenue_yoy)}。`,
    `归母净利润：${amount(r.parent_net_profit)}；同比：${ratio(r.net_profit_yoy)}。`,
    `加权 ROE：${ratio(r.weighted_roe)}；毛利率：${ratio(r.gross_margin)}。`,
    `每股经营活动现金流：${r.operating_cash_flow_per_share ?? '未披露'} 元/股；经营现金流总额及同比：本接口未提供。`,
  ].join('\n')).join('\n\n');
}
export async function readWebSource(url: string, signal: AbortSignal): Promise<Source> {
  signal.throwIfAborted();
  const validated = await validatePublicUrl(url);
  const canonical = validated.url.href;
  try {
    const data = await deepSeekTools('fetch', { url: canonical }, signal) as { content?: string; title?: string };
    if (data.content && data.content.trim().length >= 100) {
      return makeSource({ url: canonical, title: data.title || canonical, publishedAt: null, content: data.content.slice(0, 350000), kind: 'web' });
    }
  } catch (error) { if (signal.aborted || !new URL(canonical).pathname.toLowerCase().endsWith('.pdf')) throw error; }
  if (!new URL(canonical).pathname.toLowerCase().endsWith('.pdf')) throw new Error('未取得可读正文，请选择其他来源');
  const bytes = await downloadPdf(canonical, AbortSignal.any([signal, AbortSignal.timeout(45000)]));
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: bytes });
  try {
    const parsed = await parser.getText({ first: 100 });
    signal.throwIfAborted();
    const content = parsed.pages.map(page => `[第 ${page.num} 页]\n${page.text}`).join('\n').slice(0, 350000);
    if (content.trim().length < 100) throw new Error('PDF 无可读文本，可能为扫描件');
    return makeSource({ url: canonical, title: canonical.split('/').pop() || '财报 PDF', publishedAt: null, content, kind: 'web' });
  } finally { await parser.destroy(); }
}
