import { canonicalResearchJson, researchPeriodSchema, type ResearchTaskSpec } from './task-contracts';

/** Task-selected periods plus the exact YTD inputs needed to derive a selected quarter. */
export function researchEvidencePeriods(spec: ResearchTaskSpec) {
  const periods = [...spec.periods];
  for (const period of spec.periods) if (period.basis === 'single_quarter') {
    const year = period.end.slice(0, 4), month = Number(period.end.slice(5, 7));
    for (const endMonth of [month, month - 3].filter(m => m > 0)) {
      const end = new Date(Date.UTC(Number(year), endMonth, 0)).toISOString().slice(0, 10);
      const input = researchPeriodSchema.parse({ id: `ytd_${year}_${String(endMonth).padStart(2, '0')}`, start: `${year}-01-01`, end,
        kind: endMonth === 12 ? 'annual' : endMonth === 6 ? 'interim' : 'quarter', basis: 'cumulative' });
      while (periods.some(p => p.id === input.id)) input.id += '_input';
      if (!periods.some(p => p.start === input.start && p.end === input.end && p.basis === input.basis && p.kind === input.kind)) periods.push(input);
    }
  }
  return periods;
}
export function isResearchEvidencePeriod(spec: ResearchTaskSpec, period: ResearchTaskSpec['periods'][number]) {
  return researchEvidencePeriods(spec).some(p => canonicalResearchJson(p) === canonicalResearchJson(period));
}
