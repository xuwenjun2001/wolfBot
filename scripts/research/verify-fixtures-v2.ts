import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cnyUnitPowers, decimal, decimalText, multiplyPowerOfTen, percentChange, subtract } from '../../src/lib/company-research/exact-decimal';
import { parsedReceiptSchema } from '../../src/lib/company-research/parsed-document';
import { caseAnswerabilitySchema } from '../../src/lib/eval/financial-research-score-v2';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const period = z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).passthrough();
const citation = z.object({ documentId: z.string().min(1), bytesSha256: digest, filePage: z.number().int().positive(), quote: z.string().min(1) }).passthrough();
const units = cnyUnitPowers;
const fact = z.object({ metric: z.string().min(1), period, rawValue: z.string().min(1), unit: z.enum(['yuan', 'thousand_yuan', 'ten_thousand_yuan', 'million_yuan', 'hundred_million_yuan']),
  normalizedYuan: z.string().min(1), citation, priorPeriod: z.boolean().optional(), restated: z.boolean().optional() }).passthrough();
export const fixtureDatasetV2Schema = z.object({ schemaVersion: z.literal(2), datasetVersion: z.string().min(1),
  documents: z.array(z.object({ id: z.string().min(1), symbol: z.string().min(1), path: z.string().min(1), bytesSha256: digest, byteLength: z.number().int().positive(),
    period, pagesPath: z.string().min(1), pageCount: z.number().int().positive(), textSha256: digest, pagesSha256: digest.optional(),
    parserReceipt: z.object({ path: z.string().min(1), sha256: digest, schemaVersion: z.literal(2), status: z.enum(['ready', 'partial', 'unreadable']) }).passthrough(),
  }).passthrough()).min(1),
  cases: z.array(z.object({ id: z.string().min(1), company: z.object({ symbol: z.string().min(1), name: z.string().min(1) }).passthrough(),
    asOf: z.string().min(1), documentIds: z.array(z.string().min(1)).min(2), primaryDocumentIds: z.array(z.string().min(1)).length(2),
    supportingDocumentIds: z.array(z.string().min(1)), questions: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) }).passthrough()).length(3),
    answerabilityDrafts: caseAnswerabilitySchema,
    executionReadiness: z.object({ realExecutionBlocked: z.boolean(), reasons: z.array(z.string()) }).passthrough(),
    strata: z.array(z.enum(['normal_three_questions', 'cause_not_disclosed', 'basis_restatement_conflict', 'original_scan', 'long_document'])),
    reference: z.object({ facts: z.array(fact).min(6), comparisonFacts: z.array(fact).optional(),
      changes: z.array(z.object({ metric: z.string(), percentage: z.string(), comparisonBasis: z.enum(['restated_comparative', 'original_disclosure']).optional() }).passthrough()).length(3),
      riskCitations: z.array(citation).min(2),
    }).passthrough(),
  }).passthrough()).min(1),
  stratification: z.object({ layers: z.array(z.object({ id: z.string(), minimum: z.number().int().positive(), candidateCaseIds: z.array(z.string()),
    machineVerifiedCaseIds: z.array(z.string()), humanConfirmedCaseIds: z.array(z.string()), candidateCount: z.number().int().nonnegative(), confirmedCount: z.number().int().nonnegative() }).passthrough()) }).passthrough(),
}).passthrough();
type FixtureDatasetV2 = z.infer<typeof fixtureDatasetV2Schema>;
const norm = (s: string) => s.normalize('NFKC').replace(/\s/gu, '');
const equalAmount = (a: string, b: string) => subtract(decimal(a), decimal(b)).coefficient === 0n;
function referenceCitations(value: unknown): z.infer<typeof citation>[] {
  if (Array.isArray(value)) return value.flatMap(referenceCitations);
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if ('documentId' in record && 'filePage' in record && 'quote' in record) return [citation.parse(record)];
  return Object.values(record).flatMap(referenceCitations);
}

