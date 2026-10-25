import { describe, it, expect } from 'vitest';
import { numericFactErrors, claimReviewHash, semanticPublicationErrors } from './claim-verification';
import { documentFixture, reportFixture, specFixture } from './version-test-fixtures';
import { reportBindingErrors } from './revision-contracts';
import { assembleFinancialReport } from './report-assembly';
import { emptyCheckpoint } from './execution-contracts';
const page = '单位：元 币种：人民币\n2024年 2023年\n经营活动产生的现金流量净额 250.00 100.00';
function fixture() {
  const report = reportFixture(), fact = report.facts[0], doc = { ...documentFixture(report.taskId), state: 'partial' as const };
  fact.value = { status: 'known', raw: '250.00', unit: 'yuan', currency: 'CNY', decimals: 2 }; fact.citations[0].quote = '经营活动产生的现金流量净额 250.00 100.00';
  return { report, fact, doc };
}
describe('layered publication and local repair', () => {
  it('checks units and first-period columns instead of only numeric occurrence', () => {
    const { fact, doc } = fixture(); expect(numericFactErrors(fact, [doc], () => page)).toEqual([]);
    fact.value = { status: 'known', raw: '100.00', unit: 'yuan', currency: 'CNY', decimals: 2 };
    expect(numericFactErrors(fact, [doc], () => page)).toContain('FACT_PERIOD_COLUMN_MISMATCH');
    fact.value.unit = 'ten_thousand_yuan'; expect(numericFactErrors(fact, [doc], () => page)).toContain('FACT_UNIT_UNVERIFIED');
  });
  it('binds amounts to reversed year columns and rejects absent or ambiguous column headers', () => {
    const { fact, doc } = fixture();
    const check = (text: string, raw = '250.00') => {
      fact.value = { status: 'known', raw, unit: 'yuan', currency: 'CNY', decimals: 2 };
      fact.citations[0].quote = text;
      return numericFactErrors(fact, [doc], () => text);
    };
    const reverse = '单位：元 2023年 2024年 经营活动产生的现金流量净额 100.00 250.00';
    expect(check(reverse)).toEqual([]);
    expect(check(reverse, '100.00')).toContain('FACT_PERIOD_COLUMN_MISMATCH');
    for (const header of ['单位：元', '2024年年度报告 单位：元', '单位：元 2024年 2024年', '单位：元 2023年 2024年 调整前 调整后']) {
      expect(check(`${header} 经营活动产生的现金流量净额 250.00 100.00`)).toContain('FACT_PERIOD_COLUMN_MISMATCH');
    }
    expect(check('单位：元 2023年 2024年 经营活动产生的现金流量净额 100.00 营业收入 250.00')).toContain('FACT_PERIOD_COLUMN_MISMATCH');
  });
  it('uses the exact metric row unit, while rejecting a different metric unit or missing year column', () => {
    const { fact, doc } = fixture();
    const row = '经营活动产生的现金流量净额（元） 250.00 100.00';
    fact.citations[0].quote = row;
    expect(numericFactErrors(fact, [doc], () => `2024年 2023年\n${row}`)).toEqual([]);
    expect(numericFactErrors(fact, [doc], () => `2024年年度报告\n${row}`)).toContain('FACT_PERIOD_COLUMN_MISMATCH');
    const wrong = '2024年 2023年\n营业收入（元） 800.00 500.00\n经营活动产生的现金流量净额 250.00 100.00';
    fact.citations[0].quote = '经营活动产生的现金流量净额 250.00 100.00';
    expect(numericFactErrors(fact, [doc], () => wrong)).toContain('FACT_UNIT_UNVERIFIED');
    fact.citations[0].quote = row;
    expect(numericFactErrors(fact, [doc], () => `单位：万元 2024年 2023年\n${row}`)).toContain('FACT_UNIT_UNVERIFIED');
  });
  it.each([['千元', 'thousand_yuan'], ['万元', 'ten_thousand_yuan'], ['亿元', 'hundred_million_yuan']] as const)('preserves the scale of a row declared in %s', (label, unit) => {
    const { fact, doc } = fixture();
    const row = `经营活动产生的现金流量净额（人民币${label}） 250.00 100.00`;
    fact.value = { status: 'known', raw: '250.00', unit, currency: 'CNY', decimals: 2 };
    fact.citations[0].quote = row;
    expect(numericFactErrors(fact, [doc], () => `2024年 2023年\n${row}`)).toEqual([]);
    fact.value.unit = 'yuan';
    expect(numericFactErrors(fact, [doc], () => `2024年 2023年\n${row}`)).toContain('FACT_UNIT_UNVERIFIED');
  });
  it.each(['(250.00)', '（２５０．００）', '-250.00', '−250.00'])('preserves the sign in %s and compares complete amount tokens', amount => {
    const { fact, doc } = fixture(), text = `单位：元 2024年 2023年 经营活动产生的现金流量净额 ${amount} 100.00`;
    fact.citations[0].quote = text;
    fact.value = { status: 'known', raw: '-250.00', unit: 'yuan', currency: 'CNY', decimals: 2 };
    expect(numericFactErrors(fact, [doc], () => text)).toEqual([]);
    fact.value.raw = '250.00';
    expect(numericFactErrors(fact, [doc], () => text)).toContain('FACT_PERIOD_COLUMN_MISMATCH');
    expect(numericFactErrors(fact, [doc], () => text)).toContain('FACT_QUOTED_NUMBER_MISMATCH');
  });
  it.each(['company', 'period', 'quote', 'future'] as const)('rejects %s binding errors before semantics', kind => {
    const { report, doc } = fixture();
    if (kind === 'company') doc.company = { ...doc.company, symbol: '600036.SH' };
    if (kind === 'period') doc.period = { ...doc.period, id: '2022', start: '2022-01-01', end: '2022-12-31' };
    if (kind === 'quote') report.claims[0].citations[0].quote = '伪造引用';
    if (kind === 'future') doc.disclosure = { status: 'unknown', reason: 'future information' };
    expect(reportBindingErrors(report, specFixture(), [doc], () => page).length).toBeGreaterThan(0);
  });
  it('does not call a real quote semantic proof, and rejects a trusted opposite-meaning verdict', () => {
    const { report } = fixture(), claim = report.claims[0]; claim.text = '经营现金流下降';
    expect(semanticPublicationErrors(report, [])).toEqual(['CLAIM_REVIEW_MISSING:claim1']);
    expect(semanticPublicationErrors(report, [{ version: 'claim-review-v1', claimHash: claimReviewHash(report, claim), verdict: 'conflict', reason: '原文是增长', method: 'human', reviewer: 'test-reviewer', independence: 'human', calibration: 'test', reviewedAt: new Date().toISOString() }])).toEqual(['CLAIM_SEMANTIC_CONFLICT:claim1']);
  });
  it('invalidates only claims depending on changed facts; missing questions cannot disappear', () => {
    const { report } = fixture(), claim = report.claims[0], before = claimReviewHash(report, claim);
    const unrelated = { ...report.facts[0], id: 'unrelated' }; report.facts.push(unrelated);
    expect(claimReviewHash(report, claim)).toBe(before);
    report.facts[0] = { ...report.facts[0], value: { status: 'missing', reason: 'repair' } };
    expect(claimReviewHash(report, claim)).not.toBe(before);
    const state = emptyCheckpoint(1, 1); state.submitted = true;
    const partial = assembleFinancialReport(report.taskId, specFixture(), 1, 1, state, 'test');
    expect(partial.status).toBe('partial'); expect(partial.gaps).toHaveLength(9);
  });
  it('reports persisted model rounds while leaving historical unknown counts absent', () => {
    const { report } = fixture(), state = emptyCheckpoint(1, 1);
    expect(assembleFinancialReport(report.taskId, specFixture(), 1, 1, state, 'test').method).not.toHaveProperty('modelTurns');
    state.modelTurns = 5;
    expect(assembleFinancialReport(report.taskId, specFixture(), 1, 1, state, 'test').method).toMatchObject({ modelTurns: 5 });
  });
});
