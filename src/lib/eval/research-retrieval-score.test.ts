import { describe, expect, it } from 'vitest';
import { documentsInRetrievalScope, retrievalLabelsSchema, scoreRetrievedPages, summarizeRetrievalScores } from './research-retrieval-score';

describe('file-page retrieval scoring', () => {
  it('counts gold pages once and distinguishes documents with equal page numbers', () => {
    const hits = [{ key: 'a:3' }, { key: 'a:3' }, { key: 'b:3' }];
    const s = scoreRetrievedPages(['a:3', 'a:3', 'b:3'], { 1: hits, 3: hits, 5: hits, 10: hits }, hits);
    expect(s.atK[1]).toEqual({ hits: 1, total: 2, recall: .5 });
    expect(s.atK[3].recall).toBe(1);
    expect(s.reciprocalRank).toBe(1);
  });
  it('reports unrestricted page-level reciprocal rank, including misses', () => {
    const s = scoreRetrievedPages(['gold:2'], {}, [{ key: 'a:1' }, { key: 'a:1' }, { key: 'gold:2' }]);
    expect(s.firstRelevantRank).toBe(2);
    expect(s.reciprocalRank).toBe(.5);
    expect(s.atK[10].hits).toBe(0);
    const miss = scoreRetrievedPages(['missing:1'], {}, [{ key: 'a:1' }]);
    expect(miss.firstRelevantRank).toBeNull();
    expect(miss.reciprocalRank).toBe(0);
    expect(summarizeRetrievalScores([s, miss]).mrr).toBe(.25);
  });
  it('keeps micro and macro denominators separate and zero denominator unknown', () => {
    const one = scoreRetrievedPages(['a:1'], { 1: [{ key: 'a:1' }] }, []);
    const two = scoreRetrievedPages(['b:1', 'b:2'], {}, []);
    expect(summarizeRetrievalScores([one, two]).atK[1]).toMatchObject({ hits: 1, total: 3, recall: 1 / 3, macroRecall: .5 });
    expect(summarizeRetrievalScores([]).mrr).toBeNull();
    expect(summarizeRetrievalScores([]).atK[5].recall).toBeNull();
    expect(() => scoreRetrievedPages([], {}, [])).toThrow('Gold');
  });
  it('rejects duplicate query identities, missing gold and premature freezing', () => {
    const q = { id: 'q', caseId: 'c', questionId: 'q2', questionType: 'cash_flow_disclosure_scope', querySource: 'canonical', query: '现金流原因', origin: 'draft',
      expected: [{ documentId: 'd', bytesSha256: 'a'.repeat(64), filePage: 1, quote: '未发生重大变动', evidenceKind: 'disclosure_scope', reviewStatus: 'pending_review' }] };
    const labels = { schemaVersion: 2, version: 'v2', granularity: 'source_file_page', status: 'draft', notes: 'Not a proof of non-disclosure', queries: [q] };
    expect(retrievalLabelsSchema.safeParse(labels).success).toBe(true);
    expect(retrievalLabelsSchema.safeParse({ ...labels, status: 'frozen' }).success).toBe(false);
    expect(retrievalLabelsSchema.safeParse({ ...labels, queries: [q, q] }).success).toBe(false);
    expect(retrievalLabelsSchema.safeParse({ ...labels, queries: [{ ...q, expected: [] }] }).success).toBe(false);
    expect(retrievalLabelsSchema.safeParse({ ...labels, queries: [{ ...q, querySource: 'observed' }] }).success).toBe(false);
  });
  it('intersects the historical document and period scope and rejects unknown identities', () => {
    const documents = [{ id: 'a', period: { id: '2023' } }, { id: 'b', period: { id: '2024' } }];
    const request = { fields: ['risk'] as const, documentIds: ['b'], periodIds: ['2024'], topK: 3, indexVersion: 'v4' };
    const scope = { ...request, fields: [...request.fields] };
    expect(documentsInRetrievalScope(documents, scope)).toEqual([documents[1]]);
    expect(documentsInRetrievalScope(documents, { ...scope, periodIds: ['2023'] })).toEqual([]);
    expect(() => documentsInRetrievalScope(documents, { ...scope, documentIds: ['foreign'] })).toThrow('scope outside');
  });
});
