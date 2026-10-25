import type { PiAgentToolResult } from '@/lib/agent/types';
import { artifactDigest } from './artifact-store';
import { allowedNow, nodeSoftCap, reserveForClosure } from './budget-policy';
import { claimReviewHash, semanticReviewSchema, type SemanticReview } from './claim-verification';
import { checkpointV2Schema, type ResearchCheckpoint, type ResearchCheckpointV2 } from './execution-contracts';
import { classifyGap, repairAction, updateGap, type GapObservation } from './gap-policy';
import { buildFinancialPlanV2, readyNodes, revisePlan, type PlanNode, type ResearchPlanV2 } from './plan-graph';
import { canonicalResearchJson, researchIdSchema, type ResearchTaskSpec } from './task-contracts';
import { researchLocatorSchema } from './document-contracts';
import type { FinancialPlanRevisionEvent } from './execution-store';

type SourcePeriod = { id: string; version: number; period: { id: string } };
type SchedulerOptions = { taskId: string; spec: ResearchTaskSpec; state: ResearchCheckpointV2; createdAt: string; reviews: SemanticReview[] };
export type FinancialNextAction = { nodeId: string; questionId: PlanNode['questionId']; kind: PlanNode['kind'];
  action: string; allowedTools: string[]; claimId?: string; instruction: string; repair?: ReturnType<typeof repairAction> };
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const countKeys = (state: ResearchCheckpointV2) => Object.values(state.evidenceLedger).reduce((sum, entry) => sum + entry.locatorKeys.length + entry.evidenceHashes.length, 0);

/** Upgrade public materialized work only. A completed question-level step is not a claim review. */
export function upgradeFinancialCheckpoint(state: ResearchCheckpoint, plan: ResearchPlanV2, documents: readonly SourcePeriod[], periodIds?: readonly string[]): ResearchCheckpointV2 {
  const mergePeriods = (target: ResearchCheckpointV2) => {
    for (const document of documents) {
      const key = `${document.id}:${document.version}`;
      if (researchIdSchema.safeParse(document.id).success && Number.isSafeInteger(document.version) && document.version > 0
        && researchIdSchema.safeParse(document.period.id).success && (!periodIds || periodIds.includes(document.period.id))
        && (Object.hasOwn(target.documentPeriods, key) || Object.keys(target.documentPeriods).length < 100)) target.documentPeriods[key] = document.period.id;
    }
    if (documents.length && ['pending', 'ready', 'running'].includes(target.nodes['prepare-facts'])) target.nodes['prepare-facts'] = 'completed';
    return checkpointV2Schema.parse(target);
  };
  if (state.schemaVersion === 2) {
    const ids = new Set(plan.nodes.map(node => node.id));
    if (Object.keys(state.nodes).some(id => !ids.has(id)) || plan.nodes.some(node => !Object.hasOwn(state.nodes, node.id))) throw new Error('SCHEDULER_NODE_BINDING');
    return mergePeriods(checkpointV2Schema.parse(state));
  }
  const nodes = Object.fromEntries(plan.nodes.map(node => [node.id, 'pending']));
  // The provided inventory itself completes the bounded shared preparation attempt.
  if (documents.length || state.facts.length || state.claims.length) nodes['prepare-facts'] = 'completed';
  for (const question of plan.steps.map(step => step.questionId)) if (state.claims.some(claim => claim.questionId === question)) {
    nodes[`${question}-retrieve`] = 'completed'; nodes[`${question}-compare`] = 'completed';
  }
  return mergePeriods(checkpointV2Schema.parse({ ...state, schemaVersion: 2, variant: 'B', nodes, gaps: [], planVersion: plan.revision, closureReserve: 2,
    currentNodeId: null, nodeToolCalls: {}, evidenceLedger: {}, nodeReadPeriods: {}, verificationAttempts: {}, resolvedGapIds: [],
    documentPeriods: {} }));
}

