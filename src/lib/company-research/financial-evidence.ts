import type { FinancialFact, ResearchDocument, VersionedCitation } from './document-contracts';
import { canonicalResearchJson, type ResearchTaskSpec } from './task-contracts';
import { isResearchEvidencePeriod } from './evidence-periods';
import { deriveSingleQuarter } from './financial-comparison';
import { normalizedYuan } from './financial-normalization';

export const factCitations = (fact: FinancialFact) => [...fact.citations, ...(fact.periodEvidence || []), ...(fact.accountingBasisEvidence || [])];
const citationSet = (items: VersionedCitation[]) => canonicalResearchJson([...new Set(items.map(canonicalResearchJson))].sort());
const samePeriod = (a: FinancialFact['period'], b: FinancialFact['period']) => a.start === b.start && a.end === b.end && a.kind === b.kind && a.basis === b.basis;

/** Check provenance and recompute derivations. Semantic support remains a separate review. */
export function financialEvidenceErrors(facts: FinancialFact[], supportingFacts: FinancialFact[], spec: ResearchTaskSpec, documents: ResearchDocument[]) {
  const errors: string[] = [];
  for (const f of [...facts, ...supportingFacts]) {
    const supporting = supportingFacts.includes(f);
    const periodMatches = supporting ? isResearchEvidencePeriod(spec, f.period) : spec.periods.some(p => p.id === f.period.id && samePeriod(p, f.period));
    if (!periodMatches || f.companySymbol !== spec.company.symbol || f.scope !== spec.scope) errors.push('FACT_CONTEXT_MISMATCH');
    if (supporting && (f.derivedFrom || !facts.some(result => result.derivedFrom?.includes(f.id)))) errors.push('DERIVED_INPUT_INVALID');
    if (f.derivedFrom) {
      const inputs = f.derivedFrom.map(id => supportingFacts.find(input => input.id === id));
      try {
        if (f.derivedFrom.length > 2 || inputs.some(input => !input || input.derivedFrom)) throw new Error('Invalid inputs');
        const expected = deriveSingleQuarter(inputs[0]!, inputs[1] || null);
        if (!samePeriod(f.period, expected.period) || f.metric !== expected.metric || f.restatement !== expected.restatement || f.accountingBasis !== expected.accountingBasis
          || normalizedYuan(f) !== normalizedYuan(expected) || citationSet(f.citations) !== citationSet(expected.citations)
          || citationSet(f.periodEvidence || []) !== citationSet(expected.periodEvidence || [])
          || citationSet(f.accountingBasisEvidence || []) !== citationSet(expected.accountingBasisEvidence || [])
          || canonicalResearchJson(f.comparisonLimitations || []) !== canonicalResearchJson(expected.comparisonLimitations || [])) errors.push('DERIVED_FACT_MISMATCH');
      } catch { errors.push('DERIVED_INPUT_INVALID'); }
      continue;
    }
    for (const citation of f.citations) {
      const doc = documents.find(d => d.id === citation.documentId && d.version === citation.documentVersion);
      if (!doc) continue; // The common citation validator reports missing or forged documents.
      if (doc.period.id === f.period.id && samePeriod(doc.period, f.period)) continue;
      // A later report can restate an earlier comparable period. Require a real located year/column label.
      const hasPeriodEvidence = (f.periodEvidence || []).some(e => e.documentId === doc.id && e.documentVersion === doc.version && e.bytesSha256 === doc.bytesSha256
        && new RegExp(`(?:^|[^0-9])${f.period.end.slice(0, 4)}(?:[^0-9]|$)`).test(e.quote.normalize('NFKC')));
      const laterComparableReport = doc.period.start > f.period.end && doc.period.kind === f.period.kind && doc.period.basis === f.period.basis
        && doc.period.start.slice(5) === f.period.start.slice(5) && doc.period.end.slice(5) === f.period.end.slice(5);
      if (f.restatement !== 'restated' || !f.accountingBasis || !laterComparableReport || !hasPeriodEvidence) errors.push('CITATION_PERIOD_MISMATCH');
    }
  }
  return errors;
}
