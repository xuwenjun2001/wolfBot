import { describe, expect, it } from 'vitest';
import type { FinancialFact, VersionedCitation } from './document-contracts';
import { financialFactSchema } from './document-contracts';
import { compareFinancialFacts, selectFinancialComparisonPair } from './financial-comparison';
import { comparisonCompletion, disclosedResearchFact, mergeResearchFact, projectFinancialWrite, recordFinancialFactSchema } from './financial-material';
import { numericFactErrors } from './claim-verification';
import { documentFixture, reportFixture, specFixture } from './version-test-fixtures';
import { emptyCheckpoint } from './execution-contracts';
import { assembleFinancialReport, financialChanges } from './report-assembly';
import { normalizedYuan } from './financial-normalization';
import { financialContextState } from './financial-observation';

const spec = specFixture(), citation = reportFixture().facts[0].citations[0];
const headerText = '2024年 2023年 同比变动(%) 2022年\n（人民币百万元） 调整前 调整后(1) 调整后';
const row = '经营活动产生的现金流量净额 360,403 485,905 476,776 (24.4) 90,116';
const note = '注：(1)比较期间已按新保险合同准则追溯调整；投资业务未追溯调整。';
const header: VersionedCitation = { ...citation, quote: headerText };
const basisEvidence: VersionedCitation = { ...citation, quote: note };
const input = (periodId: string, rawText: string) => ({ periodId, metric: 'operating_cash_flow' as const, rawText, unitLabel: '百万元', citations: [{ ...citation, quote: row }] });
function comparativeFacts() {
  const original = disclosedResearchFact(spec, { ...input(spec.periods[0].id, '485,905'), citations: [{ ...citation, documentId: 'annual-2023', bytesSha256: 'b'.repeat(64), quote: '经营活动产生的现金流量净额 485,905' }] });
  const context = { accountingBasis: 'annual-2024-comparative', periodEvidence: [header], accountingBasisEvidence: [basisEvidence], comparisonLimitations: ['投资业务未追溯调整。'] };
  const before = disclosedResearchFact(spec, { ...input(spec.periods[0].id, '476,776'), ...context, restatement: 'restated' });
  const after = disclosedResearchFact(spec, { ...input(spec.periods[1].id, '360,403'), ...context, restatement: 'original' });
  return { original, before, after };
}

