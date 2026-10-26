import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { researchTaskSpecSchema, type ResearchTaskSpec } from '../../src/lib/company-research/task-contracts';
import { researchDocumentSchema } from '../../src/lib/company-research/document-contracts';
import { parsedDocumentV2Schema } from '../../src/lib/company-research/parsed-document';
import { cninfoDisclosure } from '../../src/lib/company-research/filing-acquisition';

const text = z.string().min(1), digest = z.string().regex(/^[a-f0-9]{64}$/);
const fixtureDocumentSchema = z.object({
  id: text, symbol: text, title: text, url: z.url(), path: text, bytesSha256: digest,
  byteLength: z.number().int().positive().optional(), retrievedAt: z.iso.datetime({ offset: true }),
  period: z.object({ start: z.iso.date(), end: z.iso.date(), kind: z.enum(['annual', 'interim', 'quarter']) }),
  announcementPath: text.optional(), announcementSha256: digest.optional(),
  pageCount: z.number().int().positive().optional(),
  parserReceipt: z.object({ path: text, sha256: digest, status: z.enum(['ready', 'partial', 'unreadable']).optional() }).optional(),
});
type FixtureDocumentInput = z.infer<typeof fixtureDocumentSchema>;
export interface FixtureTaskInput {
  caseId: string; spec: ResearchTaskSpec;
  documentScope: { taskDocumentIds: string[]; primaryDocumentIds: string[]; supportingDocumentIds: string[] };
  documents: FixtureDocumentInput[];
}
const sampleSchema = z.object({ id: text, company: z.object({ symbol: text, name: text }),
  asOf: z.iso.datetime({ offset: true }), documentIds: z.array(text).min(2),
  primaryDocumentIds: z.array(text).length(2).optional(), supportingDocumentIds: z.array(text).optional(),
  questions: z.array(z.object({ id: z.enum(['q1', 'q2', 'q3', 'income_profit', 'cash_flow', 'risks']), text })).length(3),
});
/** An explicit allowlist keeps evaluation answers out of production execution inputs. */
export function createFixtureTaskInput(sampleInput: unknown, documentInputs: unknown[], budget = { maxToolCalls: 40, timeoutMs: 1_200_000 }): FixtureTaskInput {
  const sample = sampleSchema.parse(sampleInput);
  const documents = documentInputs.map(input => fixtureDocumentSchema.parse(input));
  const primary = sample.primaryDocumentIds ?? (sample.documentIds.length === 2 ? sample.documentIds : []);
  const supporting = sample.supportingDocumentIds ?? [];
  const assigned = [...primary, ...supporting];
  if (primary.length !== 2 || new Set(assigned).size !== assigned.length || assigned.length !== sample.documentIds.length || assigned.some(id => !sample.documentIds.includes(id))) throw new Error('FIXTURE_DOCUMENT_SCOPE_BINDING');
  if (new Set(documents.map(document => document.id)).size !== documents.length) throw new Error('FIXTURE_DUPLICATE_DOCUMENT');
  const selected = sample.documentIds.map(id => documents.find(document => document.id === id));
  if (selected.some(document => !document || document.symbol !== sample.company.symbol)) throw new Error('FIXTURE_DOCUMENT_COMPANY_BINDING');
  const primaryDocuments = primary.map(id => documents.find(document => document.id === id)!);
  const periods = primaryDocuments.map(document => ({ ...document.period, id: `FY${document.period.end.slice(0, 4)}`, basis: 'cumulative' as const })).sort((a, b) => a.end.localeCompare(b.end));
  if (selected.some(document => !periods.some(period => period.start === document!.period.start && period.end === document!.period.end && period.kind === document!.period.kind))) throw new Error('FIXTURE_SUPPORTING_PERIOD_BINDING');
  const spec = researchTaskSpecSchema.parse({ schemaVersion: 1, kind: 'financial_change', requestRevision: 1,
    company: { ...sample.company, exchange: sample.company.symbol.split('.')[1] }, periods, asOf: sample.asOf,
    questions: sample.questions.map(question => ({ ...question, id: ({ q1: 'income_profit', q2: 'cash_flow', q3: 'risks' } as Record<string, string>)[question.id] ?? question.id })),
    scope: 'consolidated', currency: 'CNY', comparison: { status: 'comparable' }, budget });
  return { caseId: sample.id, spec, documentScope: { taskDocumentIds: [...sample.documentIds], primaryDocumentIds: [...primary], supportingDocumentIds: [...supporting] }, documents: selected as FixtureDocumentInput[] };
}

