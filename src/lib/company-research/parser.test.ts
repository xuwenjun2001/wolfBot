import { afterEach, describe, expect, it, vi } from 'vitest';
import { HtmlTextParser, NativePdfParser, nativePdfTextFlags } from './text-parser';
import { parsedDocumentV2Schema, type ParsedDocument } from './parsed-document';
import { artifactDigest } from './artifact-store';
import { locatedCitationText } from './citation-locator';
import { reusableParserResult } from './parse-service';
import { configuredPdfParser, nativeNeedsOcr } from './ocr-parser';
const options = () => ({ maxPages: 10, maxCharacters: 10000, signal: AbortSignal.timeout(5000) });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('versioned parser locations', () => {
  it('retries failed OCR and interrupted runs while retaining stable reviewed-page caches', () => {
    for (const flag of ['cancelled_partial', 'timeout_partial', 'worker_stopped_partial', 'ocr_failed_native_fallback', 'ocr_service_unavailable_native_fallback']) expect(reusableParserResult([flag], [])).toBe(false);
    expect(reusableParserResult([], [4])).toBe(false);
    expect(reusableParserResult(['native_text_has_no_table_grid', 'truncated_pages:4,5'], [])).toBe(true);
  });
  it('keeps stable HTML source ranges, excludes active content and verifies exact block locators', async () => {
    const html = Buffer.from('<html><head><title>hidden</title></head><body><p>现金流 &amp; 利润</p><script>恶意指令</script><p>(1,234.50) 万元</p></body></html>');
    const parser = new HtmlTextParser(), result = await parser.parse(html, 'text/html', options());
    expect(await parser.parse(html, 'text/html', options())).toEqual(result);
    expect(result.pages[0].text).toBe('现金流 & 利润\n(1,234.50) 万元');
    const block = result.pages[0].blocks[1], c = { documentId: 'd', documentVersion: 1, bytesSha256: result.originalSha256, quote: block.text, locator: block.locator };
    expect(locatedCitationText(result, c)).toBe(block.text);
    expect(locatedCitationText(result, { ...c, locator: { kind: 'html', blockId: block.id, selector: 'source-range:0:1' } })).toBeUndefined();
    expect(block.locator).not.toHaveProperty('box');
  });
  it('makes truncation, empty and garbled documents explicit', async () => {
    const parser = new HtmlTextParser();
    const empty = await parser.parse(Buffer.from('<html><script>hidden</script></html>'), 'text/html', options());
    expect(empty.status).toBe('unreadable'); expect(empty.failedPages).toEqual([1]);
    const truncated = await parser.parse(Buffer.from('<html><p>' + '金额'.repeat(200) + '</p></html>'), 'text/html', { ...options(), maxCharacters: 100 });
    expect(truncated.status).toBe('partial'); expect(truncated.truncatedPages).toEqual([1]);
    expect(parsedDocumentV2Schema.safeParse({ ...truncated, status: 'ready' }).success).toBe(false);
    expect(parsedDocumentV2Schema.safeParse({ ...empty, status: 'ready' }).success).toBe(false);
    expect(parsedDocumentV2Schema.safeParse({ ...truncated, pageCount: 2, truncatedPages: [] }).success).toBe(false);
    expect(nativeNeedsOcr(truncated)).toBe(false); // A configured character limit is not an OCR defect.
    expect(nativeNeedsOcr(empty)).toBe(true);
  });
  it('rejects invented table cells and a cancelled parse before work starts', async () => {
    await expect(new HtmlTextParser().parse(Buffer.from('<html>a</html>'), 'text/html', { ...options(), signal: AbortSignal.abort() })).rejects.toThrow();
  });
  it('counts HTML separators in the character budget and retains a partial receipt', async () => {
    const parser = new HtmlTextParser();
    const source = Buffer.from('<html><p>' + 'a'.repeat(250000) + '</p><p>' + 'b'.repeat(250000) + '</p></html>');
    const parsed = await parser.parse(source, 'text/html', { ...options(), maxCharacters: 2000000 });
    expect(parsed.status).toBe('partial'); expect(parsed.truncatedPages).toEqual([1]);
    expect(parsed.pages[0].text.length).toBe(500000);
    expect(parsed.pages[0].blocks[1].text.length).toBe(249999);
    const short = Buffer.from('<html><p>abc</p><p>def</p></html>');
    const exact = await parser.parse(short, 'text/html', { ...options(), maxCharacters: 7 });
    expect(exact.status).toBe('ready'); expect(exact.pages[0].text).toBe('abc\ndef');
    const truncated = await parser.parse(short, 'text/html', { ...options(), maxCharacters: 6 });
    expect(truncated.status).toBe('partial'); expect(truncated.pages[0].text).toBe('abc\nde');
  });
  it('returns partial instead of violating the HTML block count limit', async () => {
    const result = await new HtmlTextParser().parse(Buffer.from('<html>' + '<p>x</p>'.repeat(10001) + '</html>'), 'text/html', { ...options(), maxCharacters: 500000 });
    expect(result.status).toBe('partial'); expect(result.pages[0].blocks).toHaveLength(10000);
  });
  it('recognizes missing glyphs without assuming a company, language or financial term', () => {
    expect(nativePdfTextFlags('2023A\n1\n2\n3.11.1\n2.5%')).toContain('sparse_text_layer_requires_review');
    expect(nativePdfTextFlags('Revenue \uFFFD 123')).toContain('unmapped_text_glyphs');
    expect(nativePdfTextFlags('正文 \u0000 123')).toContain('unmapped_text_glyphs');
    expect(nativePdfTextFlags('正文 \uE001 123')).toContain('private_use_text_glyphs');
    for (const text of ['项目 收入 123,456.00', 'Revenue 123,456.00', '二零二三年年报', 'hello, world!']) expect(nativePdfTextFlags(text)).toEqual([]);
  });
});

