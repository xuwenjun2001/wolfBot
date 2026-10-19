import { describe, expect, it } from 'vitest';
import { reportFixture } from './version-test-fixtures';
import { retainedUpdateFacts } from './update-dependencies';

describe('report update dependencies', () => {
  it('invalidates a derived period and its claim inputs when the preceding cumulative source changes', () => {
    const report = reportFixture();
    const input = { ...report.facts[0], id: 'h1-input', period: { ...report.facts[0].period, id: 'H1' } };
    const derived = { ...report.facts[0], id: 'q3-derived', period: { ...report.facts[0].period, id: 'Q3' }, derivedFrom: ['h1-input'] };
    report.facts = [derived]; report.supportingFacts = [input];
    const result = retainedUpdateFacts(report, new Set(['H1']), new Map());
    expect([...result.invalid].sort()).toEqual(['h1-input', 'q3-derived']);
    expect(result.facts).toEqual([]); expect(result.supportingFacts).toEqual([]);
  });
  it('invalidates prior-period values disclosed in an affected later report and retains unrelated inputs', () => {
    const report = reportFixture(), fact = report.facts[0];
    report.supportingFacts = [{ ...fact, id: 'unrelated-input', citations: [{ ...fact.citations[0], documentId: 'unrelated' }] }];
    const result = retainedUpdateFacts(report, new Set(['new-period']), new Map([[`${fact.citations[0].documentId}:1`, 'new-period']]));
    expect(result.facts).toEqual([]); expect(result.supportingFacts.map(f => f.id)).toEqual(['unrelated-input']);
  });
});