/** Refuse links/junctions and escaping paths before reading controlled development bytes. */
export async function readScopedFixtureFile(repository: string, file: string): Promise<Buffer> {
  const root = await realpath(repository), target = path.resolve(root, file), relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('FIXTURE_FILE_OUTSIDE_REPOSITORY');
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('FIXTURE_FILE_SYMLINK');
  }
  if (!(await lstat(target)).isFile() || path.relative(root, await realpath(target)).startsWith('..')) throw new Error('FIXTURE_FILE_NOT_REGULAR');
  return readFile(target);
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const ref = (bytes: Buffer) => ({ store: 'local' as const, key: sha(bytes), sha256: sha(bytes), byteLength: bytes.length });

/** No network, database, parser invocation or model call; partial parser quality is preserved. */
export async function loadFixtureTaskDocuments(input: FixtureTaskInput, taskId: string, repository = process.cwd()) {
  const output = [];
  for (const meta of input.documents) {
    const original = await readScopedFixtureFile(repository, meta.path);
    if (sha(original) !== meta.bytesSha256 || (meta.byteLength !== undefined && original.length !== meta.byteLength)) throw new Error(`FIXTURE_ORIGINAL_HASH:${meta.id}`);
    const receiptMeta = meta.parserReceipt;
    if (!receiptMeta) throw new Error(`FIXTURE_EXPLICIT_PARSER_RECEIPT_REQUIRED:${meta.id}`);
    const parsed = await readScopedFixtureFile(repository, receiptMeta.path);
    if (sha(parsed) !== receiptMeta.sha256) throw new Error(`FIXTURE_PARSER_HASH:${meta.id}`);
    const receipt = parsedDocumentV2Schema.parse(JSON.parse(parsed.toString()));
    if (receipt.originalSha256 !== meta.bytesSha256 || (meta.pageCount !== undefined && receipt.pageCount !== meta.pageCount) || (receiptMeta.status !== undefined && receipt.status !== receiptMeta.status)) throw new Error(`FIXTURE_PARSER_ORIGINAL_BINDING:${meta.id}`);
    if (!meta.announcementPath || !meta.announcementSha256) throw new Error(`FIXTURE_ANNOUNCEMENT_BINDING_REQUIRED:${meta.id}`);
    const announcement = await readScopedFixtureFile(repository, meta.announcementPath);
    if (sha(announcement) !== meta.announcementSha256) throw new Error(`FIXTURE_ANNOUNCEMENT_HASH:${meta.id}`);
    const disclosure = cninfoDisclosure(JSON.parse(announcement.toString()), announcement, 'https://www.cninfo.com.cn/new/hisAnnouncement/query');
    const document = researchDocumentSchema.parse({ schemaVersion: 1, id: meta.id, taskId, version: 1,
      company: input.spec.company, period: input.spec.periods.find(period => period.start === meta.period.start && period.end === meta.period.end),
      title: meta.title, url: meta.url, mediaType: receipt.mediaType, bytesSha256: meta.bytesSha256, fetchedAt: meta.retrievedAt,
      original: ref(original), parsed: ref(parsed), state: receipt.status, pageCount: receipt.pageCount,
      parser: { ...receipt.parser, failedPages: receipt.failedPages, warnings: receipt.warnings }, disclosure: disclosure.disclosure });
    output.push({ document, original, parsed });
  }
  return output;
}
