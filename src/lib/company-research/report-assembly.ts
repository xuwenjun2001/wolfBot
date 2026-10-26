import type { ResearchTaskSpec } from './task-contracts';
import { researchReportRevisionSchema, type ResearchReportRevision } from './revision-contracts';
import type { ResearchCheckpoint } from './execution-contracts';
import { researchSkillVersion, financialResearchPrompt, type FinancialResearchSkill } from './execution-contracts';
import { artifactDigest } from './artifact-store';
import { claimReviewHash, type SemanticReview } from './claim-verification';
import { selectFinancialComparisonPair } from './financial-comparison';
import { factCitations } from './financial-evidence';

export const requiredFinancialMetrics = ['revenue', 'parent_net_profit', 'operating_cash_flow'] as const;
export function assembleFinancialReport(taskId: string, spec: ResearchTaskSpec, planRevision: number, revision: number, state: ResearchCheckpoint, model: string, reviews: SemanticReview[] = [], skill: FinancialResearchSkill = { version: researchSkillVersion, prompt: financialResearchPrompt }): ResearchReportRevision {
  const claims = state.claims.map(claim => {
    if (claim.status !== 'supported') return claim;
    const hash = claimReviewHash({ taskId, requestRevision: spec.requestRevision, planRevision, asOf: spec.asOf, facts: [...state.facts, ...(state.supportingFacts || [])] }, claim);
    const review = reviews.find(r => r.claimHash === hash);
    return review?.verdict === 'supported' ? claim : { ...claim, status: review?.verdict === 'conflict' ? 'conflict' as const : 'evidence_gap' as const, reason: review?.reason || '尚未完成独立语义核验' };
  });
  const gaps: ResearchReportRevision['gaps'] = [];
  for (const period of spec.periods) for (const metric of requiredFinancialMetrics) {
    if (!state.facts.some(f => f.metric === metric && f.period.id === period.id && f.value.status === 'known')) gaps.push({ code: 'evidence_gap', questionId: metric === 'operating_cash_flow' ? 'cash_flow' : 'income_profit', message: `${period.id} ${metric} 缺少已核查金额` });
  }
  for (const q of spec.questions) {
    const related = claims.filter(c => c.questionId === q.id);
    if (!related.length) gaps.push({ code: 'evidence_gap', questionId: q.id, message: `${q.text} 尚未获得结论` });
    for (const claim of related.filter(c => c.status !== 'supported')) gaps.push({ code: claim.status === 'conflict' ? 'evidence_conflict' : 'evidence_gap', questionId: q.id, message: `${claim.id}：${claim.reason}`.slice(0, 1000) });
  }
  if (spec.comparison.status === 'incomparable') gaps.push({ code: 'incomparable_period', questionId: 'income_profit', message: spec.comparison.reason });
  for (const metric of requiredFinancialMetrics) {
    const pair = selectFinancialComparisonPair(state.facts, [spec.periods[0].id, spec.periods[1].id], metric);
    if (pair.comparison && pair.comparison.status !== 'comparable') gaps.push({ code: 'incomparable_period', questionId: metric === 'operating_cash_flow' ? 'cash_flow' : 'income_profit', message: `${metric} 两期口径不能比较：${pair.comparison.reason}` });
  }
  if (state.stopReason && !state.submitted) gaps.push({ code: 'evidence_gap', questionId: 'risks', message: state.stopReason });
  return researchReportRevisionSchema.parse({ schemaVersion: 1, taskId, requestRevision: spec.requestRevision, planRevision, revision, companySymbol: spec.company.symbol,
    periodIds: spec.periods.map(p => p.id), asOf: spec.asOf, generatedAt: new Date().toISOString(), status: gaps.length ? 'partial' : 'completed', facts: state.facts, ...(state.supportingFacts ? { supportingFacts: state.supportingFacts } : {}), claims, gaps,
    method: { model, skillVersion: skill.version, skillSha256: artifactDigest(skill.prompt), toolVersion: 'financial-tools-v2', contractVersion: 'financial-change-v1',
      ...(state.schemaVersion === 2 ? { variant: state.variant } : {}), ...(state.modelTurns !== undefined ? { modelTurns: state.modelTurns } : {}),
      dataHashes: [...new Set([...[...state.facts, ...(state.supportingFacts || [])].flatMap(factCitations), ...claims.flatMap(c => c.citations)].map(c => c.bytesSha256))],
      semanticReview: reviews.length ? reviews.every(r => r.independence === 'human') ? 'human' : 'separate_call_same_model' : 'unavailable' } });
}
export function financialChanges(report: Pick<ResearchReportRevision, 'facts' | 'periodIds'>) {
  return requiredFinancialMetrics.map(metric => {
    return { metric, ...selectFinancialComparisonPair(report.facts, report.periodIds, metric) };
  });
}
