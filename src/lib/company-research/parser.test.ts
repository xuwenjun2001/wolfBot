import { describe, expect, it } from 'vitest';
import { HtmlTextParser } from './text-parser';
import { parsedDocumentV2Schema } from './parsed-document';
import { locatedCitationText } from './citation-locator';
import { reusableParserResult } from './parse-service';
import { nativeNeedsOcr } from './ocr-parser';
const options = () => ({ maxPages: 10, maxCharacters: 10000, signal: AbortSignal.timeout(5000) });
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
});
