import { describe, expect, it } from 'vitest';
import { allowedNow, nodeSoftCap, reserveForClosure, type BudgetPlan, type ClosureBudgetState } from './budget-policy';
import { emptyCheckpoint } from './execution-contracts';
import { claimReviewHash } from './claim-verification';
import { reportFixture, specFixture } from './version-test-fixtures';

const spec = specFixture();
const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64);
const supportedClaim = (id = 'cash-claim') => ({ id, questionId: 'cash_flow' as const, status: 'supported' as const });

describe('financial closure reserve', () => {
  it('reserves a separate review for each substantive draft, including several claims for one question', () => {
    const state: ClosureBudgetState = {
      claims: [supportedClaim('first'), supportedClaim('second'), { id: 'risk', questionId: 'risks', status: 'supported' }],
      steps: { 'cash_flow-verify': 'completed', 'risks-verify': 'completed' },
    };
    expect(reserveForClosure(spec, state)).toBe(5);
    expect(reserveForClosure(spec, { ...state, claimHashes: { first: hashA, second: hashB }, reviews: [{ claimHash: hashA, verdict: 'supported' }] })).toBe(4);
  });

  it('needs only coverage and submission once all current supported drafts have been reviewed', () => {
    const state: ClosureBudgetState = { claims: [supportedClaim()], claimHashes: { 'cash-claim': hashA }, reviews: [{ claimHash: hashA, verdict: 'supported' }] };
    expect(reserveForClosure(spec, state)).toBe(2);
    expect(reserveForClosure(spec, { ...state, checkedHash: hashB, submitted: true })).toBe(2);
    expect(reserveForClosure(spec, emptyCheckpoint(1, 1))).toBe(2);
  });

  it('preserves the two-call floor and pending reviews after coverage or a terminal flag', () => {
    expect(reserveForClosure(spec, { claims: [supportedClaim()], checkedHash: hashA, submitted: true })).toBe(3);
  });

  it('does not repeatedly review explicit gaps, conflicts, incomparable claims, or an unchanged reviewed failure', () => {
    const claims: ClosureBudgetState['claims'] = [
      { id: 'gap', questionId: 'cash_flow', status: 'evidence_gap' },
      { id: 'conflict', questionId: 'income_profit', status: 'conflict' },
      { id: 'incomparable', questionId: 'risks', status: 'incomparable' },
      supportedClaim(),
    ];
    for (const verdict of ['insufficient', 'conflict'] as const) {
      expect(reserveForClosure(spec, { claims, claimHashes: { 'cash-claim': hashA }, reviews: [{ claimHash: hashA, verdict }] })).toBe(2);
    }
    expect(reserveForClosure(spec, { claims })).toBe(3);
  });

  it('requires a new review after a claim or its referenced fact changes', () => {
    const report = reportFixture();
    const claim = report.claims[0], oldHash = claimReviewHash(report, claim);
    const state: ClosureBudgetState = { claims: [claim], claimHashes: { [claim.id]: oldHash }, reviews: [{ claimHash: oldHash, verdict: 'supported' }] };
    expect(reserveForClosure(spec, state)).toBe(2);
    const changedClaim = { ...claim, text: '经新证据修订的结论' };
    expect(reserveForClosure(spec, { ...state, claims: [changedClaim], claimHashes: { [claim.id]: claimReviewHash(report, changedClaim) } })).toBe(3);
    const changedReport = { ...report, facts: report.facts.map(fact => ({ ...fact, id: fact.id, citations: fact.citations.map(citation => ({ ...citation, quote: '修正后的现金流原文' })) })) };
    expect(reserveForClosure(spec, { ...state, claimHashes: { [claim.id]: claimReviewHash(changedReport, claim) } })).toBe(3);
    expect(reserveForClosure(spec, { ...state, claimHashes: { [claim.id]: claimReviewHash({ ...report, planRevision: 2 }, claim) } })).toBe(3);
  });

  it('does not mistake inherited hash properties or unmatched old reviews for current verification', () => {
    const claimHashes = Object.create({ 'cash-claim': hashA }) as Record<string, string>;
    const reviews = [{ claimHash: hashA, verdict: 'supported' as const }];
    expect(reserveForClosure(spec, { claims: [supportedClaim()], claimHashes, reviews })).toBe(3);
    expect(reserveForClosure(spec, { claims: [supportedClaim()], reviews })).toBe(3);
  });

  it('rejects ambiguous claim identity, out-of-scope questions, and malformed projections', () => {
    expect(() => reserveForClosure(spec, { claims: [supportedClaim(), supportedClaim()] })).toThrow('Invalid budget claim');
    expect(() => reserveForClosure({ questions: [{ id: 'income_profit' }] }, { claims: [supportedClaim()] })).toThrow('Invalid budget claim');
    expect(() => reserveForClosure(spec, { claims: [supportedClaim()], claimHashes: { 'cash-claim': 'not-a-hash' } })).toThrow('Invalid current claim hash');
    expect(() => reserveForClosure(spec, { claims: [], reviews: [{ claimHash: 'invalid', verdict: 'supported' }] })).toThrow('Invalid budget review');
  });

  it('does not mutate the checkpoint or the parent budget', () => {
    const state = emptyCheckpoint(1, 1), beforeState = structuredClone(state), beforeSpec = structuredClone(spec);
    Object.freeze(state.claims); Object.freeze(state); Object.freeze(spec.budget);
    expect(reserveForClosure(spec, state)).toBe(2);
    expect(state).toEqual(beforeState);
    expect(spec).toEqual(beforeSpec);
  });
});

