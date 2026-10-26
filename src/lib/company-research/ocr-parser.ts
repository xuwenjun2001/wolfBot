import { z } from 'zod';
import { artifactDigest } from './artifact-store';
import { boundedJson } from './network';
import { parsedDocumentV2Schema, type ParsedDocument } from './parsed-document';
import { NativePdfParser, type ParseOptions, type ResearchParserPort } from './text-parser';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function nativeNeedsOcr(native: ParsedDocument) {
  return native.status === 'unreadable' || native.failedPages.length > 0 || native.pages.some(p => !p.text.trim() || p.blocks.some(b => b.quality !== 'native'));
}
function retainFailedPageText(remote: ParsedDocument, native: ParsedDocument, options: ParseOptions): ParsedDocument {
  const pages = new Map(remote.pages.map(p => [p.filePage, p]));
  let characters = remote.pages.reduce((n, p) => n + p.text.length, 0), retained = false;
  for (const page of native.pages) {
    if (!remote.failedPages.includes(page.filePage) || page.filePage > options.maxPages || !page.blocks.length || pages.get(page.filePage)?.blocks.length || characters + page.text.length > options.maxCharacters) continue;
    pages.set(page.filePage, { ...page, blocks: page.blocks.map(b => ({ ...b, quality: 'needs_review', flags: [...b.flags, 'native_text_retained_after_pdfium_page_failure'] })) });
    characters += page.text.length;
    retained = true;
  }
  if (!retained) return remote;
  return { ...remote, pages: [...pages.values()].sort((a, b) => a.filePage - b.filePage), status: 'partial', warnings: [...remote.warnings.slice(0, 99), 'failed_pdfium_pages_retain_unverified_native_text'] };
}
export async function configuredPdfParser(engine: 'auto' | 'docling' | 'ocr'): Promise<ResearchParserPort> {
  const origin = new URL(process.env.DOCUMENT_PARSER_URL || 'http://127.0.0.1:7821');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/') throw new Error('Invalid trusted parser origin');
  const headers = { Authorization: `Bearer ${process.env.DOCUMENT_PARSER_TOKEN || ''}`, 'Content-Type': 'application/pdf' };
  let identity: { name: string; version: string } | null = null, preferNative = false;
  try {
    const health = z.object({ parser: z.object({ name: z.string().max(50), version: z.string().max(60) }), capabilities: z.object({ preferNative: z.boolean().optional() }).optional() }).parse(await boundedJson(await fetch(new URL('/health', origin), { headers, signal: AbortSignal.timeout(5000), redirect: 'error' })));
    identity = health.parser;
    preferNative = health.capabilities?.preferNative === true;
  } catch { /* Native text remains usable with an explicit fallback flag. */ }
  const name = `pdf-${engine}`, version = `route-v4-${identity?.version || 'ocr-unavailable'}`;
  return { name, version, async parse(bytes, mediaType, options) {
    if (mediaType !== 'application/pdf') throw new Error('PDF parser media type mismatch');
    options.signal.throwIfAborted();
    let native: ParsedDocument;
    try { native = await new NativePdfParser().parse(bytes, mediaType, options); }
    catch (error) {
      if (!identity || options.signal.aborted) throw error;
      const result = await remoteParse(bytes, engine === 'ocr', engine === 'auto' && preferNative, origin, headers, options);
      return { ...result, parser: { name, version } };
    }
    let result = native;
    const needsOcr = nativeNeedsOcr(native);
    // PDFium checks even an apparently ready text layer: missing glyphs need not emit U+FFFD.
    if (engine !== 'auto' || needsOcr || preferNative) {
      if (!identity) { result = { ...native, status: native.status === 'ready' ? 'partial' : native.status, warnings: [...native.warnings, 'ocr_service_unavailable_native_fallback'] }; }
      else {
        try {
          result = await remoteParse(bytes, engine === 'ocr', engine === 'auto' && preferNative, origin, headers, options);
          if (engine === 'auto' && preferNative) result = retainFailedPageText(result, native, options);
        }
        catch (error) { result = { ...native, status: native.status === 'ready' ? 'partial' : native.status, warnings: [...native.warnings, 'ocr_failed_native_fallback', `ocr_failure_type:${error instanceof Error ? error.name.slice(0, 50) : 'unknown'}`] }; }
      }
    }
    return { ...result, parser: { name, version } };
  } };
}
async function remoteParse(bytes: Buffer, force: boolean, preferNative: boolean, origin: URL, headers: Record<string, string>, options: ParseOptions): Promise<ParsedDocument> {
  options.signal.throwIfAborted();
  const timeoutSeconds = z.coerce.number().int().min(1).max(1200).parse(process.env.DOCUMENT_PARSER_TIMEOUT_SECONDS || 180);
  const submit = new URL('/jobs', origin);
  submit.search = new URLSearchParams({ maxPages: String(options.maxPages), maxCharacters: String(options.maxCharacters), forceOcr: String(force), preferNative: String(preferNative), timeoutSeconds: String(timeoutSeconds) }).toString();
  const { jobId } = z.object({ jobId: z.uuid() }).parse(await boundedJson(await fetch(submit, { method: 'POST', headers, body: new Uint8Array(bytes), signal: AbortSignal.any([options.signal, AbortSignal.timeout(30000)]), redirect: 'error' })));
  const jobUrl = new URL(`/jobs/${jobId}`, origin), started = Date.now(); let cancelledAt = 0;
  try {
    while (Date.now() - started < (timeoutSeconds + 15) * 1000) {
      if ((options.signal.aborted || Date.now() - started > (timeoutSeconds + 5) * 1000) && !cancelledAt) {
        cancelledAt = Date.now();
        await fetch(jobUrl, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000), redirect: 'error' }).then(r => r.body?.cancel());
      }
      const data = z.object({ status: z.enum(['queued', 'running', 'completed', 'failed']), result: z.unknown().optional() }).parse(await boundedJson(await fetch(jobUrl, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' }), 50_000_000));
      if (data.status === 'completed') {
        const result = parsedDocumentV2Schema.parse(data.result);
        if (result.originalSha256 !== artifactDigest(bytes) || result.mediaType !== 'application/pdf') throw new Error('Parser original mismatch');
        if (result.pages.some(p => p.blocks.length && p.filePage > options.maxPages) || result.pages.reduce((n, p) => n + p.text.length, 0) > options.maxCharacters) throw new Error('Parser exceeded requested bounds');
        if (options.signal.aborted && !result.warnings.some(w => /^(cancelled|timeout)_partial/.test(w))) {
          return { ...result, status: result.status === 'ready' ? 'partial' : result.status, warnings: [...result.warnings, 'cancelled_partial'] };
        }
        return result;
      }
      if (data.status === 'failed' || (cancelledAt && Date.now() - cancelledAt > 5000)) throw new Error('OCR incomplete');
      await pause(250);
    }
    throw new Error('OCR timeout');
  } finally {
    await fetch(jobUrl, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000), redirect: 'error' }).then(r => r.body?.cancel()).catch(() => undefined);
  }
}
