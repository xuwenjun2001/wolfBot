import type { ResearchState, Source } from './contracts';
import { hash } from './evidence';
import { deepSeekTools, marketGet } from './connectors';

export interface Filing { title: string; url: string; detailUrl?: string; publishedAt: string; period: string; type: 'annual' | 'interim' | 'quarter'; summary: boolean; correction: boolean; relatedUrls?: string[] }
export interface SearchRecord { provider?: 'deepseek'; question: string; strategy: string; evidenceHash: string; results: { title: string; url: string; snippet: string }[] }
export function companyMatch(state: ResearchState, text: string) { return text.includes(state.company.name) || text.includes(state.company.symbol.slice(0, 6)); }
export async function companyFilings(state: ResearchState, page: number, signal: AbortSignal) {
  const data = await marketGet(`events/announcements/${encodeURIComponent(state.company.symbol)}?limit=100&page=${page}`, signal) as { announcements?: { title: string; symbol?: string; pdf_url?: string; url?: string; notice_date?: string }[]; has_more?: boolean };
  const filings: Filing[] = [];
  for (const item of data.announcements || []) {
    if (!item.notice_date || item.notice_date.slice(0, 10) > state.asOf.slice(0, 10) || !/年度报告|半年度报告|季度报告/.test(item.title)) continue;
    if (item.symbol && item.symbol.slice(0, 6) !== state.company.symbol.slice(0, 6)) continue;
    const period = item.title.match(/20\d{2}/)?.[0]; const url = item.pdf_url || item.url;
    if (!period || !url) continue;
    filings.push({ title: item.title, url, detailUrl: item.url, publishedAt: item.notice_date, period,
      type: /半年度/.test(item.title) ? 'interim' : /季度/.test(item.title) ? 'quarter' : 'annual', summary: /摘要/.test(item.title), correction: /更正|修订|更新/.test(item.title) });
  }
  state.filings = [...new Map([...(state.filings || []), ...filings].map(f => [f.url, f])).values()];
  const quarter = (title: string) => title.match(/第?[一二三四1234]季度/)?.[0] || '';
  for (const f of state.filings) f.relatedUrls = state.filings.filter(other => other.url !== f.url && other.period === f.period && other.type === f.type && (f.type !== 'quarter' || quarter(other.title) === quarter(f.title))).map(other => other.url);
  state.discoveries ??= {};
  for (const f of filings) state.discoveries[f.url] = { title: f.title, publishedAt: f.publishedAt };
  return { page, hasMore: data.has_more ?? (data.announcements?.length === 100), filings: filings.sort((a, b) => Number(a.summary) - Number(b.summary) || b.publishedAt.localeCompare(a.publishedAt)), instruction: '优先读取最新年度报告全文与最新定期报告。更正文件与同期间原件一起核查；本页未找到时调用下一页。' };
}
export function verifyFiling(state: ResearchState, source: Source, filing?: Filing) {
  if (!filing) return;
  const opening = source.content.slice(0, 4000).replace(/\s+/g, '');
  const reportType = filing.type === 'annual' ? '年度报告' : filing.type === 'interim' ? '半年度报告' : '.{0,8}季度报告';
  if (!companyMatch(state, opening) || !new RegExp(`${filing.period}年?${reportType}`).test(opening)) throw new Error('正文未通过公司身份、报告年份或文件类型核验；不可作为原始财报证据');
}
export async function searchCompany(state: ResearchState, input: { query: string; question?: string; domains?: string[] }, signal: AbortSignal) {
  state.searchHistory ??= {};
  const query = input.query.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const domains = [...new Set((input.domains || []).map(domain => domain.toLowerCase()))].sort();
  const key = hash({ provider: 'deepseek', query: query.toLowerCase(), domains });
  const cached = state.searchHistory[key]; if (cached) return { ...cached, cached: true, instruction: '缓存命中；请使用新章节或切换检索路径，不要重复查询。' };
  const question = input.question || 'general'; const strategy = domains.length ? domains.join(',') : 'general';
  const evidenceHash = hash(state.evidence?.[question] || null);
  const prior = Object.values(state.searchHistory).filter(r => r.provider === 'deepseek' && r.question === question).slice(-2);
  if (prior.length === 2 && prior.every(r => r.evidenceHash === evidenceHash && r.strategy === strategy)) throw new Error('该问题连续两次无新增证据：必须切换路径。请调用公告接口，或设置不同的 domains 限定可靠网站，再用短查询检索。');
  // DeepSeek's before: is exclusive; use the next day to retain the inclusive research cutoff.
  const before = new Date(`${state.asOf.slice(0, 10)}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() + 1);
  const searchQuery = [query, domains.map(domain => `site:${domain}`).join(' OR '), `before:${before.toISOString().slice(0, 10)}`].filter(Boolean).join(' ');
  if (Array.from(searchQuery).length > 128) throw new Error('DeepSeek 搜索词连同域名和日期条件最多 128 个字符，请缩短 query 或减少 domains 后重试');
  const data = await deepSeekTools('search', { query: searchQuery, count: 5, need_content: false }, signal) as { results?: { title: string; url: string; summary?: string; snippet?: string; content?: string; date?: string | null }[] };
  state.discoveries ??= {};
  const results: SearchRecord['results'] = []; let rejected = 0;
  for (const result of data.results || []) {
    try {
      const url = new URL(result.url);
      if (!['http:', 'https:'].includes(url.protocol) || (domains.length && !domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)))) { rejected++; continue; }
      const snippet = result.summary || result.snippet || result.content || '';
      const text = `${result.title} ${snippet}`;
      const matches = companyMatch(state, text);
      if (/youtube\.com|play\.google\.com|tiktok\.com/.test(url.hostname) || (!matches && (/\d{6}|股份有限公司|基金|洗碗|游戏|视频/.test(text)))) { rejected++; continue; }
      const date = result.date ? new Date(result.date) : null;
      const publishedAt = date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
      if (publishedAt && publishedAt.slice(0, 10) > state.asOf.slice(0, 10)) { rejected++; continue; }
      state.discoveries[url.href] = { title: result.title, publishedAt };
      results.push({ title: result.title, url: url.href, snippet: snippet.slice(0, 1400) });
    } catch { rejected++; }
  }
  state.searchHistory[key] = { provider: 'deepseek', question, strategy, evidenceHash, results };
  return { results, rejected, cached: false, strategy, strategyChanged: !!prior.length && prior.at(-1)?.strategy !== strategy, instruction: results.length ? '摘要仅供发现资料。正文必须核对研究对象。' : '没有相关候选；换公告接口或域名，不读取无关材料。' };
}
