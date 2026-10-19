import { z } from 'zod';
import type { PiAgentTool } from '@/lib/agent/types';
import type { ResearchAttemptToken } from './attempt-store';
import type { ResearchCheckpoint, FinancialResearchSkill } from './execution-contracts';
import { canonicalResearchJson, type ResearchTaskSpec } from './task-contracts';
import { researchCitationSchema } from './document-contracts';
import { researchClaimSchema } from './revision-contracts';
import { evidenceReadSchema, evidenceSearchSchema, researchEvidenceReader } from './evidence-retrieval';
import { discoverTaskFilings, importTaskFiling, listResearchDocuments, filingImportSchema } from './acquisition-service';
import { parseResearchDocument } from './parse-service';
import { factFromDisclosure, normalizedYuan, uniqueCitations } from './financial-normalization';
import { assembleFinancialReport, financialChanges } from './report-assembly';
import { deterministicReportErrors, readClaimReviews } from './verification-service';
import { reviewResearchClaim } from './claim-reviewer';
import { artifactDigest } from './artifact-store';
import { defaultResearchContext } from './repository-core';
import { safeError } from './config';
import { financialChangeSummary } from './financial-observation';

export const checkpointEvidenceHash = (state: ResearchCheckpoint) => artifactDigest(canonicalResearchJson({ facts: state.facts, supportingFacts: state.supportingFacts, claims: state.claims }));
export function financialResearchTools(actor: string, token: ResearchAttemptToken, spec: ResearchTaskSpec, state: ResearchCheckpoint, model: string, save: (tool: string) => Promise<void>, ctx = defaultResearchContext, fixedDocuments = false, skill?: FinancialResearchSkill): PiAgentTool[] {
  const reader = researchEvidenceReader(actor, token.taskId, ctx);
  // Validation uses the author's saved claims. Publication assembly may downgrade
  // unreviewed claims, but must never overwrite the checkpoint during local repair.
  const draft = () => ({ ...assembleFinancialReport(token.taskId, spec, token.planRevision, 1, state, model, [], skill), claims: state.claims });
  const tool = <T>(name: string, description: string, schema: z.ZodType<T>, execute: (input: T, signal: AbortSignal) => Promise<unknown>, terminal = false): PiAgentTool => ({
    name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>, effect: 'read', idempotency: 'intrinsic', terminal,
    async execute(input, context) {
      try {
        context.signal.throwIfAborted();
        const before = checkpointEvidenceHash(state), data = await execute(schema.parse(input), context.signal);
        context.signal.throwIfAborted();
        const changed = before !== checkpointEvidenceHash(state);
        if (changed) state.checkedHash = null;
        await save(name);
        return { ok: true, data };
      } catch (error) { return { ok: false, error: { code: 'FINANCIAL_RESEARCH_TOOL', message: safeError(error), retryable: true } }; }
    },
  });
  const tools = [
    tool('list_documents', 'List exact available task documents. Actor and task are fixed by server.', z.object({}).strict(), async () => (await listResearchDocuments(actor, token.taskId, ctx)).map(d => ({ id: d.id, version: d.version, period: d.period, state: d.state, disclosure: d.disclosure, bytesSha256: d.bytesSha256 }))),
    tool('discover_filings', 'Discover official reports for the task. Candidates are not evidence.', z.object({ page: z.number().int().min(1).max(10) }).strict(), ({ page }, signal) => discoverTaskFilings(actor, token.taskId, page, signal, ctx)),
    tool('import_filing', 'Import one official candidate. Never choose manual links with an unverified disclosure date.', filingImportSchema, (input, signal) => importTaskFiling(actor, token.taskId, input, signal, ctx, token)),
    tool('parse_document', 'Parse one saved document; native first, OCR preserves needs_review.', z.object({ documentId: z.string().max(100), version: z.number().int().min(1) }).strict(), ({ documentId, version }, signal) => parseResearchDocument(actor, token.taskId, documentId, version, { engine: 'auto' }, signal, ctx, undefined, token)),
    tool('search_evidence', 'Search authorized evidence, two periods by default. Query may target financial metric aliases or risk/causal text. Read full pages for column headers.', evidenceSearchSchema, input => reader.search(input)),
    tool('read_evidence', 'Read exact page/block/cell. Use page locator for metric/period/unit context; nextOffset continues bounded text.', evidenceReadSchema, input => reader.read(input)),
    tool('record_fact', 'Save ONE exact current-period financial fact. Stable id is periodId-metric. Copy amount and unit; include citations covering the numeric row (page locator allowed). Tools check first-column and unit; never provide calculated values.', z.object({
      periodId: z.string().max(100), metric: z.enum(['revenue', 'parent_net_profit', 'operating_cash_flow']), rawText: z.string().min(1).max(100), unitLabel: z.string().min(1).max(50), citations: z.array(researchCitationSchema).min(1).max(4),
    }).strict(), async input => {
      const period = spec.periods.find(p => p.id === input.periodId); if (!period) throw new Error('期间不属于任务');
      const fact = factFromDisclosure({ id: `${input.periodId}-${input.metric}`, companySymbol: spec.company.symbol, period, metric: input.metric, scope: spec.scope, restatement: 'original', citations: input.citations }, input.rawText, input.unitLabel, 'native');
      const candidate = draft(); candidate.facts = [...state.facts.filter(f => f.id !== fact.id), fact];
      const checked = await deterministicReportErrors(actor, spec, candidate, ctx);
      for (const c of input.citations) {
        const receipt = checked.evidence.receipts.get(`${c.documentId}:${c.documentVersion}`);
        if (receipt?.schemaVersion === 2 && receipt.pages.filter(p => c.locator.kind === 'html' || p.filePage === c.locator.filePage).flatMap(p => p.blocks).some(b => b.quality !== 'native')) throw new Error('FACT_SOURCE_NEEDS_REVIEW');
      }
      if (checked.errors.length) throw new Error(checked.errors.join('; '));
      const previous = state.facts.find(f => f.id === fact.id);
      if (previous?.value.status === 'conflict') return { fact: previous, instruction: '现有同期间证据冲突未解决，保留 partial；不能用重复写入抹去冲突' };
      if (previous?.value.status === 'known' && fact.value.status === 'known' && normalizedYuan(previous) !== normalizedYuan(fact)) {
        const conflicted = { ...fact, normalization: undefined, citations: uniqueCitations([...previous.citations, ...fact.citations]), value: { status: 'conflict' as const, alternatives: [previous.value, fact.value], reason: '同公司、期间和指标出现不同原始金额，尚未核实重述或来源冲突' } };
        state.facts = [...state.facts.filter(f => f.id !== fact.id), conflicted];
        return { fact: conflicted, instruction: '保留两份原始证据，相关结论必须 evidence_gap/conflict' };
      }
      state.facts = candidate.facts;
      for (const q of ['income_profit', 'cash_flow']) state.steps[`${q}-compare`] = state.facts.filter(f => q === 'cash_flow' ? f.metric === 'operating_cash_flow' : f.metric !== 'operating_cash_flow').length >= (q === 'cash_flow' ? 2 : 4) ? 'completed' : 'running';
      return { saved: fact.id, value: fact.value, normalization: fact.normalization, changes: financialChangeSummary(financialChanges(candidate)) };
    }),
    tool('record_claim', 'Save/repair ONE claim by stable id. Must answer the question, cite both periods for comparison, distinguish fact/inference/opinion. Cash flow needs evidence-backed explanation. Unsupported statements use evidence_gap with reason.', researchClaimSchema, async claim => {
      const candidate = draft(); candidate.claims = [...state.claims.filter(c => c.id !== claim.id), claim];
      const checked = await deterministicReportErrors(actor, spec, candidate, ctx);
      if (checked.errors.length) throw new Error(checked.errors.join('; '));
      state.claims = candidate.claims;
      state.steps[`${claim.questionId}-retrieve`] = 'completed'; state.steps[`${claim.questionId}-verify`] = 'pending';
      return { saved: claim.id, semanticReview: 'pending', instruction: 'verify_claim 检查此条结论；失败时只修复此 id' };
    }),
    tool('verify_claim', 'Run a calibrated separate semantic review on ONE saved claim. Citation integrity is checked first. No calibration yields an honest evidence gap.', z.object({ claimId: z.string().max(100) }).strict(), async ({ claimId }, signal) => {
      const claim = state.claims.find(c => c.id === claimId); if (!claim) throw new Error('未知结论');
      const report = draft(), checked = await deterministicReportErrors(actor, spec, report, ctx);
      if (checked.errors.length) return { errors: checked.errors };
      state.phase = 'verifying';
      const context = claim.citations.map(c => ({ ...c, context: checked.evidence.page(c)?.slice(0, 7000) }));
      const review = await reviewResearchClaim(actor, token, report, claim, { question: spec.questions.find(q => q.id === claim.questionId), periods: spec.periods, claim,
        facts: [...state.facts, ...(state.supportingFacts || [])].filter(f => claim.factIds.includes(f.id)), changes: financialChanges(report), evidence: context }, signal, ctx);
      state.steps[`${claim.questionId}-verify`] = review?.verdict === 'supported' ? 'completed' : 'partial';
      if (review?.verdict === 'supported') state.steps[`${claim.questionId}-compare`] = 'completed';
      return review || { verdict: 'insufficient', reason: '未配置经过校准的 reviewer；引用检查不代表语义支持' };
    }),
    tool('check_coverage', 'Check the three questions, six numbers, period comparability and saved semantic reviews. Empty args. Missing facts/claims remain in denominator.', z.object({}).strict(), async () => {
      const report = assembleFinancialReport(token.taskId, spec, token.planRevision, 1, state, model, await readClaimReviews(actor, token.taskId, ctx), skill);
      const checked = await deterministicReportErrors(actor, spec, report, ctx); state.checkedHash = checkpointEvidenceHash(state);
      state.phase = report.status === 'completed' && checked.errors.length === 0 ? 'ready' : 'verifying';
      return { status: report.status, errors: checked.errors, gaps: report.gaps, changes: financialChangeSummary(financialChanges(report)), remainingQuestions: spec.questions.filter(q => !report.claims.some(c => c.questionId === q.id && c.status === 'supported')).map(q => q.id) };
    }),
    tool('submit_report', 'Finalize saved evidence after check_coverage. Insufficient evidence submits partial, never fabricated completion.', z.object({}).strict(), async () => {
      if (state.checkedHash !== checkpointEvidenceHash(state)) throw new Error('先 check_coverage({})');
      state.phase = 'ready'; state.submitted = true;
      for (const q of spec.questions) state.steps[`${q.id}-report`] = 'completed';
      return { saved: true };
    }, true),
  ];
  // Evaluation supplies real retained documents; no fixture replaces retrieval/model results.
  return fixedDocuments ? tools.filter(t => !['discover_filings', 'import_filing', 'parse_document'].includes(t.name)) : tools;
}
