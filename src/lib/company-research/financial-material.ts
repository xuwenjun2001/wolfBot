import { z } from 'zod';
import { artifactDigest } from './artifact-store';
import { researchCitationSchema, type FinancialFact } from './document-contracts';
import { researchClaimSchema } from './revision-contracts';
import { factFromDisclosure, normalizedYuan, uniqueCitations } from './financial-normalization';
import { selectFinancialComparisonPair } from './financial-comparison';
import type { ResearchCheckpoint } from './execution-contracts';
import type { ResearchTaskSpec } from './task-contracts';

export const recordFinancialFactSchema = z.object({
  periodId: z.string().max(100), metric: z.enum(['revenue', 'parent_net_profit', 'operating_cash_flow']),
  rawText: z.string().min(1).max(100), unitLabel: z.string().min(1).max(50), citations: z.array(researchCitationSchema).min(1).max(4),
  restatement: z.enum(['original', 'restated']).optional(), accountingBasis: z.string().trim().min(1).max(100).optional(),
  periodEvidence: z.array(researchCitationSchema).min(1).max(4).optional(),
  accountingBasisEvidence: z.array(researchCitationSchema).min(1).max(4).optional(),
  comparisonLimitations: z.array(z.string().trim().min(1).max(500)).max(5).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.restatement === 'restated' && !input.accountingBasis) ctx.addIssue({ code: 'custom', message: 'Restated facts require an explicit accounting basis' });
  if (input.accountingBasis && !input.periodEvidence?.length) ctx.addIssue({ code: 'custom', message: 'Comparison basis requires located period headers' });
  if (input.comparisonLimitations?.length && !input.accountingBasisEvidence?.length) ctx.addIssue({ code: 'custom', message: 'Comparison limitations require located original evidence' });
});
export function disclosedResearchFact(spec: ResearchTaskSpec, input: z.infer<typeof recordFinancialFactSchema>) {
  const period = spec.periods.find(p => p.id === input.periodId);
  if (!period) throw new Error('期间不属于任务');
  const restatement = input.restatement || 'original', basis = input.accountingBasis;
  const suffix = restatement === 'original' && !basis ? '' : `-${artifactDigest(JSON.stringify([restatement, basis])).slice(0, 16)}`;
  return factFromDisclosure({ id: `${input.periodId}-${input.metric}${suffix}`, companySymbol: spec.company.symbol, period,
    metric: input.metric, scope: spec.scope, restatement, citations: input.citations,
    ...(basis ? { accountingBasis: basis } : {}), ...(input.periodEvidence ? { periodEvidence: input.periodEvidence } : {}),
    ...(input.accountingBasisEvidence ? { accountingBasisEvidence: input.accountingBasisEvidence } : {}),
    ...(input.comparisonLimitations ? { comparisonLimitations: input.comparisonLimitations } : {}) }, input.rawText, input.unitLabel, 'native');
}

/** Shared by admission projection and the writer; validation still checks the incoming original first. */
export function mergeResearchFact(facts: ResearchCheckpoint['facts'], incoming: FinancialFact): ResearchCheckpoint['facts'] {
  const previous = facts.find(f => f.id === incoming.id);
  if (previous && (previous.restatement !== incoming.restatement || previous.accountingBasis !== incoming.accountingBasis
    || previous.metric !== incoming.metric || previous.period.id !== incoming.period.id || previous.companySymbol !== incoming.companySymbol || previous.scope !== incoming.scope)) throw new Error('FACT_IDENTITY_MISMATCH');
  if (previous?.value.status === 'conflict') return facts;
  if (previous?.value.status === 'known' && incoming.value.status === 'missing') return facts;
  const fact = previous?.value.status === 'known' && incoming.value.status === 'known' && normalizedYuan(previous) !== normalizedYuan(incoming)
    ? { ...incoming, normalization: undefined, citations: uniqueCitations([...previous.citations, ...incoming.citations]),
      ...(previous.periodEvidence || incoming.periodEvidence ? { periodEvidence: uniqueCitations([...(previous.periodEvidence || []), ...(incoming.periodEvidence || [])]) } : {}),
      ...(previous.accountingBasisEvidence || incoming.accountingBasisEvidence ? { accountingBasisEvidence: uniqueCitations([...(previous.accountingBasisEvidence || []), ...(incoming.accountingBasisEvidence || [])]) } : {}),
      ...(previous.comparisonLimitations || incoming.comparisonLimitations ? { comparisonLimitations: [...new Set([...(previous.comparisonLimitations || []), ...(incoming.comparisonLimitations || [])])] } : {}),
      value: { status: 'conflict' as const, alternatives: [previous.value, incoming.value], reason: '同公司、期间和指标出现不同原始金额，尚未核实重述或来源冲突' } }
    : { ...incoming,
      ...(previous?.accountingBasisEvidence || incoming.accountingBasisEvidence ? { accountingBasisEvidence: uniqueCitations([...(previous?.accountingBasisEvidence || []), ...(incoming.accountingBasisEvidence || [])]) } : {}),
      ...(previous?.comparisonLimitations || incoming.comparisonLimitations ? { comparisonLimitations: [...new Set([...(previous?.comparisonLimitations || []), ...(incoming.comparisonLimitations || [])])] } : {}) };
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
  const metrics: FinancialFact['metric'][] = questionId === 'income_profit' ? ['revenue', 'parent_net_profit'] : questionId === 'cash_flow' ? ['operating_cash_flow'] : [];
  const missing = spec.periods.flatMap(period => metrics.filter(metric => !state.facts.some(f => f.period.id === period.id && f.metric === metric && f.value.status === 'known'))
    .map(metric => `${period.id}-${metric}`));
  for (const metric of metrics) {
    const pair = selectFinancialComparisonPair(state.facts, [spec.periods[0].id, spec.periods[1].id], metric);
    if (pair.comparison && pair.comparison.status !== 'comparable') missing.push(`${metric}-comparison:${pair.comparison.reason}`);
  }
  const claims = state.claims.filter(c => c.questionId === questionId), explicitGap = claims.some(c => c.status !== 'supported');
  return { status: !claims.length || missing.length && !explicitGap ? 'incomplete' as const : explicitGap ? 'partial' as const : 'completed' as const,
    missing, claimIds: claims.map(c => c.id) };
}
