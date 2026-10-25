import type { ResearchClaim, SemanticReview } from './claim-verification';
import type { ResearchTaskSpec } from './task-contracts';

export type ClosureBudgetSpec = Readonly<{
  questions: readonly Pick<ResearchTaskSpec['questions'][number], 'id'>[];
}>;
export type ClosureBudgetState = Readonly<{
  claims: readonly Pick<ResearchClaim, 'id' | 'questionId' | 'status'>[];
  /** Current claimReviewHash values, projected by the trusted execution layer. */
  claimHashes?: Readonly<Record<string, string>>;
  reviews?: readonly Pick<SemanticReview, 'claimHash' | 'verdict'>[];
  steps?: Readonly<Record<string, string>>;
  checkedHash?: string | null;
  submitted?: boolean;
}>;

const claimStatuses = new Set(['supported', 'evidence_gap', 'conflict', 'incomparable']);
const reviewVerdicts = new Set(['supported', 'insufficient', 'conflict']);
const closureTools = new Set(['verify_claim', 'check_coverage', 'submit_report']);
const sha256 = /^[a-f0-9]{64}$/i;
const validId = (id: string) => typeof id === 'string' && id.length > 0 && id.length <= 100 && id.trim() === id;
const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Allocation advice only; reserveResearchToolCall remains the authoritative debit. */
export function reserveForClosure(spec: ClosureBudgetSpec, state: ClosureBudgetState): number {
  const questions = new Set<string>();
  for (const question of spec.questions) {
    if (!validId(question.id) || questions.has(question.id)) throw new Error('Invalid budget question id');
    questions.add(question.id);
  }
  const reviewed = new Set<string>();
  for (const review of state.reviews || []) {
    if (!sha256.test(review.claimHash) || !reviewVerdicts.has(review.verdict)) throw new Error('Invalid budget review');
    reviewed.add(review.claimHash);
  }
  const claimIds = new Set<string>();
  let unverified = 0;
  for (const claim of state.claims) {
    if (!validId(claim.id) || claimIds.has(claim.id) || !questions.has(claim.questionId) || !claimStatuses.has(claim.status)) throw new Error('Invalid budget claim');
    claimIds.add(claim.id);
    const hash = state.claimHashes && Object.hasOwn(state.claimHashes, claim.id) ? state.claimHashes[claim.id] : undefined;
    if (hash !== undefined && !sha256.test(hash)) throw new Error('Invalid current claim hash');
    // Explicit gaps/conflicts/incomparability already preserve an honest partial.
    // A draft marked supported still needs a review for its current evidence hash.
    if (claim.status === 'supported' && (!hash || !reviewed.has(hash))) unverified++;
  }
  // Keep the two-call floor even after a coverage check or submission. The caller
  // handles terminal state; neither flag nor question-level steps prove review.
  return unverified + 2;
}

/** A denied call must be rejected before any global budget debit. */
export function allowedNow(tool: string, remaining: number, reserve: number): boolean {
  if (!validCount(remaining) || !validCount(reserve) || remaining === 0 || typeof tool !== 'string' || !tool.trim()) return false;
  return remaining > reserve || closureTools.has(tool);
}

export type BudgetNodeStatus = 'pending' | 'ready' | 'running' | 'waiting_input' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type BudgetPlanNode = Readonly<{
  id: string;
  budgetShare: number;
  status?: BudgetNodeStatus;
  /** Calls charged to this node in the current parent budget round. */
  toolCalls?: number;
}>;
export type BudgetPlan = Readonly<{ nodes: readonly BudgetPlanNode[] }>;

const nodeStatuses = new Set<BudgetNodeStatus>(['pending', 'ready', 'running', 'waiting_input', 'completed', 'partial', 'failed', 'cancelled']);
const terminalStatuses = new Set<BudgetNodeStatus>(['completed', 'partial', 'failed', 'cancelled']);

/**
 * Return a cumulative per-node soft cap within the unchanged parent total.
 * Static U10 nodes work directly; project checkpoint status/toolCalls onto them
 * to release unused terminal-node shares. An over-cap node yields to other work.
 */
export function nodeSoftCap(plan: BudgetPlan, nodeId: string, total: number): number {
  if (!validCount(total)) throw new RangeError('Invalid parent tool budget');
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (!validId(node.id) || ids.has(node.id)) throw new Error('Invalid budget node id');
    if (!Number.isFinite(node.budgetShare) || node.budgetShare < 0 || node.budgetShare > 1) throw new RangeError('Invalid node budget share');
    if (node.status !== undefined && !nodeStatuses.has(node.status)) throw new Error('Invalid budget node status');
    if (node.toolCalls !== undefined && !validCount(node.toolCalls)) throw new RangeError('Invalid node tool usage');
    ids.add(node.id);
  }
  const target = plan.nodes.find(node => node.id === nodeId);
  if (!target) throw new Error('Unknown budget node');
  if (total === 0 || (target.status && terminalStatuses.has(target.status))) return 0;

  const active = plan.nodes.filter(node => !node.status || !terminalStatuses.has(node.status));
  const spent = (nodes: readonly BudgetPlanNode[]) => nodes.reduce((sum, node) => Math.min(total, sum + (node.toolCalls || 0)), 0);
  const pool = total - spent(plan.nodes.filter(node => node.status && terminalStatuses.has(node.status)));
  const weightTotal = active.reduce((sum, node) => sum + node.budgetShare, 0);
  let unallocated = pool;
  const allocations = active.map(node => {
    const exact = pool * (weightTotal ? node.budgetShare / weightTotal : 1 / active.length);
    // Clamp against the pool as well as the integer total, including huge counts.
    const calls = Math.min(unallocated, Math.floor(exact));
    unallocated -= calls;
    return { id: node.id, calls, remainder: exact - Math.floor(exact) };
  });
  // Largest-remainder rounding is stable and never promises more than the pool.
  const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  for (const allocation of [...allocations].sort((a, b) => b.remainder - a.remainder || byId(a, b))) {
    if (unallocated === 0) break;
    allocation.calls++;
    unallocated--;
  }
  // Apply a minimum only where proportional rounding gave no turn. Otherwise
  // integer shares (e.g. 15% of 40 calls) retain their exact allocation.
  if (pool >= active.length) {
    for (const allocation of allocations.filter(node => node.calls === 0)) {
      const donor = [...allocations].sort((a, b) => b.calls - a.calls || byId(a, b))[0];
      if (donor.calls <= 1) break;
      donor.calls--;
      allocation.calls++;
    }
  }
  const allocated = allocations.find(node => node.id === nodeId)!.calls;
  return Math.min(total, allocated, total - spent(plan.nodes.filter(node => node.id !== nodeId)));
}
