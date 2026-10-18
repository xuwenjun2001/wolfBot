import { z } from 'zod';
import { boundedJson } from './network';
import { parsedDocumentV2Schema, type ParsedDocument } from './parsed-document';
import { NativePdfParser, type ParseOptions, type ResearchParserPort } from './text-parser';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function nativeNeedsOcr(native: ParsedDocument) {
  return native.status === 'unreadable' || native.failedPages.length > 0 || native.pages.some(p => !p.text.trim() || p.blocks.some(b => b.quality !== 'native'));
}
export async function configuredPdfParser(engine: 'auto' | 'docling' | 'ocr'): Promise<ResearchParserPort> {
  const origin = new URL(process.env.DOCUMENT_PARSER_URL || 'http://127.0.0.1:7821');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/') throw new Error('Invalid trusted parser origin');
  const headers = { Authorization: `Bearer ${process.env.DOCUMENT_PARSER_TOKEN || ''}`, 'Content-Type': 'application/pdf' };
  let identity: { name: string; version: string } | null = null;
  try {
    const health = z.object({ parser: z.object({ name: z.string().max(50), version: z.string().max(60) }) }).parse(await boundedJson(await fetch(new URL('/health', origin), { headers, signal: AbortSignal.timeout(5000), redirect: 'error' })));
    identity = health.parser;
  } catch { /* Native text remains usable with an explicit fallback flag. */ }
  const name = `pdf-${engine}`, version = `route-v2-${identity?.version || 'ocr-unavailable'}`;
  return { name, version, async parse(bytes, mediaType, options) {
    const native = await new NativePdfParser().parse(bytes, mediaType, options);
    let result = native;
    const needsOcr = nativeNeedsOcr(native);
    if (engine !== 'auto' || needsOcr) {
      if (!identity) { result = { ...native, status: native.status === 'ready' ? 'partial' : native.status, warnings: [...native.warnings, 'ocr_service_unavailable_native_fallback'] }; }
      else {
        try { result = await remoteParse(bytes, engine === 'ocr', origin, headers, options); }
        catch { result = { ...native, status: native.status === 'ready' ? 'partial' : native.status, warnings: [...native.warnings, 'ocr_failed_native_fallback'] }; }
      }
    }
    return { ...result, parser: { name, version } };
  } };
}
async function remoteParse(bytes: Buffer, force: boolean, origin: URL, headers: Record<string, string>, options: ParseOptions): Promise<ParsedDocument> {
  options.signal.throwIfAborted();
  const timeoutSeconds = z.coerce.number().int().min(1).max(1200).parse(process.env.DOCUMENT_PARSER_TIMEOUT_SECONDS || 180);
  const submit = new URL('/jobs', origin);
  submit.search = new URLSearchParams({ maxPages: String(options.maxPages), maxCharacters: String(options.maxCharacters), forceOcr: String(force), timeoutSeconds: String(timeoutSeconds) }).toString();
  const { jobId } = z.object({ jobId: z.uuid() }).parse(await boundedJson(await fetch(submit, { method: 'POST', headers, body: new Uint8Array(bytes), signal: AbortSignal.any([options.signal, AbortSignal.timeout(30000)]), redirect: 'error' })));
  const jobUrl = new URL(`/jobs/${jobId}`, origin), started = Date.now(); let cancelledAt = 0;
  try {
    while (Date.now() - started < (timeoutSeconds + 15) * 1000) {
      if ((options.signal.aborted || Date.now() - started > (timeoutSeconds + 5) * 1000) && !cancelledAt) {
        cancelledAt = Date.now();
        await fetch(jobUrl, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000), redirect: 'error' }).then(r => r.body?.cancel());
      }
      const data = z.object({ status: z.enum(['queued', 'running', 'completed', 'failed']), result: z.unknown().optional() }).parse(await boundedJson(await fetch(jobUrl, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' }), 50_000_000));
      if (data.status === 'completed') return parsedDocumentV2Schema.parse(data.result);
      if (data.status === 'failed' || (cancelledAt && Date.now() - cancelledAt > 5000)) throw new Error('OCR incomplete');
      await pause(250);
    }
    throw new Error('OCR timeout');
  } finally {
    await fetch(jobUrl, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000), redirect: 'error' }).then(r => r.body?.cancel()).catch(() => undefined);
  }
}
