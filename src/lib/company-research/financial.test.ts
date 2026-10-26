import { describe, expect, it } from 'vitest';
import { reportFixture } from './version-test-fixtures';
import { financialFactSchema, type FinancialFact } from './document-contracts';
import { compareFinancialFacts, deriveSingleQuarter } from './financial-comparison';
import { disclosedAmount, factFromDisclosure, financialMetric, normalizedYuan } from './financial-normalization';
const base = () => reportFixture().facts[0];
function pair(before: string, after: string) {
  const b = base(), a = { ...b, id: 'before', period: { ...b.period, id: 'fy2023', start: '2023-01-01', end: '2023-12-31' }, value: { ...b.value, status: 'known' as const, raw: before, unit: 'yuan' as const, currency: 'CNY' as const, decimals: 12 } };
  return [a, { ...b, id: 'after', value: { ...a.value, raw: after } }] as const;
}
describe('deterministic financial normalization', () => {
  it.each([['1.20', '万元', '12000'], ['1.23', '亿元', '123000000'], ['407,149,600', '千元', '407149600000'], ['913,789', '百万元', '913789000000'], ['1.23456789', '单位：百万元 币种：人民币', '1234567.89'], ['(1,234.50)', '元', '-1234.5'], ['−56.78', '元', '-56.78'], ['０.００', '元', '0']])('normalizes %s %s exactly', (raw, unit, expected) => {
    expect(disclosedAmount(raw, unit)).toMatchObject({ status: 'known', normalizedYuan: expected });
  });
  it('keeps unknown/missing/zero separate and rejects percentages, per-share and broken grouping', () => {
    expect(disclosedAmount('—', '元').status).toBe('missing');
    expect(disclosedAmount('0', '元').status).toBe('known');
    for (const [raw, unit] of [['1,23.45', '元'], ['1.20%', '元'], ['2', '元/股'], ['(1.00', '元'], ['1', '港元']]) expect(disclosedAmount(raw, unit).status).toBe('invalid');
    expect(financialMetric('营业总收入')).toBe('total_operating_income');
    expect(financialMetric('营业收入（千元）')).toBe('revenue');
    expect(financialMetric('营业收入（人民币百万元）')).toBe('revenue');
    expect(financialMetric('每股经营活动现金流')).toBeNull();
    expect(financialMetric('归属于上市公司股东的净利润（扣非）')).toBeNull();
    expect(financialMetric('营业收入（不含某业务）')).toBeNull();
  });
  it('retains display precision and refuses unreviewed OCR as known facts', () => {
    const context = base(), fact = factFromDisclosure(context, '1,234.50', '万元', 'native');
    expect(fact.normalization).toMatchObject({ rawText: '1,234.50', normalizedYuan: '12345000' });
    expect(normalizedYuan(fact)).toBe('12345000');
    expect(factFromDisclosure(context, '1,234.50', '万元', 'needs_review').value).toEqual({ status: 'missing', reason: 'source_requires_review' });
    expect(financialFactSchema.safeParse({ ...fact, normalization: { ...fact.normalization, normalizedYuan: '1' } }).success).toBe(false);
    for (const raw of ['NaN', '0.' + '1'.repeat(30)]) expect(financialFactSchema.safeParse({ ...fact, value: { ...fact.value, status: 'known', raw } }).success).toBe(false);
  });
});
describe('comparison and quarter derivation', () => {
  it.each([['0', '10', null, 'zero_base'], ['-100', '-50', '50.000000', 'negative_base_absolute_denominator'], ['-100', '100', '200.000000', 'negative_base_absolute_denominator'], ['3', '4', '33.333333', 'positive_base'], ['0.10', '0.30', '200.000000', 'positive_base']])('compares %s to %s', (before, after, percentage, percentageReason) => {
    expect(compareFinancialFacts(...pair(before, after))).toMatchObject({ status: 'comparable', percentage, percentageReason });
  });
  it('uses arbitrary precision and converts differing source units only once', () => {
    expect(compareFinancialFacts(...pair('999999999999999999.99', '1000000000000000000.00'))).toMatchObject({ deltaYuan: '0.01' });
    const [a, b] = pair('1', '11000');
    const first = financialFactSchema.parse({ ...a, value: { ...a.value, unit: 'hundred_million_yuan' } });
    const last = financialFactSchema.parse({ ...b, value: { ...b.value, unit: 'ten_thousand_yuan' } });
    expect(compareFinancialFacts(first, last)).toMatchObject({ deltaYuan: '10000000', percentage: '10.000000' });
  });
  it('rejects period/scope/restatement mismatch and leaves conflicts unresolved', () => {
    const [a, b] = pair('100', '110');
    expect(compareFinancialFacts(a, { ...b, scope: 'parent' })).toMatchObject({ status: 'incomparable', reason: 'scope_mismatch' });
    expect(compareFinancialFacts(a, { ...b, restatement: 'restated' })).toMatchObject({ status: 'incomparable', reason: 'restatement_basis_unresolved' });
    expect(compareFinancialFacts({ ...a, accountingBasis: 'restatement-v2' }, { ...b, accountingBasis: 'restatement-v2', restatement: 'restated' })).toMatchObject({ status: 'incomparable', reason: 'accounting_basis_evidence_unresolved' });
    expect(compareFinancialFacts(a, { ...b, period: { ...b.period, kind: 'interim', end: '2024-06-30' } })).toMatchObject({ status: 'incomparable' });
    expect(compareFinancialFacts(a, { ...b, value: { status: 'missing', reason: 'not disclosed' } })).toMatchObject({ status: 'missing' });
    expect(compareFinancialFacts(a, { ...b, value: { status: 'conflict', alternatives: [a.value, b.value], reason: 'two sources' } } as FinancialFact)).toMatchObject({ status: 'conflict' });
  });
  it('derives single-quarter values only from complete adjacent matching YTD', () => {
    const [a, b] = pair('100', '250');
    const q1: FinancialFact = { ...a, period: { id: '2024Q1', start: '2024-01-01', end: '2024-03-31', kind: 'quarter', basis: 'cumulative' } };
    const h1: FinancialFact = { ...b, period: { id: '2024H1', start: '2024-01-01', end: '2024-06-30', kind: 'interim', basis: 'cumulative' } };
    expect(deriveSingleQuarter(h1, q1)).toMatchObject({ value: { raw: '150' }, period: { start: '2024-04-01', end: '2024-06-30', basis: 'single_quarter' }, derivedFrom: ['after', 'before'] });
    expect(deriveSingleQuarter(q1, null).value).toMatchObject({ raw: '100' });
    expect(() => deriveSingleQuarter(h1, null)).toThrow('preceding_ytd_required');
    expect(() => deriveSingleQuarter(h1, { ...q1, scope: 'parent' })).toThrow('same_basis');
    expect(() => deriveSingleQuarter(h1, { ...q1, value: { status: 'missing', reason: 'missing' } })).toThrow('complete_verified');
    const q3 = { ...h1, id: 'q3', period: { ...h1.period, id: '2024Q3', end: '2024-09-30', kind: 'quarter' as const }, value: { ...h1.value, status: 'known' as const, raw: '300', unit: 'yuan' as const, currency: 'CNY' as const, decimals: 0 } };
    expect(deriveSingleQuarter(q3, h1)).toMatchObject({ value: { raw: '50' }, period: { start: '2024-07-01', end: '2024-09-30' } });
    const full = { ...q3, id: 'fy', period: { ...q3.period, id: '2024FY', kind: 'annual' as const, end: '2024-12-31' }, value: { ...q3.value, raw: '280' } };
    expect(deriveSingleQuarter(full, q3)).toMatchObject({ value: { raw: '-20' }, period: { start: '2024-10-01', end: '2024-12-31' } });
    expect(() => deriveSingleQuarter(full, h1)).toThrow('same_basis');
  });
});
