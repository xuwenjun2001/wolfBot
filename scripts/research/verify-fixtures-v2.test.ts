import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyFixtureAmountsV2 } from './verify-fixtures-v2';
import { cnyUnitPowers } from '../../src/lib/company-research/exact-decimal';

const docs = [2023, 2024].map(year => ({ id: `d${year}`, symbol: '600519.SH', period: { start: `${year}-01-01`, end: `${year}-12-31` }, bytesSha256: 'a'.repeat(64) }));
function sample() {
  const facts = ['revenue', 'parent_net_profit', 'operating_cash_flow'].flatMap(metric => [2023, 2024].map(year => ({
    metric, period: { start: `${year}-01-01`, end: `${year}-12-31` }, rawValue: year === 2023 ? '10.00' : '12.00', normalizedYuan: year === 2023 ? '10' : '12', unit: 'yuan' as const,
    citation: { documentId: `d${year}`, bytesSha256: 'a'.repeat(64), filePage: 1, quote: year === 2023 ? '营业金额 10.00' : '营业金额 12.00' },
  })));
  return { id: 'c', company: { symbol: '600519.SH', name: 'sample' }, asOf: '2025-06-30', documentIds: ['d2023', 'd2024'], questions: [], strata: [],
    reference: { facts, comparisonFacts: undefined as (typeof facts[number] & { priorPeriod?: boolean; restated?: boolean })[] | undefined,
      changes: ['revenue', 'parent_net_profit', 'operating_cash_flow'].map(metric => ({ metric, percentage: '20', comparisonBasis: 'original_disclosure' as 'original_disclosure' | 'restated_comparative' })), riskCitations: [] } };
}
type SampleInput = Parameters<typeof verifyFixtureAmountsV2>[0];
type DocumentsInput = Parameters<typeof verifyFixtureAmountsV2>[1];
const check = (s = sample(), d: unknown = docs) => verifyFixtureAmountsV2(s as unknown as SampleInput, d as DocumentsInput);

test('sample validation keeps exact scale and verifies reported percentages', () => {
  assert.doesNotThrow(() => check());
  const wrong = sample(); wrong.reference.facts[0].normalizedYuan = '10000';
  assert.throws(() => check(wrong), /conversion/);
  const changed = sample(); changed.reference.changes[0].percentage = '21';
  assert.throws(() => check(changed), /Change reference/);
});
test('a comparative prior-period amount must be explicitly restated and cannot rewrite the original', () => {
  const original = sample(); original.reference.facts[0].citation.documentId = 'd2024';
  assert.throws(() => check(original), /period/);
  const comparative = sample(); comparative.reference.comparisonFacts = structuredClone(comparative.reference.facts);
  comparative.reference.changes.forEach(c => { c.comparisonBasis = 'restated_comparative'; });
  const previous = comparative.reference.comparisonFacts[0]; previous.citation.documentId = 'd2024';
  previous.priorPeriod = true; previous.restated = true;
  assert.doesNotThrow(() => check(comparative));
  previous.restated = false;
  assert.throws(() => check(comparative), /period/);
});
test('source, company and exact numeric tokens stay bound', () => {
  const columns = sample(); columns.reference.facts[0].citation.quote = '009 主要会计数据\n营业收入 10.00 12.00 2024';
  assert.doesNotThrow(() => check(columns));
  const foreign = sample(); foreign.reference.facts[0].citation.bytesSha256 = 'b'.repeat(64);
  assert.throws(() => check(foreign), /scope\/hash/);
  const company = docs.map(d => ({ ...d, symbol: '000333.SZ' }));
  assert.throws(() => check(sample(), company), /scope\/hash/);
  const wrongToken = sample(); wrongToken.reference.facts[0].rawValue = '1'; wrongToken.reference.facts[0].normalizedYuan = '1';
  assert.throws(() => check(wrongToken), /absent from quote/);
});
test('million-yuan samples validate without extending production monetary units', () => {
  const s = sample();
  s.reference.facts.forEach(f => { Object.assign(f, { unit: 'million_yuan', normalizedYuan: f.rawValue === '10.00' ? '10000000' : '12000000' }); });
  assert.doesNotThrow(() => check(s));
  assert.equal('million_yuan' in cnyUnitPowers, false);
});