describe('trusted PDFium route', () => {
  const bytes = Buffer.from('%PDF-route-fixture');
  function receipt(text = 'PDFium 保留中文 123.45', review = false): ParsedDocument {
    return parsedDocumentV2Schema.parse({ schemaVersion: 2, originalSha256: artifactDigest(bytes), mediaType: 'application/pdf', parser: { name: 'test-service', version: 'v2' }, pageCount: 1,
      status: review ? 'partial' : 'ready', pages: [{ filePage: 1, text, blocks: [{ id: 'block1', order: 0, kind: 'text', text, locator: { kind: 'block', blockId: 'block1', filePage: 1 }, quality: review ? 'needs_review' : 'native', flags: review ? ['ocr_requires_review'] : [] }] }], failedPages: [], truncatedPages: [], warnings: [] });
  }
  function service(result: ParsedDocument) {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return Response.json({ parser: { name: 'test-service', version: 'v2' }, capabilities: { preferNative: true } });
      if (init?.method === 'POST') return Response.json({ jobId: '11111111-1111-4111-8111-111111111111' });
      if (init?.method === 'DELETE') return Response.json({ status: 'cancelling' });
      return Response.json({ status: 'completed', result });
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }
  it('cross-checks an apparently ready native receipt and retains PDFium page locations', async () => {
    vi.spyOn(NativePdfParser.prototype, 'parse').mockResolvedValue(receipt('2023A 1234567890'));
    const result = receipt(), fetcher = service(result);
    const parser = await configuredPdfParser('auto'), output = await parser.parse(bytes, 'application/pdf', options());
    expect(output.pages).toEqual(result.pages); expect(output.status).toBe('ready');
    expect(fetcher.mock.calls.some(([input, init]) => init?.method === 'POST' && new URL(String(input)).searchParams.get('preferNative') === 'true')).toBe(true);
    expect(output.parser.version).toBe('route-v4-v2');
  });
  it('never promotes OCR output to native or ready', async () => {
    vi.spyOn(NativePdfParser.prototype, 'parse').mockResolvedValue(receipt());
    service(receipt('扫描识别 123.45', true));
    const output = await (await configuredPdfParser('auto')).parse(bytes, 'application/pdf', options());
    expect(output.status).toBe('partial'); expect(output.pages[0].blocks[0].quality).toBe('needs_review');
    expect(output.pages[0].blocks[0].flags).toContain('ocr_requires_review');
  });
  it('retains an existing native fragment on a failed service page without clearing its failure or review', async () => {
    const local = receipt('Readable original fragment 123.45'), remote = receipt();
    remote.pages = [{ filePage: 1, text: '', blocks: [] }]; remote.failedPages = [1]; remote.status = 'unreadable';
    vi.spyOn(NativePdfParser.prototype, 'parse').mockResolvedValue(local); service(remote);
    const output = await (await configuredPdfParser('auto')).parse(bytes, 'application/pdf', options());
    expect(output.status).toBe('partial'); expect(output.failedPages).toEqual([1]);
    expect(output.pages[0].text).toBe(local.pages[0].text);
    expect(output.pages[0].blocks[0].quality).toBe('needs_review');
    expect(output.pages[0].blocks[0].flags).toContain('native_text_retained_after_pdfium_page_failure');
    expect(output.warnings).toContain('failed_pdfium_pages_retain_unverified_native_text');
  });
  it('does not exceed a character budget when retaining failed-page fragments', async () => {
    const local = receipt('a'.repeat(101)), remote = receipt();
    remote.pages = [{ filePage: 1, text: '', blocks: [] }]; remote.failedPages = [1]; remote.status = 'unreadable';
    vi.spyOn(NativePdfParser.prototype, 'parse').mockResolvedValue(local); service(remote);
    const output = await (await configuredPdfParser('auto')).parse(bytes, 'application/pdf', { ...options(), maxCharacters: 100 });
    expect(output.status).toBe('unreadable'); expect(output.pages[0].text).toBe(''); expect(output.failedPages).toEqual([1]);
  });
  it.each(['hash', 'characters', 'page'] as const)('rejects a remote receipt with mismatched %s and preserves explicit fallback', async kind => {
    const local = receipt('local readable text'), remote = receipt('a'.repeat(10001));
    vi.spyOn(NativePdfParser.prototype, 'parse').mockResolvedValue(local);
    if (kind === 'hash') { remote.pages = local.pages; remote.originalSha256 = '0'.repeat(64); }
    if (kind === 'page') { remote.pages = local.pages.map(p => ({ ...p, filePage: 11, blocks: p.blocks.map(b => ({ ...b, locator: { kind: 'block' as const, blockId: b.id, filePage: 11 } })) })); remote.pageCount = 11; remote.truncatedPages = Array.from({ length: 10 }, (_, i) => i + 1); remote.status = 'partial'; }
    service(remote);
    const output = await (await configuredPdfParser('auto')).parse(bytes, 'application/pdf', options());
    expect(output.pages).toEqual(local.pages); expect(output.status).toBe('partial');
    expect(output.warnings).toContain('ocr_failed_native_fallback');
  });
  it('recovers from a native parser exception using the same trusted bounded route', async () => {
    vi.spyOn(NativePdfParser.prototype, 'parse').mockRejectedValue(new Error('font decoding failed'));
    const remote = receipt(); service(remote);
    const output = await (await configuredPdfParser('auto')).parse(bytes, 'application/pdf', options());
    expect(output.originalSha256).toBe(artifactDigest(bytes)); expect(output.pages).toEqual(remote.pages);
  });
  it('keeps already finished pages and cancellation visible when the service completes during cancellation', async () => {
    const controller = new AbortController(), local = receipt();
    vi.spyOn(NativePdfParser.prototype, 'parse').mockResolvedValue(local);
    const fetcher = service(local), original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (new URL(String(input)).pathname.startsWith('/jobs/') && init?.method !== 'DELETE') controller.abort();
      return response;
    });
    const output = await (await configuredPdfParser('auto')).parse(bytes, 'application/pdf', { ...options(), signal: controller.signal });
    expect(output.status).toBe('partial'); expect(output.pages).toEqual(local.pages); expect(output.warnings).toContain('cancelled_partial');
  });
});