/** Validate amounts and comparison provenance with the shared exact production unit contract. */
export function verifyFixtureAmountsV2(sample: FixtureDatasetV2['cases'][number], documents: FixtureDatasetV2['documents']) {
  const docs = new Map(documents.map(d => [d.id, d]));
  for (const [isComparison, facts] of [[false, sample.reference.facts], [true, sample.reference.comparisonFacts || []]] as const) {
    for (const f of facts) {
      const doc = docs.get(f.citation.documentId);
      if (!doc || !sample.documentIds.includes(doc.id) || doc.symbol !== sample.company.symbol || doc.bytesSha256 !== f.citation.bytesSha256) throw new Error(`Reference scope/hash mismatch: ${sample.id}`);
      const samePeriod = doc.period.start === f.period.start && doc.period.end === f.period.end;
      if (!samePeriod && !(isComparison && f.priorPeriod === true && f.restated === true && f.period.end < doc.period.end)) throw new Error(`Reference period mismatch: ${sample.id}`);
      if (!equalAmount(decimalText(multiplyPowerOfTen(decimal(f.rawValue), units[f.unit])), f.normalizedYuan)) throw new Error(`Unit conversion mismatch: ${sample.id}`);
      const quoted = f.citation.quote.normalize('NFKC').replace(/,/g, '').replace(/−/g, '-').replace(/\(\s*([\d.]+)\s*\)/g, '-$1');
      const tokens = (quoted.match(/-?\d+(?:\.\d+)?/g) || []).map(token => token.replace(/^(-?)0+(?=\d)/, '$1'));
      if (!tokens.some(token => token.length <= 120 && (token.split('.')[1]?.length || 0) <= 20 && equalAmount(token, f.rawValue))) throw new Error(`Numeric value absent from quote: ${sample.id}`);
    }
  }
  for (const change of sample.reference.changes) {
    const candidates = change.comparisonBasis === 'restated_comparative' ? sample.reference.comparisonFacts : sample.reference.facts;
    if (!candidates) throw new Error(`Restated comparison facts required: ${sample.id}`);
    const pair = candidates.filter(f => f.metric === change.metric).sort((a, b) => a.period.end.localeCompare(b.period.end));
    if (pair.length !== 2 || pair[0].period.end === pair[1].period.end) throw new Error(`Expected two distinct comparison periods: ${sample.id}`);
    const calculated = percentChange(decimal(pair[0].normalizedYuan), decimal(pair[1].normalizedYuan));
    if (calculated === null) throw new Error(`Undefined zero-base percentage: ${sample.id}`);
    const delta = subtract(decimal(calculated), decimal(change.percentage));
    if (subtract({ ...delta, coefficient: delta.coefficient < 0n ? -delta.coefficient : delta.coefficient }, decimal('0.01')).coefficient > 0n) throw new Error(`Change reference mismatch: ${sample.id}:${change.metric}`);
  }
}

