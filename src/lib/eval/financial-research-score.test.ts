import { describe, expect, it } from 'vitest';
import { scoreFinancialCase, summarizeScores, withinTolerance, type EvaluationCase } from './financial-research-score';
import { reportFixture } from '../company-research/version-test-fixtures';

describe('frozen financial evaluation scoring', () => {
  it('counts every missing required item and question rather than removing failures', () => {
    const sample: EvaluationCase = { id: 'test', company: {symbol: '600519.SH', name: 'test'}, asOf: '2025-06-30T15:59:59Z', documentIds: [], questions: [], reference: {
      facts: [{metric: 'revenue', period: {start:'2023-01-01',end:'2023-12-31'},rawValue:'1.00',unit:'yuan',normalizedYuan:'1'}], changes:[{metric:'revenue',percentage:'2'}] } };
    const score = scoreFinancialCase(sample, null, ['NO_REPORT']);
    expect(score).toMatchObject({numericPassed: 0, numericTotal: 2, completedQuestions: 0, questionTotal: 3});
    expect(summarizeScores([score])).toMatchObject({gatePassed: false, support: {rate: null}});
    const report = reportFixture();
    expect(scoreFinancialCase(sample, report, ['WRONG_ACTOR']).completedQuestions).toBe(0);
  });
  it('uses exact amount/percentage tolerances at the boundary', () => {
    expect(withinTolerance('170899152276.345', '170899152276.34', '0.005')).toBe(true);
    expect(withinTolerance('170899152276.346', '170899152276.34', '0.005')).toBe(false);
    expect(withinTolerance('-12.345', '-12.34', '0.005')).toBe(true);
    expect(withinTolerance(null, '0', '0.01')).toBe(false);
  });
});
