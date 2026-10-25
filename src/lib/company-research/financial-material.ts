import { z } from 'zod';
import { researchCitationSchema, type FinancialFact } from './document-contracts';
import { researchClaimSchema } from './revision-contracts';
import { factFromDisclosure, normalizedYuan, uniqueCitations } from './financial-normalization';
import type { ResearchCheckpoint } from './execution-contracts';
import type { ResearchTaskSpec } from './task-contracts';

export const recordFinancialFactSchema = z.object({
  periodId: z.string().max(100), metric: z.enum(['revenue', 'parent_net_profit', 'operating_cash_flow']),
  rawText: z.string().min(1).max(100), unitLabel: z.string().min(1).max(50), citations: z.array(researchCitationSchema).min(1).max(4),
}).strict();
export function disclosedResearchFact(spec: ResearchTaskSpec, input: z.infer<typeof recordFinancialFactSchema>) {
  const period = spec.periods.find(p => p.id === input.periodId);
  if (!period) throw new Error('期间不属于任务');
  return factFromDisclosure({ id: `${input.periodId}-${input.metric}`, companySymbol: spec.company.symbol, period,
    metric: input.metric, scope: spec.scope, restatement: 'original', citations: input.citations }, input.rawText, input.unitLabel, 'native');
}

/** Shared by admission projection and the writer; validation still checks the incoming original first. */
export function mergeResearchFact(facts: ResearchCheckpoint['facts'], incoming: FinancialFact): ResearchCheckpoint['facts'] {
  const previous = facts.find(f => f.id === incoming.id);
  if (previous?.value.status === 'conflict') return facts;
  const fact = previous?.value.status === 'known' && incoming.value.status === 'known' && normalizedYuan(previous) !== normalizedYuan(incoming)
    ? { ...incoming, normalization: undefined, citations: uniqueCitations([...previous.citations, ...incoming.citations]),
      value: { status: 'conflict' as const, alternatives: [previous.value, incoming.value], reason: '同公司、期间和指标出现不同原始金额，尚未核实重述或来源冲突' } }
    : incoming;
  return [...facts.filter(f => f.id !== fact.id), fact];
}

export function projectFinancialWrite(spec: ResearchTaskSpec, state: ResearchCheckpoint, tool: string, input: unknown) {
  if (tool === 'record_claim') {
    const parsed = researchClaimSchema.safeParse(input);
    if (parsed.success) return { ...state, claims: [...state.claims.filter(c => c.id !== parsed.data.id), parsed.data] };
  }
  if (tool === 'record_fact') {
    const parsed = recordFinancialFactSchema.safeParse(input);
    if (parsed.success && spec.periods.some(p => p.id === parsed.data.periodId)) {
      // A value may pass the input schema but fail the derived fact contract.
      // Let the writer return its normal validation feedback, without aborting admission.
      try { return { ...state, facts: mergeResearchFact(state.facts, disclosedResearchFact(spec, parsed.data)) }; }
      catch { return state; }
    }
  }
  return state;
}

/** A question can close with explicit gaps, but a supported draft cannot silently omit required amounts. */
export function comparisonCompletion(spec: ResearchTaskSpec, state: ResearchCheckpoint, questionId: ResearchTaskSpec['questions'][number]['id']) {
  const metrics = questionId === 'income_profit' ? ['revenue', 'parent_net_profit'] : questionId === 'cash_flow' ? ['operating_cash_flow'] : [];
  const missing = spec.periods.flatMap(period => metrics.filter(metric => !state.facts.some(f => f.period.id === period.id && f.metric === metric && f.value.status === 'known'))
    .map(metric => `${period.id}-${metric}`));
  const claims = state.claims.filter(c => c.questionId === questionId), explicitGap = claims.some(c => c.status !== 'supported');
  return { status: !claims.length || missing.length && !explicitGap ? 'incomplete' as const : explicitGap ? 'partial' as const : 'completed' as const,
    missing, claimIds: claims.map(c => c.id) };
}