describe('tool admission near the parent limit', () => {
  it('restricts the 38th call to review or closure when one claim is still unverified in a 40-call run', () => {
    const reserve = reserveForClosure(spec, { claims: [supportedClaim()] });
    expect(reserve).toBe(3);
    expect(allowedNow('search_evidence', 40 - 36, reserve)).toBe(true);
    expect(allowedNow('search_evidence', 40 - 37, reserve)).toBe(false);
    expect(allowedNow('record_claim', 40 - 37, reserve)).toBe(false);
    for (const tool of ['verify_claim', 'check_coverage', 'submit_report']) expect(allowedNow(tool, 40 - 37, reserve)).toBe(true);
    expect(allowedNow('check_coverage', 2, 2)).toBe(true);
    expect(allowedNow('submit_report', 1, 2)).toBe(true);
  });

  it('admits no calls with zero remaining, including terminal tools', () => {
    for (const tool of ['search_evidence', 'verify_claim', 'check_coverage', 'submit_report']) expect(allowedNow(tool, 0, 5)).toBe(false);
  });

  it('protects closure when the required reserve already exceeds the remaining budget', () => {
    expect(allowedNow('read_evidence', 2, 5)).toBe(false);
    expect(allowedNow('verify_claim', 2, 5)).toBe(true);
    expect(allowedNow('submit_report', 1, 5)).toBe(true);
    expect(allowedNow('search_evidence', 3, 2)).toBe(true);
    expect(allowedNow('search_evidence', 2, 2)).toBe(false);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('fails closed for an invalid count %s', value => {
    expect(allowedNow('verify_claim', value, 2)).toBe(false);
    expect(allowedNow('verify_claim', 10, value)).toBe(false);
  });
});

describe('node budget soft caps', () => {
  const plan: BudgetPlan = { nodes: [
    { id: 'income', budgetShare: 0.5 },
    { id: 'cash', budgetShare: 0.3 },
    { id: 'risk', budgetShare: 0.2 },
  ] };
  const caps = (candidate: BudgetPlan, total: number) => candidate.nodes.map(node => nodeSoftCap(candidate, node.id, total));

  it('distributes a bounded global pool by share and preserves a turn for each unfinished node', () => {
    expect(caps(plan, 40)).toEqual([20, 12, 8]);
    expect(caps({ nodes: [{ id: 'large', budgetShare: 1 }, { id: 'small', budgetShare: 0 }] }, 40)).toEqual([39, 1]);
    expect(caps(plan, 3)).toEqual([1, 1, 1]);
    expect(caps(plan, 2).reduce((sum, cap) => sum + cap, 0)).toBe(2);
    expect(caps(plan, 0)).toEqual([0, 0, 0]);
  });

  it('preserves proportional integer shares in the 13-node financial graph', () => {
    const graph: BudgetPlan = { nodes: [
      { id: 'prepare', budgetShare: 0.1 },
      ...['income', 'cash', 'risk'].flatMap(question => [
        { id: `${question}-retrieve`, budgetShare: 0.15 },
        { id: `${question}-compare`, budgetShare: 0.05 },
        { id: `${question}-verify`, budgetShare: 0.07 },
        { id: `${question}-report`, budgetShare: 0.03 },
      ]),
    ] };
    expect(nodeSoftCap(graph, 'income-retrieve', 40)).toBe(6);
    expect(nodeSoftCap(graph, 'income-compare', 40)).toBe(2);
    expect(caps(graph, 40).reduce((sum, cap) => sum + cap, 0)).toBe(40);
  });

  it('returns a cumulative limit, so reaching it yields rather than replenishing that node', () => {
    const used: BudgetPlan = { nodes: plan.nodes.map(node => ({ ...node, status: 'running', toolCalls: node.id === 'income' ? 20 : 0 })) };
    expect(nodeSoftCap(used, 'income', 40)).toBe(20);
    expect(nodeSoftCap(used, 'cash', 40)).toBe(12);
    expect(nodeSoftCap(used, 'risk', 40)).toBe(8);
    expect(nodeSoftCap({ nodes: used.nodes.map(node => ({ ...node, toolCalls: node.id === 'income' ? 35 : 0 })) }, 'cash', 40)).toBeLessThanOrEqual(5);
  });

  it('releases only unused terminal shares without refunding actual consumed calls', () => {
    for (const status of ['completed', 'partial', 'failed', 'cancelled'] as const) {
      const candidate: BudgetPlan = { nodes: [{ id: 'income', budgetShare: 0.5, status, toolCalls: 10 }, { id: 'cash', budgetShare: 0.3 }, { id: 'risk', budgetShare: 0.2 }] };
      expect(caps(candidate, 40)).toEqual([0, 18, 12]);
    }
    expect(caps({ nodes: [{ id: 'finished', budgetShare: 0.5, status: 'completed', toolCalls: 40 }, { id: 'cash', budgetShare: 0.5 }] }, 40)).toEqual([0, 0]);
  });

  it('retains shares for ready, running, pending and waiting-input nodes', () => {
    for (const status of ['ready', 'running', 'pending', 'waiting_input'] as const) {
      expect(nodeSoftCap({ nodes: [{ id: 'income', budgetShare: 0.5, status }, { id: 'cash', budgetShare: 0.5 }] }, 'cash', 40)).toBe(20);
    }
  });

  it('rounds deterministically, handles zero shares, and stays bounded for very large valid budgets', () => {
    const equal: BudgetPlan = { nodes: ['c', 'a', 'b'].map(id => ({ id, budgetShare: 0 })) };
    expect(caps(equal, 4)).toEqual([1, 2, 1]);
    for (const total of [1, 2, 7, 40, Number.MAX_SAFE_INTEGER]) {
      const actual = caps(plan, total);
      expect(actual.every(cap => Number.isSafeInteger(cap) && cap >= 0 && cap <= total)).toBe(true);
      expect(actual.reduce((sum, cap) => sum + cap, 0)).toBeLessThanOrEqual(total);
    }
    const before = structuredClone(plan);
    nodeSoftCap(plan, 'cash', 40);
    expect(plan).toEqual(before);
  });

  it('rejects duplicate nodes, invalid usage or shares, unknown ids, and invalid parent totals', () => {
    expect(() => nodeSoftCap({ nodes: [plan.nodes[0], plan.nodes[0]] }, 'income', 40)).toThrow('Invalid budget node id');
    expect(() => nodeSoftCap(plan, 'unknown', 40)).toThrow('Unknown budget node');
    for (const budgetShare of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => nodeSoftCap({ nodes: [{ id: 'income', budgetShare }] }, 'income', 40)).toThrow('Invalid node budget share');
    for (const toolCalls of [-1, 0.5, Number.NaN]) expect(() => nodeSoftCap({ nodes: [{ id: 'income', budgetShare: 1, toolCalls }] }, 'income', 40)).toThrow('Invalid node tool usage');
    for (const total of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => nodeSoftCap(plan, 'income', total)).toThrow('Invalid parent tool budget');
  });
});
