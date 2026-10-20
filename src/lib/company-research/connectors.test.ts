import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepSeekTools, readWebSource, resolveCompanies } from './connectors';
import { researchConfig, safeError } from './config';

const mocks = vi.hoisted(() => ({
  validatePublicUrl: vi.fn(), downloadPdf: vi.fn(), getText: vi.fn(), destroy: vi.fn(),
}));
vi.mock('./network', async original => ({ ...await original<typeof import('./network')>(),
  validatePublicUrl: mocks.validatePublicUrl, downloadPdf: mocks.downloadPdf,
}));
vi.mock('pdf-parse', () => ({ PDFParse: class {
  getText = mocks.getText;
  destroy = mocks.destroy;
} }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('COMPANY_RESEARCH_SEARCH_API_KEY', 'research-search-secret');
  vi.stubEnv('DEEPSEEK_API_KEY', 'general-deepseek-secret');
  mocks.validatePublicUrl.mockImplementation(async (value: string) => {
    const url = new URL(value); url.hash = '';
    return { url, address: { address: '8.8.8.8', family: 4 } };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('company identity lookup', () => {
  it.each(['安迪苏', '600299', '600299.SH', ' 600299.SH '])('adapts %s to the market search contract', async query => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [
      { symbol: '600299', name: '安迪苏', asset_type: 'stock' },
      { symbol: '600299', name: '安迪苏', asset_type: 'stock' },
      { symbol: '000300', name: '沪深300', asset_type: 'index' },
    ] })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolveCompanies(query)).toEqual([{ symbol: '600299', name: '安迪苏' }]);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('query')).toBe(query === '安迪苏' ? query : '600299');
  });

  it('preserves an empty authoritative result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"results":[]}')));
    expect(await resolveCompanies('601919.SH')).toEqual([]);
  });
});

describe('company research DeepSeek connector', () => {
  it('prefers the research search key, falls back to the official key and redacts both', () => {
    vi.stubEnv('COMPANY_RESEARCH_API_KEY', 'research-model-secret');
    expect(researchConfig().searchApiKey).toBe('research-search-secret');
    expect(safeError(new Error('research-search-secret general-deepseek-secret research-model-secret')))
      .toBe('[redacted] [redacted] [redacted]');
    vi.stubEnv('COMPANY_RESEARCH_SEARCH_API_KEY', '');
    expect(researchConfig().searchApiKey).toBe('general-deepseek-secret');
  });

  it('calls the official search endpoint independently of the model gateway', async () => {
    vi.stubEnv('COMPANY_RESEARCH_BASE_URL', 'https://model.example.com/v1');
    const response = { results: [{ title: '公司年报', url: 'https://example.com/report', summary: '主营业务' }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetchMock);
    const input = { query: '安迪苏 主营业务', count: 5, need_content: false };
    expect(await deepSeekTools('search', input, new AbortController().signal)).toEqual(response);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer research-search-secret', 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(options.body))).toEqual(input);
  });

  it('reports authentication errors without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":{"message":"Invalid key"}}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deepSeekTools('search', { query: '安迪苏' }, new AbortController().signal)).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects missing credentials before any external request', async () => {
    vi.stubEnv('COMPANY_RESEARCH_SEARCH_API_KEY', ''); vi.stubEnv('DEEPSEEK_API_KEY', '');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(deepSeekTools('search', { query: '安迪苏' }, new AbortController().signal)).rejects.toThrow('COMPANY_RESEARCH_SEARCH_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saves the fetched Markdown as source evidence with the original canonical URL', async () => {
    const content = '# 公司报告\n' + '安迪苏主营动物营养产品。'.repeat(12);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ title: '安迪苏年报', content })));
    vi.stubGlobal('fetch', fetchMock);
    const source = await readWebSource('https://example.com/report#business', new AbortController().signal);
    expect(source).toMatchObject({ title: '安迪苏年报', content, url: 'https://example.com/report', kind: 'web', publishedAt: null });
    expect(source.hash).toMatch(/^[a-f0-9]{64}$/);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(JSON.parse(String(options.body))).toEqual({ url: 'https://example.com/report' });
    expect(mocks.validatePublicUrl).toHaveBeenCalledWith('https://example.com/report#business');
    expect(mocks.downloadPdf).not.toHaveBeenCalled();
  });

  it('retains local PDF parsing when DeepSeek cannot fetch the document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    mocks.downloadPdf.mockResolvedValue(Buffer.from('%PDF-test'));
    const text = '安迪苏2025年年度报告。主要产品为动物营养产品。'.repeat(6);
    mocks.getText.mockResolvedValue({ pages: [{ num: 1, text }] });
    const source = await readWebSource('https://example.com/report.PDF', new AbortController().signal);
    expect(source.content).toBe(`[第 1 页]\n${text}`);
    expect(mocks.downloadPdf).toHaveBeenCalledTimes(1);
    expect(mocks.getText).toHaveBeenCalledWith({ first: 100 });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not start requests or PDF fallback after cancellation', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(readWebSource('https://example.com/report.pdf', AbortSignal.abort(new Error('研究取消')))).rejects.toThrow('研究取消');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.downloadPdf).not.toHaveBeenCalled();
  });
});
