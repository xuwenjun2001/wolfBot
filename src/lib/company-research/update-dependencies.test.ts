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
  it('invalidates comparisons and calculated dependants when their accounting-basis evidence changes', () => {
    const report = reportFixture(), base = report.facts[0];
    const limitation = { ...base.citations[0], documentId: 'accounting-note', documentVersion: 2 };
    const input = { ...base, id: 'basis-input', accountingBasisEvidence: [limitation] };
    const derived = { ...base, id: 'derived', derivedFrom: [input.id] };
    report.facts = [derived, { ...base, id: 'unrelated' }]; report.supportingFacts = [input];
    const result = retainedUpdateFacts(report, new Set(['changed-note-period']), new Map([['accounting-note:2', 'changed-note-period']]));
    expect([...result.invalid].sort()).toEqual(['basis-input', 'derived']);
    expect(result.facts.map(fact => fact.id)).toEqual(['unrelated']);
    expect(result.supportingFacts).toEqual([]);
  });
});