describe('disclosed financial comparison basis', () => {
  it('validates the real record_fact input without giving a basis label authority', () => {
    expect(recordFinancialFactSchema.safeParse(input(spec.periods[0].id, '485,905')).success).toBe(true);
    for (const extra of [
      { restatement: 'restated' }, { restatement: 'restated', accountingBasis: 'tag' },
      { comparisonLimitations: ['unverified limitation'] },
    ]) expect(recordFinancialFactSchema.safeParse({ ...input(spec.periods[0].id, '476,776'), ...extra }).success).toBe(false);
    const { before } = comparativeFacts();
    expect(before.value).toMatchObject({ status: 'known', raw: '476776', unit: 'million_yuan' });
    expect(financialFactSchema.safeParse({ ...before, value: { ...before.value, currency: 'USD' } }).success).toBe(false);
    expect(financialFactSchema.safeParse({ ...before, sourceQuality: 'needs_review' }).success).toBe(false);
  });

  it('keeps the original separate, selects the disclosed comparative pair, and carries restrictions and evidence', () => {
    const { original, before, after } = comparativeFacts(), originalBytes = JSON.stringify(original);
    let facts: FinancialFact[] = [];
    for (const fact of [original, before, after]) facts = mergeResearchFact(facts, fact);
    expect(facts).toHaveLength(3);
    expect(new Set(facts.map(f => f.id)).size).toBe(3);
    expect(original.id).toBe(`${spec.periods[0].id}-operating_cash_flow`);
    expect(JSON.stringify(facts.find(f => f.id === original.id))).toBe(originalBytes);
    const change = financialChanges({ facts, periodIds: [spec.periods[0].id, spec.periods[1].id] })[2];
    expect(change).toMatchObject({ before: { id: before.id }, after: { id: after.id }, comparison: {
      status: 'comparable', comparisonBasis: 'disclosed_comparative', beforeYuan: '476776000000', afterYuan: '360403000000', percentage: '-24.408318',
      limitations: expect.arrayContaining(['投资业务未追溯调整。']), citations: expect.arrayContaining([header, basisEvidence]),
    } });
    if (change.comparison?.status !== 'comparable') throw new Error('Expected located comparative pair');
    expect(change.comparison.limitations.some(limit => limit.includes('不据此认定'))).toBe(true);
    expect(disclosedResearchFact(spec, { ...input(spec.periods[0].id, '476,776'), restatement: 'restated', accountingBasis: before.accountingBasis, periodEvidence: [header] }).id).toBe(before.id);
  });

  it('retains same-basis conflicts without overwriting originals or clearing them with an invalid amount', () => {
    const { original, before } = comparativeFacts();
    const changed = { ...before, normalization: undefined, value: { status: 'known' as const, raw: '1', unit: 'million_yuan' as const, currency: 'CNY' as const, decimals: 0 } };
    const facts = mergeResearchFact([original, before], changed);
    expect(facts.find(f => f.id === before.id)?.value.status).toBe('conflict');
    expect(facts.find(f => f.id === original.id)).toEqual(original);
    expect(mergeResearchFact(facts, before)).toBe(facts);
    const omittedRestrictions = mergeResearchFact([before], { ...before, accountingBasisEvidence: undefined, comparisonLimitations: undefined });
    expect(omittedRestrictions[0]).toMatchObject({ accountingBasisEvidence: before.accountingBasisEvidence, comparisonLimitations: before.comparisonLimitations });
    expect(mergeResearchFact([original], { ...original, normalization: undefined, value: { status: 'missing', reason: 'invalid retry' } })).toEqual([original]);
    expect(() => mergeResearchFact([original], { ...before, id: original.id })).toThrow('FACT_IDENTITY_MISMATCH');
  });

  it('projects exactly the versioned writer identity for budget admission without mutating the checkpoint', () => {
    const state = emptyCheckpoint(1, 1), { original, before } = comparativeFacts(); state.facts = [original];
    const projected = projectFinancialWrite(spec, state, 'record_fact', { ...input(spec.periods[0].id, '476,776'),
      restatement: 'restated', accountingBasis: before.accountingBasis, periodEvidence: [header], accountingBasisEvidence: [basisEvidence], comparisonLimitations: before.comparisonLimitations });
    expect(state.facts).toEqual([original]);
    expect(projected.facts).toEqual([original, before]);
  });

  it('never falls back to originals for a half pair, multiple bases or unlocated matching basis names', () => {
    const { original, before, after } = comparativeFacts();
    const currentOriginal = { ...after, id: 'current-original', accountingBasis: undefined, periodEvidence: undefined };
    const check = (facts: FinancialFact[]) => selectFinancialComparisonPair(facts, [spec.periods[0].id, spec.periods[1].id], 'operating_cash_flow');
    expect(check([original, currentOriginal, before])).toMatchObject({ before: null, after: null, comparison: { status: 'incomparable', reason: 'comparison_basis_incomplete' } });
    expect(check([original, before, after, { ...before, id: 'other', accountingBasis: 'another-standard' }])).toMatchObject({ comparison: { status: 'incomparable', reason: 'comparison_basis_ambiguous' } });
    expect(compareFinancialFacts({ ...before, periodEvidence: undefined }, after)).toMatchObject({ status: 'incomparable', reason: 'accounting_basis_evidence_unresolved' });
    const otherSource = { ...after, periodEvidence: after.periodEvidence?.map(c => ({ ...c, documentId: 'another-report' })) };
    expect(compareFinancialFacts(before, otherSource).status).toBe('incomparable');
    const otherPage = { ...after, citations: after.citations.map(c => ({ ...c, locator: { kind: 'page' as const, filePage: 6 } })) };
    expect(compareFinancialFacts(before, otherPage).status).toBe('incomparable');
    expect(compareFinancialFacts(before, { ...after, accountingBasis: 'unrelated-standard' })).toMatchObject({ status: 'incomparable' });
  });

  it('keeps all required-number coverage but marks an incomplete comparison basis partial', () => {
    const state = emptyCheckpoint(1, 1), { original, before, after } = comparativeFacts();
    state.facts = spec.periods.flatMap(period => (['revenue', 'parent_net_profit', 'operating_cash_flow'] as const).map(metric => ({ ...original, id: `${period.id}-${metric}`, period, metric })));
    state.facts.push(before);
    state.claims = [{ ...reportFixture().claims[0], factIds: [original.id] }];
    expect(comparisonCompletion(spec, state, 'cash_flow')).toMatchObject({ status: 'incomplete', missing: expect.arrayContaining(['operating_cash_flow-comparison:comparison_basis_incomplete']) });
    const report = assembleFinancialReport(reportFixture().taskId, spec, 1, 1, state, 'fixture');
    expect(report.status).toBe('partial');
    expect(report.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'incomparable_period', questionId: 'cash_flow' })]));
    state.facts.push(after);
    expect(comparisonCompletion(spec, state, 'cash_flow').status).toBe('completed');
    const view = financialContextState(state, true);
    expect(view.facts.find(f => f.id === before.id)).toMatchObject({ accountingBasis: before.accountingBasis,
      periodEvidence: [expect.objectContaining({ quoteTruncated: false })], accountingBasisEvidence: [expect.objectContaining({ quote: note })], comparisonLimitations: before.comparisonLimitations });
    expect(assembleFinancialReport(reportFixture().taskId, spec, 1, 1, state, 'fixture').method?.dataHashes).toContain(citation.bytesSha256);
    expect(normalizedYuan(original)).toBe('485905000000');
  });
});

