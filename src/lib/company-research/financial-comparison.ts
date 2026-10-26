import { financialFactSchema, type FinancialFact, type VersionedCitation } from './document-contracts';
import { normalizedYuan, uniqueCitations } from './financial-normalization';
import { decimal, decimalText, percentChange, subtract } from './exact-decimal';
import { artifactDigest } from './artifact-store';
import { canonicalResearchJson } from './task-contracts';

/** Page evidence may cover a table; two table locators must identify the same table. */
export function sameFinancialEvidenceLocation(a: VersionedCitation, b: VersionedCitation) {
  if (a.documentId !== b.documentId || a.documentVersion !== b.documentVersion || a.bytesSha256 !== b.bytesSha256) return false;
  if (a.locator.kind === 'html' || b.locator.kind === 'html') return a.locator.kind === 'html' && b.locator.kind === 'html' && a.locator.blockId === b.locator.blockId;
  return a.locator.filePage === b.locator.filePage && (a.locator.kind !== 'table' || b.locator.kind !== 'table' || a.locator.tableId === b.locator.tableId);
}

/** A model-supplied basis name cannot join unrelated reports or independently selected tables. */
export function sharedFinancialComparisonHeader(a: FinancialFact, b: FinancialFact) {
  return (a.periodEvidence || []).find(header => (b.periodEvidence || []).some(other => canonicalResearchJson(header) === canonicalResearchJson(other))
    && [a.period, b.period].every(period => new RegExp(`(?:^|[^0-9])${period.end.slice(0, 4)}(?:[^0-9]|$)`).test(header.quote.normalize('NFKC')))
    && [a, b].every(fact => fact.citations.length > 0 && fact.citations.every(citation => sameFinancialEvidenceLocation(citation, header))));
}

export function factContextDifference(a: FinancialFact, b: FinancialFact): string | null {
  if (a.companySymbol !== b.companySymbol) return 'company_mismatch';
  if (a.metric !== b.metric) return 'metric_mismatch';
  if (a.scope !== b.scope) return 'scope_mismatch';
  if (a.sourceQuality === 'needs_review' || b.sourceQuality === 'needs_review') return 'source_requires_review';
  if (a.restatement !== b.restatement && (!a.accountingBasis || a.accountingBasis !== b.accountingBasis)) return 'restatement_basis_unresolved';
  if ((a.restatement === 'restated' || b.restatement === 'restated') && (!a.accountingBasis || a.accountingBasis !== b.accountingBasis)) return 'restatement_basis_unresolved';
  if ((a.accountingBasis || b.accountingBasis) && a.accountingBasis !== b.accountingBasis) return 'accounting_basis_mismatch';
  if ((a.restatement === 'restated' || b.restatement === 'restated' || a.accountingBasis || b.accountingBasis) && !sharedFinancialComparisonHeader(a, b)) return 'accounting_basis_evidence_unresolved';
  return null;
}
export function compareFinancialFacts(beforeInput: FinancialFact, afterInput: FinancialFact) {
  const before = financialFactSchema.parse(beforeInput), after = financialFactSchema.parse(afterInput);
  const comparative = !!(before.accountingBasis || after.accountingBasis || before.restatement === 'restated' || after.restatement === 'restated');
  const bindings = { beforeId: before.id, afterId: after.id, metric: before.metric,
    citations: uniqueCitations([before, after].flatMap(f => [...f.citations, ...(f.periodEvidence || []), ...(f.accountingBasisEvidence || [])])), algorithm: 'decimal-v1',
    comparisonBasis: comparative ? 'disclosed_comparative' as const : 'original_disclosure' as const,
    limitations: [...new Set([...(comparative ? ['按同一报告披露的比较列计算，不据此认定不同会计准则已经完全同口径。'] : []), ...(before.comparisonLimitations || []), ...(after.comparisonLimitations || [])])] };
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

/** Preserve originals in facts, but never silently fall back to them when a comparative is incomplete. */
export function selectFinancialComparisonPair(facts: FinancialFact[], periodIds: readonly [string, string], metric: FinancialFact['metric']) {
  const relevant = facts.filter(f => f.metric === metric && periodIds.includes(f.period.id));
  const bases = [...new Set(relevant.map(f => f.accountingBasis).filter((basis): basis is string => !!basis))];
  const unresolved = (reason: string) => ({ before: null, after: null, comparison: { beforeId: null, afterId: null, metric, algorithm: 'decimal-v1',
    status: 'incomparable' as const, reason, citations: uniqueCitations(relevant.flatMap(f => [...f.citations, ...(f.periodEvidence || []), ...(f.accountingBasisEvidence || [])])) } });
  if (bases.length > 1) return unresolved('comparison_basis_ambiguous');
  if (relevant.some(f => f.restatement === 'restated' && !f.accountingBasis)) return unresolved('restatement_basis_unresolved');
  const candidates = bases.length ? relevant.filter(f => f.accountingBasis === bases[0]) : relevant;
  const groups = periodIds.map(id => candidates.filter(f => f.period.id === id));
  if (groups.some(group => group.length > 1)) return unresolved('comparison_basis_ambiguous');
  if (bases.length && groups.some(group => !group.length)) return unresolved('comparison_basis_incomplete');
  const before = groups[0][0] || null, after = groups[1][0] || null;
  return { before, after, comparison: before && after ? compareFinancialFacts(before, after) : null };
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
    citations: uniqueCitations([...current.citations, ...(preceding?.citations || [])]),
    ...(current.periodEvidence || preceding?.periodEvidence ? { periodEvidence: uniqueCitations([...(current.periodEvidence || []), ...(preceding?.periodEvidence || [])]) } : {}),
    ...(current.accountingBasisEvidence || preceding?.accountingBasisEvidence ? { accountingBasisEvidence: uniqueCitations([...(current.accountingBasisEvidence || []), ...(preceding?.accountingBasisEvidence || [])]) } : {}),
    ...(current.comparisonLimitations || preceding?.comparisonLimitations ? { comparisonLimitations: [...new Set([...(current.comparisonLimitations || []), ...(preceding?.comparisonLimitations || [])])] } : {}) });
}
