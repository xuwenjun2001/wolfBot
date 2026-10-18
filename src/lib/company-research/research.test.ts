import { afterEach, describe, expect, it, vi } from 'vitest';
import { coverage, salvageReport } from './evidence';
import { emptyReport, type ResearchState, type Source } from './contracts';
import { publicAddress, validatePublicUrl, boundedJson } from './network';
import { createResearchTools, sourceExcerpt } from './tools';
import { financialSourceText } from './connectors';
import { createResearchProvider } from './provider';

const source: Source = { id: 's1', url: 'https://example.com/report', title: '年报', publishedAt: '2026-03-01', fetchedAt: '2026-09-16', content: '公司的主要业务为动力电池生产和销售。2026年半年度营业收入为100亿元。', hash: 'abc', kind: 'web' };
function report() {
  const r = emptyReport('');
  for (const key of ['business','supplyChain','financials'] as const) r[key] = { claims: [{ text: '公司的主要业务为动力电池生产和销售。', kind: 'fact', citations: [{ sourceId: 's1', quote: '公司的主要业务为动力电池生产和销售。', locator: '公司业务' }] }], gaps: [] };
  r.metrics = [{ label: '营收', value: '100亿元', yoy: '未披露', period: '2026H1', basis: '累计', citation: { sourceId: 's1', quote: '2026年半年度营业收入为100亿元。', locator: '财务摘要' } }];
  r.limitations = []; return r;
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('company research evidence', () => {
  it('rejects nonexistent, fabricated and future citations', () => {
    const r = report();
    expect(coverage(r, [source], '2026-09-16').complete).toBe(true);
    expect(coverage(r, [], '2026-09-16').errors.length).toBeGreaterThan(0);
    expect(coverage(r, [{ ...source, publishedAt: '2027-01-01' }], '2026-09-16').errors.some(e => e.includes('截止日'))).toBe(true);
    r.business.claims[0].citations[0].quote = '原文没有出现的供应商名称';
    expect(coverage(r, [source], '2026-09-16').errors.some(e => e.includes('原文'))).toBe(true);
  });
  it('makes missing financials and supplier information partial, not complete', () => {
    const r = report(); r.metrics = []; r.supplyChain.gaps = ['具体客户未披露'];
    expect(coverage(r, [source], '2026-09-16')).toMatchObject({ complete: false, errors: [] });
  });
  it('drops unsupported claims from a budget-limited draft', () => {
    const r = report(); r.business.claims[0].citations[0].quote = '不在原文中的业务描述';
    const saved = salvageReport(r, [source], '2026-09-16');
    expect(saved.business.claims).toHaveLength(0);
    expect(saved.financials.claims).toHaveLength(1);
    expect(saved.business.gaps[0]).toContain('移除');
  });
  it('keeps business and upstream passages in bounded excerpts, not only the report opening', () => {
    const s = { ...source, content: '前言'.repeat(5000) + '主要业务是电池制造。' + '其他'.repeat(3000) + '供应商提供原材料和设备。' };
    const excerpt = sourceExcerpt(s, ['主要业务', '供应商'], 1000);
    expect(excerpt.content.length).toBeLessThanOrEqual(1000);
    expect(excerpt.content).toContain('主要业务是电池制造');
    expect(excerpt.content).toContain('供应商提供原材料和设备');
  });
  it('formats financial evidence with explicit original units and never fabricates missing cash flow', () => {
    const text = financialSourceText([{ data_type: '半年报', report_date: '2026-06-30', notice_date: '2026-08-01', revenue: '100000000', revenue_yoy: '2.345', parent_net_profit: null }]);
    expect(text).toContain('100000000 元（1.00 亿元）');
    expect(text).toContain('同比：2.35%');
    expect(text).toContain('归母净利润：未披露');
    expect(text).toContain('现金流总额及同比：本接口未提供');
    expect(text).toContain('口径为营业总收入');
  });
  it('requires a coverage check before submitting saved evidence', async () => {
    const state: ResearchState = { company: { symbol: '300750', name: '宁德时代' }, asOf: '2026-09-16', sources: [source], draft: null, coverageChecks: 0, supplementRounds: 0, lastCoverageHash: null, toolCalls: 0, inputTokens: 0, outputTokens: 0, submitted: false, notes: [] };
    const tools = createResearchTools(state);
    const ctx = { runId: 'test', turn: 1, toolCallId: 'call', operationId: 'op', signal: new AbortController().signal };
    const submit = tools.find(t => t.name === 'submit_research_report')!;
    expect((await submit.execute({}, ctx)).ok).toBe(false);
    await tools.find(t => t.name === 'check_research_coverage')!.execute({}, ctx);
    expect((await submit.execute({}, ctx)).ok).toBe(true);
  });
});
describe('research network boundary', () => {
  it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','::1','fc00::1','::ffff:127.0.0.1','0.0.0.0'])('rejects private/reserved address %s', address => expect(publicAddress(address)).toBe(false));
  it('allows public addresses and rejects credential URLs', async () => {
    expect(publicAddress('8.8.8.8')).toBe(true);
    await expect(validatePublicUrl('https://user:password@example.com')).rejects.toThrow();
    await expect(validatePublicUrl('file:///etc/passwd')).rejects.toThrow();
  });
  it('bounds source bodies', async () => {
    await expect(boundedJson(new Response(JSON.stringify({ text: 'a'.repeat(100) })), 20)).rejects.toThrow('上限');
  });
});
describe('research gateway', () => {
  it.each([['gpt-5.6-luna', 'max'], ['gpt-6.1-sol', 'high']] as const)('sends requested model %s with %s effort without DeepSeek thinking fields', async (model, reasoning) => {
    vi.stubEnv('COMPANY_RESEARCH_API_KEY', 'test-secret');
    vi.stubEnv('COMPANY_RESEARCH_MODEL', model);
    vi.stubEnv('COMPANY_RESEARCH_REASONING', reasoning);
    const fetchMock = vi.fn(async () => new Response('data: {"id":"a","model":"gpt-5.6-luna","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"a","model":"gpt-5.6-luna","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    for await (const _event of createResearchProvider().complete({ model, messages: [{ role: 'user', content: 'test' }], maxTokens: 100, reasoning: { enabled: true, effort: reasoning } })) { /* consume */ }
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));
    expect(body).toMatchObject({ model, reasoning_effort: reasoning, max_completion_tokens: 100, parallel_tool_calls: false });
    expect(body.thinking).toBeUndefined();
  });
  it('rejects invalid effort before creating a model provider', () => {
    vi.stubEnv('COMPANY_RESEARCH_REASONING', 'invalid-effort');
    expect(() => createResearchProvider()).toThrow('reasoning effort must be high or max');
  });
});
