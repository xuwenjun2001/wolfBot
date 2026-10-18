import { z } from 'zod';
import { defaultResearchContext, ResearchPersistenceError } from './repository-core';
import { readResearchDocumentArtifact, registerResearchDocument } from './document-store';
import { getResearchTask } from './version-store';
import { listResearchDocuments } from './acquisition-service';
import { artifactDigest } from './artifact-store';
import { parsedDocumentV2Schema, type ParsedDocument } from './parsed-document';
import { NativePdfParser, HtmlTextParser, type ResearchParserPort } from './text-parser';
import { configuredPdfParser } from './ocr-parser';

export const parseRequestSchema = z.object({ engine: z.enum(['native', 'auto', 'docling', 'ocr']).default('auto'), maxPages: z.number().int().min(1).max(1000).default(500), maxCharacters: z.number().int().min(100).max(5_000_000).default(2_000_000) }).strict();
/** Transient interruption/fallback is evidence, but must not suppress a later retry. */
export function reusableParserResult(warnings: string[], failedPages: number[]) {
  return failedPages.length === 0 && !warnings.some(w => /^(?:cancelled_partial|timeout_partial|worker_stopped_partial|ocr_.*native_fallback)/.test(w));
}
export async function parseResearchDocument(actor: string, taskId: string, id: string, version: number, input: unknown, signal: AbortSignal, ctx = defaultResearchContext, adapter?: ResearchParserPort) {
  const options = parseRequestSchema.parse(input), task = await getResearchTask(actor, taskId, ctx);
  if (!task) throw new ResearchPersistenceError('NOT_FOUND');
  const { document, bytes } = await readResearchDocumentArtifact(actor, taskId, id, version, 'original', ctx);
  const parser = adapter || (document.mediaType === 'text/html' ? new HtmlTextParser() : options.engine === 'native' ? new NativePdfParser() : await configuredPdfParser(options.engine));
  const configuration = `${parser.version}:${options.maxPages}:${options.maxCharacters}`;
  const latest = (await listResearchDocuments(actor, taskId, ctx)).filter(d => d.id === id).at(-1)!;
  if (latest.bytesSha256 === document.bytesSha256 && latest.parser?.name === parser.name && latest.parser.version === configuration && latest.parsed && reusableParserResult(latest.parser.warnings, latest.parser.failedPages)) {
    await ctx.artifacts.read(actor, latest.parsed); return { document: latest, reused: true };
  }
  if (latest.version !== version) throw new ResearchPersistenceError('REVISION_CONFLICT', '请针对最新资料版本解析');
  const output: ParsedDocument = parsedDocumentV2Schema.parse(await parser.parse(bytes, document.mediaType, { ...options, signal }));
  output.parser.version = configuration;
  // Acquisition verifies metadata; native content still needs issuer and report-year agreement.
  const opening = output.pages.slice(0, 3).map(p => p.text).join('').replace(/\s/g, '');
  if (!opening.includes(document.company.name.replace(/\s/g, '')) || !opening.includes(document.period.end.slice(0, 4))) {
    output.status = 'unreadable'; output.warnings.push('issuer_or_report_year_unverified');
  }
  const parsed = Buffer.from(JSON.stringify(output)), digest = artifactDigest(parsed);
  const next = { ...document, version: version + 1, state: output.status, pageCount: output.pageCount,
    parser: { ...output.parser, failedPages: output.failedPages, warnings: [...output.warnings, ...(output.truncatedPages.length ? [`truncated_pages:${output.truncatedPages.join(',')}`.slice(0, 500)] : [])] },
    parsed: { store: 'local' as const, key: digest, sha256: digest, byteLength: parsed.length } };
  await registerResearchDocument(actor, next, bytes, parsed, ctx);
  return { document: next, reused: false };
}