export async function verifyFixturesV2(datasetPath: string, outputDirectory?: string) {
  const raw = await readFile(datasetPath), dataset = fixtureDatasetV2Schema.parse(JSON.parse(raw.toString()));
  const pages = new Map<string, { page: number; text: string }[]>(), docIds = new Set<string>();
  for (const doc of dataset.documents) {
    if (docIds.has(doc.id)) throw new Error(`Duplicate document ID: ${doc.id}`);
    docIds.add(doc.id);
    const [original, pageBytes, receiptBytes] = await Promise.all([readFile(doc.path), readFile(doc.pagesPath), readFile(doc.parserReceipt.path)]);
    if (sha(original) !== doc.bytesSha256 || original.length !== doc.byteLength) throw new Error(`Changed original: ${doc.id}`);
    if (sha(receiptBytes) !== doc.parserReceipt.sha256) throw new Error(`Changed parser receipt: ${doc.id}`);
    const receipt = parsedReceiptSchema.parse(JSON.parse(receiptBytes.toString()));
    if (receipt.schemaVersion !== 2 || receipt.status !== doc.parserReceipt.status) throw new Error(`Parser receipt metadata mismatch: ${doc.id}`);
    if (receipt.originalSha256 !== doc.bytesSha256 || receipt.pageCount !== doc.pageCount) throw new Error(`Parser receipt original/page count mismatch: ${doc.id}`);
    if (typeof doc.announcementPath === 'string' && typeof doc.announcementSha256 === 'string' && sha(await readFile(doc.announcementPath)) !== doc.announcementSha256) throw new Error(`Changed source announcement: ${doc.id}`);
    if (doc.pagesSha256 && sha(pageBytes) !== doc.pagesSha256) throw new Error(`Changed pages: ${doc.id}`);
    const parsed: { page: number; text: string }[] = JSON.parse(pageBytes.toString());
    if (parsed.length !== doc.pageCount || new Set(parsed.map(p => p.page)).size !== parsed.length) throw new Error(`Page count/identity mismatch: ${doc.id}`);
    if (sha(parsed.map(p => `[第 ${p.page} 页]\n${p.text}`).join('\n')) !== doc.textSha256) throw new Error(`Changed text: ${doc.id}`);
    pages.set(doc.id, parsed);
  }
  let facts = 0, citations = 0;
  const caseIds = new Set<string>();
  for (const sample of dataset.cases) {
    if (caseIds.has(sample.id)) throw new Error(`Duplicate case ID: ${sample.id}`);
    caseIds.add(sample.id);
    if (new Set(sample.documentIds).size !== sample.documentIds.length || sample.documentIds.some(id => !docIds.has(id))) throw new Error(`Unknown/duplicate case document: ${sample.id}`);
    const assigned = [...sample.primaryDocumentIds, ...sample.supportingDocumentIds];
    if (new Set(assigned).size !== assigned.length || assigned.length !== sample.documentIds.length || assigned.some(id => !sample.documentIds.includes(id))) throw new Error(`Primary/supporting document mismatch: ${sample.id}`);
    const primary = sample.primaryDocumentIds.map(id => dataset.documents.find(d => d.id === id)!);
    if (primary.some(d => d.symbol !== sample.company.symbol) || new Set(primary.map(d => `${d.period.start}:${d.period.end}`)).size !== 2) throw new Error(`Primary company/period mismatch: ${sample.id}`);
    if (sample.answerabilityDrafts.caseId !== sample.id || sample.answerabilityDrafts.documentIds.some(id => !sample.primaryDocumentIds.includes(id))) throw new Error(`Answerability case binding mismatch: ${sample.id}`);
    for (const label of sample.answerabilityDrafts.questions) for (const range of label.checkedRanges) {
      const doc = dataset.documents.find(d => d.id === range.documentId);
      if (!doc || doc.bytesSha256 !== range.bytesSha256 || range.filePageEnd > doc.pageCount) throw new Error(`Answerability range/hash mismatch: ${sample.id}`);
    }
    verifyFixtureAmountsV2(sample, dataset.documents);
    const refs = referenceCitations(sample.reference);
    for (const ref of refs) {
      const doc = dataset.documents.find(d => d.id === ref.documentId);
      const text = pages.get(ref.documentId)?.find(p => p.page === ref.filePage)?.text;
      if (!doc || !sample.documentIds.includes(doc.id) || doc.bytesSha256 !== ref.bytesSha256 || !text || !norm(text).includes(norm(ref.quote))) throw new Error(`Missing/bad-scope citation: ${sample.id}:${ref.documentId}:${ref.filePage}`);
      citations++;
    }
    facts += sample.reference.facts.length;
  }
  const layerChecks = dataset.stratification.layers.map(layer => {
    if (new Set(layer.candidateCaseIds).size !== layer.candidateCaseIds.length || layer.candidateCaseIds.some(id => !caseIds.has(id))) throw new Error(`Invalid stratification cases: ${layer.id}`);
    if (layer.candidateCount !== layer.candidateCaseIds.length || layer.confirmedCount !== layer.humanConfirmedCaseIds.length ||
      (typeof layer.machineVerifiedCount === 'number' && layer.machineVerifiedCount !== layer.machineVerifiedCaseIds.length) ||
      new Set(layer.machineVerifiedCaseIds).size !== layer.machineVerifiedCaseIds.length || new Set(layer.humanConfirmedCaseIds).size !== layer.humanConfirmedCaseIds.length) throw new Error(`Layer count mismatch: ${layer.id}`);
    if ([...layer.machineVerifiedCaseIds, ...layer.humanConfirmedCaseIds].some(id => !layer.candidateCaseIds.includes(id))) throw new Error(`Layer confirmation outside candidates: ${layer.id}`);
    return { id: layer.id, minimum: layer.minimum, candidates: layer.candidateCount, machineVerified: layer.machineVerifiedCaseIds.length, humanConfirmed: layer.confirmedCount,
      candidateMinimumMet: layer.candidateCount >= layer.minimum, humanMinimumMet: layer.confirmedCount >= layer.minimum };
  });
  const unsupportedUnits = [...new Set(dataset.cases.flatMap(c => c.reference.facts.filter(f => !(f.unit in cnyUnitPowers)).map(f => f.unit)))];
  const result = { schemaVersion: 2, checkedAt: new Date().toISOString(), datasetVersion: dataset.datasetVersion, datasetSha256: sha(raw),
    sourceSha256: Object.fromEntries(await Promise.all(['scripts/research/verify-fixtures.ts', 'scripts/research/verify-fixtures-v2.ts', 'src/lib/company-research/exact-decimal.ts', 'src/lib/company-research/parsed-document.ts', 'src/lib/eval/financial-research-score-v2.ts'].map(async file => [file, sha(await readFile(file))]))),
    documents: pages.size, companies: new Set(dataset.cases.map(c => c.company.symbol)).size, cases: dataset.cases.length, questions: dataset.cases.length * 3,
    numericFacts: facts, validatedCitations: citations, layerChecks, productionUnsupportedUnits: unsupportedUnits,
    verification: 'source hashes, parser receipts, numeric references and located quotes; no human sign-off or production OCR claim',
    humanReview: 'new labels and layer coverage require explicit human receipts', productionBlockedCases: dataset.cases.filter(c => c.executionReadiness.realExecutionBlocked).map(c => ({ caseId: c.id, reasons: c.executionReadiness.reasons })),
    hidden: 'not read', modelCalls: 0 };
  const output = path.resolve(outputDirectory || path.join('data/research-agent-upgrade/evidence/U04', `verification-${randomUUID()}`));
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ evidence: output, ...result }));
  return result;
}
