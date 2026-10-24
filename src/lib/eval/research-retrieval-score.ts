import { z } from 'zod';
import { evidenceFieldSchema } from '../company-research/lexical-index';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pageSchema = z.object({
  documentId: z.string().min(1), bytesSha256: hash, filePage: z.number().int().positive(),
  quote: z.string().min(1), evidenceKind: z.enum(['causal_explanation', 'disclosure_scope', 'risk_statement', 'numeric']),
  reviewStatus: z.enum(['existing_reference', 'pending_review']),
}).strict();
export const retrievalLabelsSchema = z.object({
  schemaVersion: z.literal(2), version: z.string().min(1), granularity: z.literal('source_file_page'),
  status: z.enum(['draft', 'frozen']), notes: z.string().min(1),
  queries: z.array(z.object({
    id: z.string().min(1), caseId: z.string().min(1), questionId: z.enum(['q1', 'q2', 'q3']),
    questionType: z.enum(['numeric_control', 'cash_flow_reason', 'cash_flow_disclosure_scope', 'risk']),
    querySource: z.enum(['canonical', 'observed']), query: z.string().min(1).max(2000),
    origin: z.string().min(1), expected: z.array(pageSchema).min(1),
    observedRequest: z.object({ fields: z.array(evidenceFieldSchema), documentIds: z.array(z.string().min(1)), periodIds: z.array(z.string().min(1)),
      topK: z.number().int().positive().max(20).nullable(), indexVersion: z.string().nullable() }).strict().optional(),
  }).strict()).min(1),
}).strict().superRefine((labels, ctx) => {
  const ids = new Set<string>();
  for (const [i, q] of labels.queries.entries()) {
    if (ids.has(q.id)) ctx.addIssue({ code: 'custom', path: ['queries', i, 'id'], message: 'Duplicate query ID' });
    ids.add(q.id);
    if (q.querySource === 'observed' && !q.observedRequest) ctx.addIssue({ code: 'custom', path: ['queries', i, 'observedRequest'], message: 'Observed queries require the original request filters' });
    if (labels.status === 'frozen' && q.expected.some(p => p.reviewStatus !== 'existing_reference'))
      ctx.addIssue({ code: 'custom', path: ['queries', i, 'expected'], message: 'Unreviewed gold pages cannot be frozen' });
  }
});
export type RetrievalLabels = z.infer<typeof retrievalLabelsSchema>;
export function documentsInRetrievalScope<T extends { id: string; period: { id: string } }>(documents: T[], request: NonNullable<RetrievalLabels['queries'][number]['observedRequest']>) {
  if (request.documentIds.some(id => !documents.some(d => d.id === id)) || request.periodIds.some(id => !documents.some(d => d.period.id === id))) throw new Error('Observed request scope outside case');
  return documents.filter(d => (!request.documentIds.length || request.documentIds.includes(d.id)) && (!request.periodIds.length || request.periodIds.includes(d.period.id)));
}
export const retrievalKs = [1, 3, 5, 10] as const;
export type PageHit = { key: string };

/** Duplicated chunks on a source page never increase a page-level hit count. */
export function scoreRetrievedPages(expectedPages: string[], retrievedByK: Record<number, PageHit[]>, fullRanking: PageHit[]) {
  const expected = new Set(expectedPages);
  if (!expected.size) throw new Error('Gold source pages are required');
  const atK = Object.fromEntries(retrievalKs.map(k => {
    const retrieved = new Set((retrievedByK[k] || []).slice(0, k).map(p => p.key));
    const hits = [...expected].filter(p => retrieved.has(p)).length;
    return [k, { hits, total: expected.size, recall: hits / expected.size }];
  }));
  const unique = [...new Set(fullRanking.map(p => p.key))];
  const index = unique.findIndex(key => expected.has(key));
  return { atK, firstRelevantRank: index < 0 ? null : index + 1, reciprocalRank: index < 0 ? 0 : 1 / (index + 1) };
}
export type RetrievalPageScore = ReturnType<typeof scoreRetrievedPages>;
export function summarizeRetrievalScores(scores: RetrievalPageScore[]) {
  const atK = Object.fromEntries(retrievalKs.map(k => {
    const hits = scores.reduce((s, q) => s + q.atK[k].hits, 0);
    const total = scores.reduce((s, q) => s + q.atK[k].total, 0);
    return [k, { hits, total, recall: total ? hits / total : null,
      macroRecall: scores.length ? scores.reduce((s, q) => s + q.atK[k].recall, 0) / scores.length : null }];
  }));
  return { queryCount: scores.length, atK, mrr: scores.length ? scores.reduce((s, q) => s + q.reciprocalRank, 0) / scores.length : null };
}
