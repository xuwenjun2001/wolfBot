import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyReport, type ResearchState } from './contracts';
import { automaticReport, ledgerCoverage, questions, recordEvidence, updatePhase, type Evidence } from './ledger';
import { companyFilings, searchCompany, verifyFiling } from './discovery';
import { createResearchTools } from './tools';
import { hash } from './evidence';
const mocks = vi.hoisted(() => ({ deepSeekTools: vi.fn(), marketGet: vi.fn(), readWebSource: vi.fn() }));
vi.mock('./connectors', async original => ({ ...await original<typeof import('./connectors')>(), ...mocks }));
function state(): ResearchState { return { version: 2, phase: 'investigating', company: { name: '安迪苏', symbol: '600299' }, asOf: '2026-09-18', sources: [{ id: 'a', url: 'https://example.com/a', title: '安迪苏2025年年度报告', content: '安迪苏2025年年度报告。主要产品是动物营养产品，具体客户名称未披露。', publishedAt: '2026-03-01', fetchedAt: '', kind: 'web', hash: 'a' }], evidence: {}, draft: emptyReport(''), supplementRounds: 0, coverageChecks: 0, lastCoverageHash: null, toolCalls: 0, inputTokens: 0, outputTokens: 0, submitted: false, notes: [] }; }
const item: Evidence = { question: 'products', status: 'answered', text: '主要产品是动物营养产品', kind: 'fact', citations: [{ sourceId: 'a', quote: '主要产品是动物营养产品', locator: '主营业务' }] };
beforeEach(() => vi.clearAllMocks());
describe('research quality policy', () => {
  it('upserts one question and preserves other evidence and report on hard stop', () => {
    const s = state(); recordEvidence(s, item); recordEvidence(s, { ...item, question: 'upstream' }); recordEvidence(s, { ...item, text: '更新产品描述' });
    expect(Object.keys(s.evidence!)).toHaveLength(2); expect(s.evidence!.upstream.text).toBe(item.text);
    automaticReport(s, '运行时间耗尽'); expect(s.draft!.business.claims[0].text).toBe('更新产品描述'); expect(s.submitted).toBe(false); expect(s.systemEvents).toHaveLength(1);
  });
  it('rejects fabricated quotes and unsupported not-disclosed assertions', () => {
    expect(() => recordEvidence(state(), { ...item, citations: [] })).toThrow('原文');
    expect(() => recordEvidence(state(), { ...item, status: 'not_disclosed', citations: [] })).toThrow();
    expect(() => recordEvidence(state(), { ...item, citations: [{ ...item.citations[0], quote: '编造不存在的关系' }] })).toThrow();
    const s = state(); s.sources[0].kind = 'financials';
    expect(() => recordEvidence(s, { ...item, status: 'not_disclosed' })).toThrow('接口缺少字段');
  });
  it('does not require named partners but requires cashflow and current annual period', () => {
    const s = state();
    for (const question of Object.keys(questions) as Evidence['question'][]) if (question !== 'partners') recordEvidence(s, { ...item, question, period: '2025', ...(['revenue','profit','cashflow'].includes(question) ? { metric: { label: question, value: '1亿元', yoy: '1%', basis: '累计' } } : {}) });
    expect(ledgerCoverage(s).complete).toBe(true);
    delete s.evidence!.cashflow; expect(ledgerCoverage(s).complete).toBe(false);
    s.latestReportDate = '2026-06-30';
    expect(() => recordEvidence(s, { ...item, question: 'reportingPeriod', period: '2025-12-31' })).toThrow('2026-06-30');
    s.filings = [{ title: '2025年年度报告', period: '2025', publishedAt: '2026-03-01', type: 'annual', summary: false, correction: false, url: 'https://example.com' }];
    expect(() => recordEvidence(s, { ...item, question: 'revenueMix', period: '2021' })).toThrow('2025');
  });
  it('enters finalizing at the exact boundaries and never reverts', () => {
    const s = state(); s.toolCalls = 36; s.deadline = 200001; updatePhase(s, 40, 80000); expect(s.phase).toBe('investigating');
    updatePhase(s, 40, 80001); expect(s.phase).toBe('finalizing'); s.deadline = 999999; updatePhase(s, 40, 0); expect(s.phase).toBe('finalizing');
    const t = state(); t.toolCalls = 37; updatePhase(t, 40); expect(t.phase).toBe('finalizing');
  });
  it('normalizes excessive keywords, caches identical reads and blocks external calls during finalization', async () => {
    const s = state(); const tool = createResearchTools(s).find(t => t.name === 'read_sources')!;
    const ctx = { runId: 'test', turn: 1, toolCallId: '1', operationId: '1', signal: new AbortController().signal };
    const input = { urls: [s.sources[0].url], focus: Array.from({ length: 12 }, (_, i) => `关键词${i}`) };
    const first = await tool.execute(input, ctx); expect(first.ok && first.data).toMatchObject([{ normalization: { received: 12, used: 8 } }]);
    const again = await tool.execute(input, ctx); expect(again.ok && again.data).toMatchObject([{ cached: true }]);
    expect(mocks.readWebSource).not.toHaveBeenCalled(); s.phase = 'finalizing'; expect((await tool.execute(input, ctx)).ok).toBe(false);
  });
  it('filters unrelated searches, caches duplicates and requires a changed strategy', async () => {
    const s = state(); mocks.deepSeekTools.mockResolvedValue({ results: [{ title: '洗碗机', summary: '家电', url: 'https://example.com/x' }, { title: '安迪苏原材料', url: 'https://example.com/good' }] });
    const signal = new AbortController().signal;
    const a = await searchCompany(s, { query: '安迪苏 原材料', question: 'upstream' }, signal); expect(a.results).toHaveLength(1);
    expect(await searchCompany(s, { query: '安迪苏 原材料', question: 'upstream' }, signal)).toMatchObject({ cached: true });
    await searchCompany(s, { query: '安迪苏 原料', question: 'upstream' }, signal);
    await expect(searchCompany(s, { query: '安迪苏 采购', question: 'upstream' }, signal)).rejects.toThrow('切换');
    await searchCompany(s, { query: '安迪苏 采购', question: 'upstream', domains: ['adisseo.com.cn'] }, signal);
    expect(mocks.deepSeekTools).toHaveBeenCalledTimes(3);
  });
  it('maps DeepSeek summaries and dates, enforcing domain boundaries and the inclusive cutoff', async () => {
    const s = state(); s.asOf = '2026-12-31T12:00:00Z';
    mocks.deepSeekTools.mockResolvedValue({ results: [
      { title: '安迪苏原材料', summary: '主营动物营养产品，上游采购原材料。', date: '2026-12-31T23:59:59Z', url: 'https://www.adisseo.com.cn/report' },
      { title: '安迪苏未来公告', summary: '未公开资料', date: '2027-01-01T00:00:00Z', url: 'https://adisseo.com.cn/future' },
      { title: '安迪苏无关网站', summary: '其他来源', url: 'https://adisseo.com.cn.example.com/report' },
    ] });
    const signal = new AbortController().signal;
    const result = await searchCompany(s, { query: '安迪苏 原材料', domains: ['ADISSEO.COM.CN', 'cninfo.com.cn'] }, signal);
    expect(mocks.deepSeekTools).toHaveBeenCalledWith('search', {
      query: '安迪苏 原材料 site:adisseo.com.cn OR site:cninfo.com.cn before:2027-01-01', count: 5, need_content: false,
    }, signal);
    expect(result.rejected).toBe(2);
    expect(result.results).toEqual([{ title: '安迪苏原材料', url: 'https://www.adisseo.com.cn/report', snippet: '主营动物营养产品，上游采购原材料。' }]);
    expect(s.discoveries!['https://www.adisseo.com.cn/report'].publishedAt).toBe('2026-12-31T23:59:59.000Z');
    expect(s.sources).toHaveLength(1); // Search summaries are not saved as source evidence.
  });
  it('rejects overlong composed queries without dropping the date or domain filters', async () => {
    await expect(searchCompany(state(), { query: '安迪苏'.repeat(35), domains: ['adisseo.com.cn'] }, new AbortController().signal)).rejects.toThrow('128');
    expect(mocks.deepSeekTools).not.toHaveBeenCalled();
  });
  it('counts Unicode characters and retains a query at the exact provider limit', async () => {
    mocks.deepSeekTools.mockResolvedValue({ results: [] });
    const query = '安迪苏 ' + '🌱'.repeat(106); // 110 query characters plus 18 for the date condition.
    await searchCompany(state(), { query }, new AbortController().signal);
    const body = mocks.deepSeekTools.mock.calls[0][1] as { query: string };
    expect(Array.from(body.query)).toHaveLength(128);
    expect(body.query.endsWith('before:2026-09-19')).toBe(true);
  });
  it('refreshes legacy provider caches without treating old searches as failed DeepSeek strategies', async () => {
    const s = state();
    const legacy = { question: 'upstream', strategy: 'general', evidenceHash: hash(null), results: [{ title: '旧资料', url: 'https://example.com/old', snippet: '旧摘要' }] };
    s.searchHistory = { [hash({ query: '安迪苏 原材料', domains: [] })]: legacy, previous: legacy };
    mocks.deepSeekTools.mockResolvedValue({ results: [{ title: '安迪苏原材料', snippet: '新的搜索摘要', date: null, url: 'https://example.com/new' }] });
    const result = await searchCompany(s, { query: '安迪苏 原材料', question: 'upstream' }, new AbortController().signal);
    expect(result.results[0].url).toBe('https://example.com/new');
    expect(mocks.deepSeekTools).toHaveBeenCalledTimes(1);
  });
  it('uses explicit pagination, links corrections and excludes future or other-company announcements', async () => {
    const s = state(); const signal = new AbortController().signal;
    mocks.marketGet.mockResolvedValue({ announcements: [{ title: '安迪苏2025年年度报告', symbol: '600299', notice_date: '2026-03-01', pdf_url: 'https://example.com/1' }, { title: '安迪苏2025年年度报告更正', symbol: '600299', notice_date: '2026-03-02', pdf_url: 'https://example.com/2' }, { title: '其他公司2025年年度报告', symbol: '600000', notice_date: '2026-03-01', pdf_url: 'https://example.com/3' }] });
    const r = await companyFilings(s, 2, signal); expect(mocks.marketGet.mock.calls[0][0]).toContain('page=2'); expect(r.filings).toHaveLength(2); expect(s.filings![0].relatedUrls).toContain('https://example.com/2');
    expect(() => verifyFiling(s, { ...s.sources[0], content: '另一家公司2025年年度报告' }, s.filings![0])).toThrow('核验');
  });
});
