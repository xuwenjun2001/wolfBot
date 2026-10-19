import { decimal, subtract, multiplyPowerOfTen, cnyUnitPowers } from '../company-research/exact-decimal';
import { normalizedYuan } from '../company-research/financial-normalization';
import { financialChanges } from '../company-research/report-assembly';
import type { ResearchReportRevision } from '../company-research/revision-contracts';
import { wilsonScoreInterval } from './statistics';

export type EvaluationCase = { id: string; company: {symbol: string; name: string}; asOf: string; documentIds: string[];
  questions: {id: string; text: string}[]; reference: {facts: {metric: string; period: {start: string; end: string}; rawValue: string; unit: keyof typeof cnyUnitPowers; normalizedYuan: string}[];
  changes: {metric: string; percentage: string}[]} };
export function withinTolerance(actual: string | null, expected: string, tolerance: string) {
  if (actual === null) return false;
  const difference = subtract(decimal(actual), decimal(expected));
  const absolute = { ...difference, coefficient: difference.coefficient < 0n ? -difference.coefficient : difference.coefficient };
  return subtract(absolute, decimal(tolerance)).coefficient <= 0n;
}
export function scoreFinancialCase(sample: EvaluationCase, report: ResearchReportRevision | null, hardErrors: string[]) {
  const facts = sample.reference.facts.map(reference => {
    const fact = report?.facts.find(f => f.metric === reference.metric && f.period.start === reference.period.start && f.period.end === reference.period.end);
    const actual = fact?.value.status === 'known' ? normalizedYuan(fact) : null;
    const places = reference.rawValue.split('.')[1]?.length || 0;
    const rawTolerance = decimal(`0.${'0'.repeat(places)}5`);
    const scaled = multiplyPowerOfTen(rawTolerance, cnyUnitPowers[reference.unit]);
    // Compare at a common precision without converting amounts through Number.
    const difference = actual === null ? null : subtract(decimal(actual), decimal(reference.normalizedYuan));
    const passed = difference !== null && subtract({ ...difference, coefficient: difference.coefficient < 0n ? -difference.coefficient : difference.coefficient }, scaled).coefficient <= 0n;
    return { metric: reference.metric, period: reference.period.end, expected: reference.normalizedYuan, actual, passed };
  });
  const computed = report ? financialChanges(report) : [];
  const changes = sample.reference.changes.map(reference => {
    const value = computed.find(c => c.metric === reference.metric)?.comparison;
    const actual = value?.status === 'comparable' ? value.percentage : null;
    return { metric: reference.metric, expected: reference.percentage, actual, passed: withinTolerance(actual ?? null, reference.percentage, '0.01') };
  });
  const questions = ['income_profit', 'cash_flow', 'risks'].map(questionId => {
    const claims = report?.claims.filter(c => c.questionId === questionId) || [];
    const metrics = questionId === 'income_profit' ? ['revenue', 'parent_net_profit'] : questionId === 'cash_flow' ? ['operating_cash_flow'] : [];
    const numbersPassed = facts.filter(f => metrics.includes(f.metric)).every(f => f.passed) && changes.filter(c => metrics.includes(c.metric)).every(c => c.passed);
    return { questionId, completed: hardErrors.length === 0 && claims.length > 0 && claims.every(c => c.status === 'supported') && numbersPassed };
  });
  const claimCount = report?.claims.length || 0, supported = report?.claims.filter(c => c.status === 'supported').length || 0;
  return { facts, changes, numericPassed: [...facts, ...changes].filter(x => x.passed).length, numericTotal: sample.reference.facts.length + sample.reference.changes.length,
    questions, completedQuestions: questions.filter(q => q.completed).length, questionTotal: 3, claimCount, supportedClaims: supported, hardErrors };
}
export type EvaluationScore = ReturnType<typeof scoreFinancialCase>;
export function summarizeScores(scores: EvaluationScore[]) {
  const total = (key: 'numericPassed' | 'numericTotal' | 'completedQuestions' | 'questionTotal' | 'claimCount' | 'supportedClaims') => scores.reduce((sum, s) => sum + s[key], 0);
  const rate = (passed: number, count: number) => ({ passed, total: count, rate: count ? passed / count : null, wilson95: count ? wilsonScoreInterval(passed, count) : null });
  const numeric = rate(total('numericPassed'), total('numericTotal')), completion = rate(total('completedQuestions'), total('questionTotal')),
    support = rate(total('supportedClaims'), total('claimCount'));
  const hardPassed = scores.every(s => s.hardErrors.length === 0);
  return { companies: scores.length, numeric, completion, support, hardPassed,
    gatePassed: hardPassed && numeric.rate !== null && numeric.rate >= .95 && completion.rate !== null && completion.rate >= .8 && support.rate !== null && support.rate >= .9,
    uncertainty: 'One attempt per company; questions and claims within one company are correlated. Wilson intervals are descriptive, not independent-sample guarantees.' };
}