/** Application-owned state machine; the PI loop still chooses and executes individual tools. */
export class FinancialScheduler {
  readonly state: ResearchCheckpointV2;
  readonly spec: ResearchTaskSpec;
  private plan: ResearchPlanV2;
  private reviews: SemanticReview[];
  private readonly taskId: string;
  private beforeMaterial: string | null = null;
  constructor(options: SchedulerOptions) {
    this.state = options.state; this.spec = options.spec; this.taskId = options.taskId; this.reviews = [...options.reviews];
    this.plan = buildFinancialPlanV2(options.spec, { taskId: options.taskId, createdAt: options.createdAt, revision: options.state.planVersion });
    upgradeFinancialCheckpoint(options.state, this.plan, []);
    for (const node of this.plan.nodes) if (this.state.nodes[node.id] === 'running' || this.state.nodes[node.id] === 'ready') this.state.nodes[node.id] = 'pending';
    this.refresh();
  }
  get graph() { return this.plan; }
  get claimReviews() { return this.reviews; }
  private hashes() {
    const binding = { taskId: this.taskId, requestRevision: this.state.requestRevision, planRevision: this.state.planRevision,
      asOf: this.spec.asOf, facts: this.state.facts, supportingFacts: this.state.supportingFacts };
    return Object.fromEntries(this.state.claims.map(claim => [claim.id, claimReviewHash(binding, claim)]));
  }
  private materialHash() {
    const byId = <T extends { id: string }>(values: readonly T[]) => [...values].sort((a, b) => a.id.localeCompare(b.id));
    return artifactDigest(canonicalResearchJson({ facts: byId(this.state.facts), supportingFacts: byId(this.state.supportingFacts || []), claims: byId(this.state.claims) }));
  }
  private materialProgress(nodeId: string, hash: string) {
    this.state.gaps = this.state.gaps.map(gap => {
      if (gap.targetNodeId !== nodeId || gap.status !== 'open' || this.state.resolvedGapIds.includes(gap.id)) return gap;
      const seenEvidenceHashes = [...new Set([...gap.seenEvidenceHashes, hash])];
      return seenEvidenceHashes.length > 256 ? { ...gap, status: 'partial' as const, stopReason: 'evidence_limit' as const }
        : { ...gap, stalledAttempts: 0, newLocatorKeys: [], newEvidenceHashes: [hash], seenEvidenceHashes };
    });
    if (this.activeGaps(nodeId).some(gap => gap.status === 'partial')) this.state.nodes[nodeId] = 'partial';
  }
  private activeGaps(nodeId: string) { return this.state.gaps.filter(gap => gap.targetNodeId === nodeId && !this.state.resolvedGapIds.includes(gap.id)); }
  private refresh() {
    const hashes = this.hashes();
    this.state.closureReserve = reserveForClosure(this.spec, { ...this.state, claimHashes: hashes, reviews: this.reviews });
    for (const question of this.spec.questions) {
      const claims = this.state.claims.filter(claim => claim.questionId === question.id), id = `${question.id}-verify`;
      const supported = claims.length > 0 && claims.every(claim => claim.status === 'supported' && this.reviews.some(review => review.claimHash === hashes[claim.id] && review.verdict === 'supported'));
      if (this.state.nodes[id] === 'completed' && !supported) this.state.nodes[id] = 'pending';
      if (this.state.nodes[`${question.id}-compare`] !== 'completed') continue;
      if (supported) this.state.nodes[id] = 'completed';
      else if (claims.length && claims.every(claim => claim.status !== 'supported')) this.state.nodes[id] = 'partial';
      else if (this.state.nodes[id] === 'completed') this.state.nodes[id] = 'pending';
    }
  }
  private gap(node: PlanNode, kind: GapObservation['kind'], reason: string, tool?: string, evidence?: GapObservation['evidence'], subjectId?: string, query?: string) {
    const gap = classifyGap({ targetNodeId: node.id, questionId: node.questionId, question: node.title, kind, reason: reason.slice(0, 600),
      ...(tool ? { tool } : {}), ...(evidence ? { evidence } : {}), ...(subjectId ? { subjectId } : {}), ...(query ? { query: query.slice(0, 300) } : {}) }, this.state);
    if (gap) { this.state.gaps = updateGap(this.state.gaps, gap); this.state.resolvedGapIds = this.state.resolvedGapIds.filter(id => id !== gap.id); }
    return gap;
  }
  private finishPartial(node: PlanNode, reason: string) {
    this.state.nodes[node.id] = 'partial';
    const gaps = this.activeGaps(node.id);
    if (!gaps.length) this.gap(node, 'retrieval_miss', reason);
    this.state.gaps = this.state.gaps.map(gap => gap.targetNodeId === node.id && !this.state.resolvedGapIds.includes(gap.id) && gap.status === 'open'
      ? { ...gap, status: 'partial' as const, stopReason: 'attempt_limit' as const, reason: reason.slice(0, 600) } : gap);
  }
  private resolve(nodeId: string) {
    this.state.resolvedGapIds = [...new Set([...this.state.resolvedGapIds, ...this.activeGaps(nodeId).map(gap => gap.id)])];
  }
  private revise(nodeId: string, reason: string): FinancialPlanRevisionEvent {
    const revision = revisePlan(this.plan, { changedNodeIds: [nodeId] }); this.plan = revision.plan;
    this.state.planVersion = revision.plan.revision;
    for (const id of revision.invalidated) this.state.nodes[id] = 'pending';
    this.state.nodeReadPeriods[nodeId] = []; this.state.currentNodeId = null;
    return { planVersion: this.state.planVersion, reason: reason.slice(0, 400), affectedNodeIds: revision.invalidated, retainedNodeIds: revision.retained };
  }
  private effectiveStates() {
    // A partial stage can feed an honest evidence_gap into the next stage. Its public status remains partial.
    return Object.fromEntries(Object.entries(this.state.nodes).map(([id, status]) => [id, status === 'partial' ? 'completed' : status]));
  }
  private action(node: PlanNode, repair?: ReturnType<typeof repairAction>, claimId?: string): FinancialNextAction {
    this.state.currentNodeId = node.id;
    const focus = node.questionId === 'cash_flow' ? '查两期现金流方向及同比变化的原文解释；数字相关不能代替解释。'
      : node.questionId === 'risks' ? '查两期风险清单，缺证不能断言风险消失。' : '核对两期收入、归母利润及口径。';
    const instruction = node.kind === 'prepare' ? '完成一次有界资料准备；缺失金额记录缺口后继续三问，不等全部金额齐全。'
      : node.kind === 'retrieve' ? `${focus} 搜索命中后 read_evidence 核对原文；换词但无新定位/内容不算进展。`
      : node.kind === 'compare' ? `${focus} 使用 record_fact/record_claim 保存本问；修复已有结论时沿用原 id，缺证保留 evidence_gap。`
      : node.kind === 'verify' ? `只核验当前结论 ${claimId || ''}；同题其他结论分别核验。` : 'check_coverage 后 submit_report，缺口如实 partial。';
    return { nodeId: node.id, questionId: node.questionId, kind: node.kind, action: repair?.action || node.kind,
      allowedTools: [...node.allowedTools], ...(claimId ? { claimId } : {}), instruction, ...(repair ? { repair } : {}) };
  }
  nextAction(remaining: number): FinancialNextAction | null {
    this.refresh();
    if (this.state.submitted || remaining === 0) return null;
    const closure = remaining <= this.state.closureReserve;
    if (closure) for (const node of this.plan.nodes) if (['prepare', 'retrieve', 'compare'].includes(node.kind) && !terminal.has(this.state.nodes[node.id])) this.finishPartial(node, '剩余预算已进入核验与收尾预留区');
    for (let pass = 0; pass < this.plan.nodes.length + 1; pass++) {
      const candidates = readyNodes(this.plan, this.effectiveStates());
      // The three questions get a retrieval/compare pass before deep repair or reporting.
      candidates.sort((a, b) => ['prepare', 'retrieve', 'compare', 'verify', 'report'].indexOf(a.kind) - ['prepare', 'retrieve', 'compare', 'verify', 'report'].indexOf(b.kind));
      let advanced = false;
      const overflow: { node: PlanNode; repair?: ReturnType<typeof repairAction> }[] = [];
      for (const node of candidates) {
        if (node.kind === 'report') {
          if (this.plan.nodes.some(other => other.kind !== 'report' && !terminal.has(this.state.nodes[other.id]))) continue;
          return this.action(node);
        }
        if (node.kind === 'verify') {
          const hashes = this.hashes(), claim = this.state.claims.find(claim => claim.questionId === node.questionId && claim.status === 'supported'
            && !this.reviews.some(review => review.claimHash === hashes[claim.id] && review.verdict === 'supported') && this.state.verificationAttempts[claim.id] !== hashes[claim.id]);
          if (claim) return this.action(node, undefined, claim.id);
          this.state.nodes[node.id] = 'partial'; advanced = true; continue;
        }
        const projected = { nodes: this.plan.nodes.map(other => ({ ...other, status: this.state.nodes[other.id], toolCalls: this.state.nodeToolCalls[other.id] || 0 })) };
        const gap = this.activeGaps(node.id).at(-1), repair = gap ? repairAction(gap, { remaining, reserve: this.state.closureReserve }) : undefined;
        if (repair && ['finalize_partial', 'stop', 'verify_and_finalize'].includes(repair.action)) {
          this.finishPartial(node, gap!.reason); advanced = true; continue;
        }
        if ((this.state.nodeToolCalls[node.id] || 0) >= nodeSoftCap(projected, node.id, this.spec.budget.maxToolCalls)) { overflow.push({ node, repair }); continue; }
        return this.action(node, repair);
      }
      // A share is a scheduling preference, never a hard gate against required facts/claims.
      if (overflow.length && !advanced) return this.action(overflow[0].node, overflow[0].repair);
      if (!advanced) return null;
    }
    return null;
  }
  admit(tool: string, input: unknown, remaining: number): PiAgentToolResult | null {
    const action = this.nextAction(remaining), args = record(input);
    const denied = (code: string, message: string): PiAgentToolResult => ({ ok: false, error: { code, message, details: { nextAction: action, remaining, closureReserve: this.state.closureReserve } } });
    if (!allowedNow(tool, remaining, this.state.closureReserve)) return denied('SCHEDULER_CLOSURE_RESERVED', '剩余额度仅允许核验与收尾工具；未扣减工具预算');
    if (!action || !action.allowedTools.includes(tool)) return denied('SCHEDULER_TOOL_NOT_ALLOWED', '工具不在当前节点白名单；按 nextAction 继续，未扣减工具预算');
    if (tool === 'record_claim' && (args.questionId !== action.questionId
      || this.state.claims.some(claim => claim.id === args.id && claim.questionId !== action.questionId))) return denied('SCHEDULER_NODE_MISMATCH', '只能修改当前问题的结论；不能复用其他问题的结论 id');
    if (tool === 'record_fact' && action.kind !== 'prepare' && (args.metric === 'operating_cash_flow' ? 'cash_flow' : 'income_profit') !== action.questionId) return denied('SCHEDULER_NODE_MISMATCH', '只能修改当前问题的事实');
    if (tool === 'verify_claim' && args.claimId !== action.claimId) return denied('SCHEDULER_NODE_MISMATCH', '必须核验 nextAction 指定的当前结论');
    if (tool === 'submit_report' && !this.state.checkedHash) return denied('SCHEDULER_COVERAGE_REQUIRED', '先 check_coverage，未扣减工具预算');
    return null;
  }
  started() {
    const id = this.state.currentNodeId; if (!id) throw new Error('SCHEDULER_NO_CURRENT_NODE');
    this.beforeMaterial = this.materialHash();
    this.state.nodes[id] = 'running'; this.state.nodeToolCalls[id] = (this.state.nodeToolCalls[id] || 0) + 1;
  }
  private evidence(tool: string, input: unknown, data: unknown, node: PlanNode): NonNullable<GapObservation['evidence']> {
    const output = record(data), args = record(input), rows = tool === 'search_evidence' && Array.isArray(output.hits) ? output.hits : tool === 'read_evidence' ? [output] : [];
    const ledger = this.state.evidenceLedger[node.id] ||= { locatorKeys: [], evidenceHashes: [] }, gained: NonNullable<GapObservation['evidence']> = [];
    for (const raw of rows.slice(0, 20)) {
      const row = record(raw), locator = researchLocatorSchema.safeParse(row.locator);
      if (!locator.success || typeof row.sourceId !== 'string' || !Number.isSafeInteger(row.documentVersion) || typeof row.bytesSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.bytesSha256)) continue;
      if (tool === 'read_evidence' && (typeof row.text !== 'string' || !row.text.trim())) continue;
      const identity = { documentId: row.sourceId, documentVersion: row.documentVersion as number, bytesSha256: row.bytesSha256, locator: locator.data };
      // Text chunks and search snippets use distinct hashes. A new read chunk can add progress on an old locator.
      const locatorKey = artifactDigest(canonicalResearchJson(identity));
      const content = tool === 'read_evidence' ? row.text : row.snippet;
      const evidenceHash = typeof content === 'string' && content.trim() ? artifactDigest(canonicalResearchJson({ ...identity, tool, offset: row.offset ?? row.textOffset ?? args.offset ?? 0, content })) : null;
      const newLocator = !ledger.locatorKeys.includes(locatorKey), newHash = !!evidenceHash && !ledger.evidenceHashes.includes(evidenceHash);
      if ((newLocator || newHash) && (!newLocator || ledger.locatorKeys.length < 256) && (!newHash || ledger.evidenceHashes.length < 256)
        && countKeys(this.state) + Number(newLocator) + Number(newHash) <= 512) {
        if (newLocator) ledger.locatorKeys.push(locatorKey); if (newHash) ledger.evidenceHashes.push(evidenceHash!);
        gained.push({ ...identity, ...(newHash ? { evidenceHash: evidenceHash! } : {}) });
      }
      const sourceKey = `${row.sourceId}:${row.documentVersion}`;
      if (typeof row.periodId === 'string' && this.spec.periods.some(period => period.id === row.periodId)
        && (Object.hasOwn(this.state.documentPeriods, sourceKey) || Object.keys(this.state.documentPeriods).length < 100)) this.state.documentPeriods[sourceKey] = row.periodId;
      const period = this.state.documentPeriods[`${row.sourceId}:${row.documentVersion}`];
      if (tool === 'read_evidence' && typeof row.text === 'string' && row.text.trim() && period) this.state.nodeReadPeriods[node.id] = [...new Set([...(this.state.nodeReadPeriods[node.id] || []), period])];
    }
    return gained;
  }
  observe(tool: string, input: unknown, result: PiAgentToolResult, remaining: number): FinancialPlanRevisionEvent | null {
    const node = this.plan.nodes.find(node => node.id === this.state.currentNodeId); if (!node) throw new Error('SCHEDULER_NO_CURRENT_NODE');
    this.state.nodes[node.id] = 'pending';
    const args = record(input), data = result.ok ? record(result.data) : {};
    if (!result.ok) {
      const kind = /UNIT|PERIOD|SCOPE|COLUMN|CONFLICT/i.test(result.error.message) ? 'period_unit_conflict' : 'tool_transient';
      const gap = this.gap(node, kind, result.error.message, tool);
      if (gap?.status !== 'open') this.state.nodes[node.id] = 'partial';
      const revision = this.revise(node.id, result.error.message);
      if (gap?.status !== 'open') this.state.nodes[node.id] = 'partial';
      return revision;
    }
    if (tool === 'list_documents' && Array.isArray(result.data)) for (const raw of result.data.slice(0, 100)) {
      const document = record(raw), period = record(document.period);
      const key = `${document.id}:${document.version}`;
      if (typeof document.id === 'string' && typeof document.version === 'number' && typeof period.id === 'string'
        && this.spec.periods.some(expected => expected.id === period.id) && (Object.hasOwn(this.state.documentPeriods, key) || Object.keys(this.state.documentPeriods).length < 100)) this.state.documentPeriods[key] = period.id;
    }
    if (node.kind === 'prepare') { this.state.nodes[node.id] = 'completed'; this.resolve(node.id); }
    if (tool === 'search_evidence' || tool === 'read_evidence') {
      const evidence = this.evidence(tool, input, result.data, node);
      if (node.kind === 'retrieve') {
        if (this.spec.periods.every(period => this.state.nodeReadPeriods[node.id]?.includes(period.id))) { this.state.nodes[node.id] = 'completed'; this.resolve(node.id); }
        else {
          const subject = this.activeGaps(node.id).at(-1)?.subjectId || undefined;
          const gap = this.gap(node, 'retrieval_miss', '仍需读取两期完整定位原文；当前命中不证明解释已获支持', tool, evidence, subject, typeof args.query === 'string' ? args.query : undefined);
          if (gap?.status !== 'open') this.state.nodes[node.id] = 'partial';
        }
      } else if (node.kind === 'compare' || node.kind === 'verify') {
        const subject = this.activeGaps(node.id).at(-1)?.subjectId || undefined;
        const gap = this.gap(node, 'retrieval_miss', '定向补查仍需新的定位、原文内容或已保存材料；重复换词不算进展', tool, evidence, subject, typeof args.query === 'string' ? args.query : undefined);
        if (gap?.status !== 'open') this.state.nodes[node.id] = 'partial';
      }
    }
    if (tool === 'record_fact') {
      const hash = this.materialHash();
      if (hash !== this.beforeMaterial) this.materialProgress(node.id, hash);
      else {
        const gap = this.gap(node, 'retrieval_miss', '重复保存相同事实没有新增材料', tool, []);
        if (gap?.status !== 'open') this.state.nodes[node.id] = 'partial';
      }
    }
    if (tool === 'record_claim') { this.state.nodes[node.id] = 'completed'; this.resolve(node.id); this.state.nodes[`${node.questionId}-verify`] = 'pending'; }
    if (tool === 'record_fact' && data.fact && record(data.fact).value && record(record(data.fact).value).status === 'conflict') {
      this.gap(node, 'period_unit_conflict', '同期间原始金额冲突未解决，禁止合并为确定结论', tool);
      return this.revise(node.id, '财务事实冲突，局部重规划');
    }
    if (tool === 'verify_claim' && typeof args.claimId === 'string') {
      const hash = this.hashes()[args.claimId]; this.state.verificationAttempts[args.claimId] = hash;
      const parsed = semanticReviewSchema.safeParse(result.data);
      if (parsed.success) this.reviews = [...this.reviews.filter(review => review.claimHash !== parsed.data.claimHash), parsed.data];
      if (!parsed.success || parsed.data.verdict !== 'supported') {
        const target = this.plan.nodes.find(other => other.id === `${node.questionId}-retrieve`)!;
        const reason = typeof data.reason === 'string' ? data.reason : '核验未获支持，需要定向补查；不重复未改变的核验请求';
        const gap = this.gap(target, 'retrieval_miss', reason, tool, [], args.claimId);
        if (gap?.status === 'open' && remaining > this.state.closureReserve) return this.revise(target.id, reason);
        this.state.nodes[node.id] = 'partial';
      }
    }
    if (tool === 'check_coverage') this.state.nodes[node.id] = 'pending';
    if (tool === 'submit_report') for (const other of this.plan.nodes.filter(other => other.kind === 'report')) this.state.nodes[other.id] = 'completed';
    this.refresh();
    return null;
  }
}
