import { financialFactSchema, type FinancialFact } from './document-contracts';
import { normalizedYuan, uniqueCitations } from './financial-normalization';
import { decimal, decimalText, percentChange, subtract } from './exact-decimal';
import { artifactDigest } from './artifact-store';

export function factContextDifference(a: FinancialFact, b: FinancialFact): string | null {
  if (a.companySymbol !== b.companySymbol) return 'company_mismatch';
  if (a.metric !== b.metric) return 'metric_mismatch';
  if (a.scope !== b.scope) return 'scope_mismatch';
  if (a.sourceQuality === 'needs_review' || b.sourceQuality === 'needs_review') return 'source_requires_review';
  if (a.restatement !== b.restatement && (!a.accountingBasis || a.accountingBasis !== b.accountingBasis)) return 'restatement_basis_unresolved';
  if ((a.restatement === 'restated' || b.restatement === 'restated') && (!a.accountingBasis || a.accountingBasis !== b.accountingBasis)) return 'restatement_basis_unresolved';
  if ((a.accountingBasis || b.accountingBasis) && a.accountingBasis !== b.accountingBasis) return 'accounting_basis_mismatch';
  return null;
}
export function compareFinancialFacts(beforeInput: FinancialFact, afterInput: FinancialFact) {
  const before = financialFactSchema.parse(beforeInput), after = financialFactSchema.parse(afterInput);
  const bindings = { beforeId: before.id, afterId: after.id, metric: before.metric, citations: uniqueCitations([...before.citations, ...after.citations]), algorithm: 'decimal-v1' };
  const difference = factContextDifference(before, after);
  if (difference) return { ...bindings, status: 'incomparable' as const, reason: difference };
  const a = before.period, b = after.period;
  if (a.end >= b.start || a.kind !== b.kind || a.basis !== b.basis || a.start.slice(5) !== b.start.slice(5) || a.end.slice(5) !== b.end.slice(5)) return { ...bindings, status: 'incomparable' as const, reason: 'period_basis_mismatch' };
  if (before.value.status === 'conflict' || after.value.status === 'conflict') return { ...bindings, status: 'conflict' as const, reason: 'unresolved_values' };
  const beforeYuan = normalizedYuan(before), afterYuan = normalizedYuan(after);
  if (beforeYuan === null || afterYuan === null) return { ...bindings, status: 'missing' as const, reason: 'missing_value' };
  const first = decimal(beforeYuan), last = decimal(afterYuan), percentage = percentChange(first, last);
  return { ...bindings, status: 'comparable' as const, beforeYuan, afterYuan, deltaYuan: decimalText(subtract(last, first)), percentage,
    percentageReason: first.coefficient === 0n ? 'zero_base' : first.coefficient < 0n ? 'negative_base_absolute_denominator' : 'positive_base',
    comparisonKind: Number(b.end.slice(0, 4)) - Number(a.end.slice(0, 4)) === 1 ? 'year_over_year' : 'period_change' };
}
/** A missing preceding YTD is never replaced with zero. Q1 itself already covers one quarter. */
export function deriveSingleQuarter(currentInput: FinancialFact, precedingInput: FinancialFact | null): FinancialFact {
  const current = financialFactSchema.parse(currentInput), preceding = precedingInput ? financialFactSchema.parse(precedingInput) : null;
  if (current.period.basis !== 'cumulative') throw new Error('current_must_be_ytd');
  const endMonth = Number(current.period.end.slice(5, 7));
  if (endMonth !== 3 && !preceding) throw new Error('preceding_ytd_required');
  if (preceding && (factContextDifference(current, preceding) || preceding.period.basis !== 'cumulative' || preceding.period.start !== current.period.start || Number(preceding.period.end.slice(5, 7)) !== endMonth - 3)) throw new Error('preceding_ytd_not_same_basis');
  const currentValue = normalizedYuan(current), priorValue = preceding ? normalizedYuan(preceding) : '0';
  if (currentValue === null || priorValue === null || current.sourceQuality === 'needs_review') throw new Error('complete_verified_ytd_required');
  const raw = decimalText(subtract(decimal(currentValue), decimal(priorValue))), start = `${current.period.end.slice(0, 4)}-${String(endMonth - 2).padStart(2, '0')}-01`;
  const derivedFrom = [current.id, ...(preceding ? [preceding.id] : [])];
  return financialFactSchema.parse({ ...current, id: `quarter_${artifactDigest(derivedFrom.join(':')).slice(0, 32)}`, period: { id: `${current.period.end.slice(0, 4)}Q${endMonth / 3}`, start, end: current.period.end, kind: 'quarter', basis: 'single_quarter' },
    value: { status: 'known', raw, unit: 'yuan', currency: 'CNY', decimals: raw.split('.')[1]?.length || 0 }, derivedFrom, normalization: undefined,
    citations: uniqueCitations([...current.citations, ...(preceding?.citations || [])]) });
}
