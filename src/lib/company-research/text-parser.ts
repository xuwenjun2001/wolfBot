import { artifactDigest } from './artifact-store';
import { parsedDocumentV2Schema, type ParsedDocument, type ParsedBlock } from './parsed-document';

export interface ParseOptions { maxPages: number; maxCharacters: number; signal: AbortSignal }
export interface ResearchParserPort { name: string; version: string; parse(bytes: Buffer, mediaType: ParsedDocument['mediaType'], options: ParseOptions): Promise<ParsedDocument> }
function blocks(text: string, digest: string, page: number): ParsedBlock[] {
  const chunks = text.match(/[^\n]+(?:\n|$)/g) || [];
  const lines = text.trim().split('\n');
  const printedPage = [...lines.slice(0, 3), ...lines.slice(-3)].map(s => s.trim()).find(s => /^(?:第\s*\d+\s*页(?:\s*共\s*\d+\s*页)?|\d+\s*[/／]\s*\d+|-\s*\d+\s*-)$/.test(s));
  return chunks.map(t => t.trim()).filter(Boolean).flatMap(t => t.match(/[\s\S]{1,1800}/g) || []).map((t, order) => {
    const id = `b_${artifactDigest(`${digest}:${page}:${order}:${t}`).slice(0, 32)}`;
    const garbled = (t.match(/\uFFFD/g)?.length || 0) / t.length > 0.02;
    return { id, order, kind: 'text', text: t, locator: { kind: 'block', filePage: page, ...(printedPage ? { printedPage } : {}), blockId: id }, quality: garbled ? 'needs_review' : 'native', flags: garbled ? ['garbled_text'] : [] };
  });
}
/** Native text is retained as-is; page joins are never used as fabricated paragraph or table geometry. */
export class NativePdfParser implements ResearchParserPort {
  name = 'pdf-parse'; version = '2.4.5-blocks-v2';
  async parse(bytes: Buffer, mediaType: ParsedDocument['mediaType'], options: ParseOptions): Promise<ParsedDocument> {
    if (mediaType !== 'application/pdf') throw new Error('PDF parser media type mismatch');
    options.signal.throwIfAborted();
    const { PDFParse } = await import('pdf-parse'), parser = new PDFParse({ data: bytes });
    const pages: ParsedDocument['pages'] = [], failedPages: number[] = [], truncatedPages: number[] = [], warnings: string[] = ['native_text_has_no_table_grid'];
    let pageCount = 1, characters = 0;
    const digest = artifactDigest(bytes);
    const onAbort = () => { void parser.destroy().catch(() => undefined); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      pageCount = (await parser.getInfo()).total;
      for (let filePage = 1; filePage <= pageCount; filePage++) {
        if (filePage > options.maxPages || characters >= options.maxCharacters || options.signal.aborted) { truncatedPages.push(filePage); continue; }
        try {
          const result = await parser.getText({ partial: [filePage] });
          const raw = result.pages.find(p => p.num === filePage)?.text || '';
          const remaining = options.maxCharacters - characters, text = raw.slice(0, Math.min(remaining, 500000));
          if (text.length < raw.length) truncatedPages.push(filePage);
          characters += text.length;
          if (!text.trim()) failedPages.push(filePage);
          pages.push({ filePage, text, blocks: blocks(text, digest, filePage) });
        } catch { failedPages.push(filePage); pages.push({ filePage, text: '', blocks: [] }); }
      }
    } finally { options.signal.removeEventListener('abort', onAbort); await parser.destroy().catch(() => undefined); }
    if (!pages.length) pages.push({ filePage: 1, text: '', blocks: [] });
    if (options.signal.aborted) warnings.push('cancelled_partial');
    return parsedDocumentV2Schema.parse({ schemaVersion: 2, originalSha256: digest, mediaType, parser: { name: this.name, version: this.version }, pageCount, pages, failedPages, truncatedPages,
      status: !pages.some(p => p.blocks.length) ? 'unreadable' : failedPages.length || truncatedPages.length || pages.some(p => p.blocks.some(b => b.quality !== 'native')) ? 'partial' : 'ready', warnings });
  }
}
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', yen: '¥', minus: '−' };
function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (raw, code: string) => {
    if (code[0] !== '#') return entities[code] ?? raw;
    const n = Number.parseInt(code.slice(code[1].toLowerCase() === 'x' ? 2 : 1), code[1].toLowerCase() === 'x' ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\uFFFD';
  });
}
/** Conservative source-range HTML extraction. Source ranges refer to retained decoded UTF-8, never to a browser DOM guessed by the parser. */
export class HtmlTextParser implements ResearchParserPort {
  name = 'wolfbot-html'; version = 'source-ranges-v2';
  async parse(bytes: Buffer, mediaType: ParsedDocument['mediaType'], options: ParseOptions): Promise<ParsedDocument> {
    if (mediaType !== 'text/html') throw new Error('HTML parser media type mismatch');
    options.signal.throwIfAborted();
    const originalSha256 = artifactDigest(bytes), html = new TextDecoder('utf-8', { fatal: true }).decode(bytes), extracted: { text: string; selector: string }[] = [];
    const tokens = /<!--[\s\S]*?(?:-->|$)|<([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>|<\/([a-z][\w:-]*)\s*>|<![^>]*>|([^<]+)/gi;
    let suppressed: string | null = null, match: RegExpExecArray | null;
    while ((match = tokens.exec(html))) {
      if (options.signal.aborted) break;
      const open = match[1]?.toLowerCase(), close = match[2]?.toLowerCase();
      if (suppressed) { if (close === suppressed) suppressed = null; continue; }
      if (open && ['script','style','noscript','template','head','svg'].includes(open)) { suppressed = open; continue; }
      if (!match[3]) continue;
      const text = decode(match[3]).replace(/\s+/g, ' ').trim();
      if (text) extracted.push({ text, selector: `source-range:${match.index}:${match.index + match[0].length}` });
    }
    const selected: ParsedBlock[] = []; let used = 0, truncated = false;
    const limit = Math.min(500000, options.maxCharacters);
    for (const part of extracted) {
      const separator = selected.length ? 1 : 0;
      if (used + separator >= limit || selected.length >= 10000) { truncated = true; break; }
      const text = part.text.slice(0, limit - used - separator);
      used += text.length + separator;
      if (text.length < part.text.length) truncated = true;
      const id = `h_${artifactDigest(`${originalSha256}:${part.selector}:${text}`).slice(0, 32)}`;
      selected.push({ id, order: selected.length, kind: 'text', text, locator: { kind: 'html', blockId: id, selector: part.selector }, quality: /\uFFFD/.test(text) ? 'needs_review' : 'native', flags: [] });
    }
    const text = selected.map(b => b.text).join('\n'), truncatedPages = truncated ? [1] : [];
    return parsedDocumentV2Schema.parse({ schemaVersion: 2, originalSha256, mediaType, parser: { name: this.name, version: this.version }, pageCount: 1,
      status: !text ? 'unreadable' : truncatedPages.length || selected.some(b => b.quality !== 'native') ? 'partial' : 'ready', pages: [{ filePage: 1, text, blocks: selected }], failedPages: text ? [] : [1], truncatedPages,
      warnings: ['html_source_ranges_not_dom_coordinates', ...(options.signal.aborted ? ['cancelled_partial'] : [])] });
  }
}