describe('native restatement column verification', () => {
  const doc = documentFixture();
  const page = `${headerText}\n${row}\n${note}\n单位：人民币元\n2024年 2023年\n每股收益 2.00 3.00`;
  it('binds both amounts to their real columns and scopes million units before a later per-share table', () => {
    const { before, after } = comparativeFacts();
    expect(numericFactErrors(before, [doc], () => page)).toEqual([]);
    expect(numericFactErrors(after, [doc], () => page)).toEqual([]);
    expect(numericFactErrors({ ...before, value: { status: 'known', raw: '485905', unit: 'million_yuan', currency: 'CNY', decimals: 0 }, normalization: undefined }, [doc], () => page)).toContain('FACT_PERIOD_COLUMN_MISMATCH');
    expect(numericFactErrors({ ...before, value: { status: 'known', raw: '476776', unit: 'ten_thousand_yuan', currency: 'CNY', decimals: 0 }, normalization: undefined }, [doc], () => page)).toContain('FACT_UNIT_UNVERIFIED');
  });

  it('separates narrative and earlier balance-sheet years, and excludes the following year heading from cash amounts', () => {
    const { before, after } = comparativeFacts();
    const earlierTable = '2024年 2023年末 2022年\n（人民币百万元）\n总资产 1000 900 800\n股东权益 300 250 200';
    const nextTable = '2024年末 2023年末\n总资产 1 2';
    const text = `2023年股东大会聘请会计师出具2024年年报\n${earlierTable}\n${headerText}\n${row}\n${nextTable}\n${note}`;
    expect(numericFactErrors(before, [doc], () => text)).toEqual([]);
    expect(numericFactErrors(after, [doc], () => text)).toEqual([]);
    expect(numericFactErrors({ ...before, periodEvidence: [{ ...header, quote: earlierTable }] }, [doc], () => text)).toContain('FACT_COMPARISON_HEADER_UNVERIFIED');
    const nextYearAsAmount = { ...before, normalization: undefined, value: { status: 'known' as const, raw: '2024', unit: 'million_yuan' as const, currency: 'CNY' as const, decimals: 0 } };
    expect(numericFactErrors(nextYearAsAmount, [doc], () => text)).toContain('FACT_PERIOD_COLUMN_MISMATCH');
  });

  it.each([
    ['2024年 2023年 本期比上年同期增减(%) 2022年\n调整后 调整前', '360,403 476,776 485,905 (24.4) 90,116'],
    ['2024年 2023年（调整后）', '360,403 476,776'],
    ['2024年 2023年\n调整前 调整后', '360,403 485,905 476,776'],
  ])('supports the explicit adjusted header %s', (heading, amounts) => {
    const { before } = comparativeFacts(), numericRow = `经营活动产生的现金流量净额 ${amounts}`;
    const fact = { ...before, citations: [{ ...citation, quote: numericRow }], periodEvidence: [{ ...citation, quote: heading }] };
    expect(numericFactErrors(fact, [doc], () => `单位：人民币百万元\n${heading}\n${numericRow}\n${note}`)).toEqual([]);
  });

  it('requires a real located header, an actual restatement marker, and all original basis evidence', () => {
    const { before } = comparativeFacts();
    expect(numericFactErrors({ ...before, periodEvidence: [{ ...header, quote: '2023年（调整后）' }] }, [doc], () => page)).toContain('FACT_COMPARISON_HEADER_UNVERIFIED');
    expect(numericFactErrors({ ...before, periodEvidence: [{ ...header, locator: { kind: 'page', filePage: 6 } }] }, [doc], () => page)).toContain('FACT_PERIOD_COLUMN_MISMATCH');
    expect(numericFactErrors({ ...before, accountingBasisEvidence: [{ ...basisEvidence, quote: '不存在的准则限制原文' }] }, [doc], () => page)).toContain('FACT_BASIS_ORIGINAL_MISSING');
    const ordinary = '2024年 2023年', numericRow = '经营活动产生的现金流量净额 360,403 476,776';
    const unproved = { ...before, citations: [{ ...citation, quote: numericRow }], periodEvidence: [{ ...header, quote: ordinary }], accountingBasisEvidence: undefined };
    expect(numericFactErrors(unproved, [doc], () => `单位：百万元\n${ordinary}\n${numericRow}`)).toContain('FACT_RESTATEMENT_UNVERIFIED');
  });

  it.each([
    ['2024年 2023年 2023年\n调整前 调整后', '360,403 485,905 476,776'],
    ['2024年 2023年 2022年\n调整前 调整后 调整前 调整后', '360,403 485,905 476,776 10 90,116'],
    ['2024年 2023年 同比变动(%) 2022年\n调整前 调整后', '360,403 485,905 476,776 (24.4) 90,116 88'],
  ])('rejects ambiguous or inconsistent hierarchy %s', (heading, amounts) => {
    const { before } = comparativeFacts(), numericRow = `经营活动产生的现金流量净额 ${amounts}`;
    expect(numericFactErrors({ ...before, citations: [{ ...citation, quote: numericRow }], periodEvidence: [{ ...header, quote: heading }] }, [doc], () => `单位：百万元\n${heading}\n${numericRow}\n${note}`)).toContain('FACT_PERIOD_COLUMN_MISMATCH');
  });

  it('maps net profit only when the exact row footnote attributes it to parent shareholders', () => {
    const base = comparativeFacts().after, numericRow = '净利润注1 27,257 37,381';
    const fact = { ...base, metric: 'parent_net_profit' as const, value: { status: 'known' as const, raw: '27257', unit: 'million_yuan' as const, currency: 'CNY' as const, decimals: 0 },
      citations: [{ ...citation, quote: numericRow }], periodEvidence: [{ ...header, quote: '2024年 2023年' }], accountingBasisEvidence: undefined, normalization: undefined };
    const text = (footnote: string) => `单位：人民币百万元\n2024年 2023年\n${numericRow}\n注：${footnote}\n单位：人民币元\n2024年 2023年 每股收益 2 3`;
    expect(numericFactErrors(fact, [doc], () => text('1、以归属于本公司股东的数据填列。'))).toEqual([]);
    expect(numericFactErrors(fact, [doc], () => text('2、以归属于本公司股东的数据填列。'))).toContain('FACT_METRIC_UNVERIFIED');
    expect(numericFactErrors(fact, [doc], () => text('1、合并净利润。'))).toContain('FACT_METRIC_UNVERIFIED');
    expect(numericFactErrors({ ...fact, citations: [{ ...citation, quote: '净利润 27,257 37,381' }] }, [doc], () => text('1、以归属于本公司股东的数据填列。').replace('净利润注1', '净利润'))).toContain('FACT_METRIC_UNVERIFIED');
  });

  it('refuses an explicit foreign currency even when the numeric scale matches', () => {
    const { after } = comparativeFacts();
    expect(numericFactErrors(after, [doc], () => page.replace('（人民币百万元）', '单位：百万元 币种：美元'))).toContain('FACT_CURRENCY_UNVERIFIED');
  });
});
