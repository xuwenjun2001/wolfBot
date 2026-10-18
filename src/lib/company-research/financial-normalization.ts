import { artifactDigest } from './artifact-store';
import { financialFactSchema, type FinancialFact, type VersionedCitation } from './document-contracts';
import { cnyUnitPowers, decimal, decimalText, multiplyPowerOfTen } from './exact-decimal';

export const unitPowers = cnyUnitPowers;
export function financialMetric(label: string): FinancialFact['metric'] | null {
  const s = label.normalize('NFKC').replace(/\s/g, '').replace(/\((?:人民币)?(?:元|千元|万元|亿元)\)/g, '');
  if (s === '营业总收入') return 'total_operating_income';
  if (s === '营业收入') return 'revenue';
  if (['归属于上市公司股东的净利润', '归属于母公司股东的净利润', '归母净利润'].includes(s)) return 'parent_net_profit';
  if (['经营活动产生的现金流量净额', '经营活动现金流量净额'].includes(s)) return 'operating_cash_flow';
  return null;
}
export function monetaryUnit(label: string): keyof typeof unitPowers | null {
  const s = label.normalize('NFKC').replace(/\s/g, '').replace(/币种[:：]?人民币/g, '').replace(/单位[:：]?/g, '').replace(/^人民币/, '');
  return ({ 元: 'yuan', 千元: 'thousand_yuan', 万元: 'ten_thousand_yuan', 亿元: 'hundred_million_yuan' } as const)[s as '元'] || null;
}
export function disclosedAmount(rawText: string, unitLabel: string) {
  const unit = monetaryUnit(unitLabel); if (!unit) return { status: 'invalid' as const, reason: 'unknown_or_non_monetary_unit' };
  let s = rawText.normalize('NFKC').replace(/\s/g, '').replace(/−/g, '-');
  if (['', '-', '—', '–', '不适用', '未披露', 'N/A'].includes(s)) return { status: 'missing' as const, reason: 'not_disclosed' };
  if (/^\([\d,.]+\)$/.test(s)) s = '-' + s.slice(1, -1);
  if (!/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s)) return { status: 'invalid' as const, reason: 'ambiguous_numeric_text' };
  s = s.replace(/,/g, '').replace(/^(-?)0+(?=\d)/, '$1');
  const decimals = s.split('.')[1]?.length || 0;
  if (decimals > 12 || s.length > 100) return { status: 'invalid' as const, reason: 'numeric_precision_limit' };
  const normalizedYuan = decimalText(multiplyPowerOfTen(decimal(s), unitPowers[unit]));
  return { status: 'known' as const, raw: s, unit, currency: 'CNY' as const, decimals, normalizedYuan };
}
export function normalizedYuan(fact: FinancialFact): string | null {
  const f = financialFactSchema.parse(fact);
  return f.value.status === 'known' ? decimalText(multiplyPowerOfTen(decimal(f.value.raw), unitPowers[f.value.unit])) : null;
}
export function factFromDisclosure(context: Omit<FinancialFact, 'id' | 'value' | 'normalization' | 'sourceQuality'> & { id?: string }, rawText: string, unitLabel: string, sourceQuality: 'native' | 'needs_review'): FinancialFact {
  const amount = disclosedAmount(rawText, unitLabel), id = context.id || `fact_${artifactDigest(JSON.stringify([context, rawText, unitLabel])).slice(0, 32)}`;
  const value = amount.status === 'known' && sourceQuality === 'native'
    ? { status: amount.status, raw: amount.raw, unit: amount.unit, currency: amount.currency, decimals: amount.decimals }
    : { status: 'missing' as const, reason: sourceQuality !== 'native' ? 'source_requires_review' : amount.status === 'known' ? 'unverified' : amount.reason };
  return financialFactSchema.parse({ ...context, id, value, sourceQuality,
    normalization: { version: 'decimal-v1', rawText, unitLabel, ...(value.status === 'known' && amount.status === 'known' ? { normalizedYuan: amount.normalizedYuan } : {}) } });
}
export function uniqueCitations(citations: VersionedCitation[]) {
  return [...new Map(citations.map(c => [JSON.stringify(c), c])).values()];
}
