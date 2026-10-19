import type { FinancialFact } from './document-contracts';
import type { ResearchReportRevision } from './revision-contracts';

/** Invalidate both direct source dependencies and transitive calculated inputs. */
export function retainedUpdateFacts(report: ResearchReportRevision, affectedPeriods: Set<string>, sourcePeriods: Map<string, string>) {
  const facts = [...report.facts, ...(report.supportingFacts || [])];
  const invalid = new Set(facts.filter(fact => affectedPeriods.has(fact.period.id)
    || [...fact.citations, ...(fact.periodEvidence || [])].some(c => affectedPeriods.has(sourcePeriods.get(`${c.documentId}:${c.documentVersion}`) || ''))).map(f => f.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const fact of facts) if (!invalid.has(fact.id) && fact.derivedFrom?.some(id => invalid.has(id))) { invalid.add(fact.id); changed = true; }
  }
  const retain = (fact: FinancialFact) => !invalid.has(fact.id);
  return { facts: report.facts.filter(retain), supportingFacts: (report.supportingFacts || []).filter(retain), invalid };
}
