import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyGap, gapPolicyLimits, gapPolicyStateSchema, notDisclosedConfirmationSchema,
  repairAction, updateGap, type GapObservation, type ResearchGap,
} from './gap-policy';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const observation = (overrides: Partial<GapObservation> = {}): GapObservation => ({
  kind: 'retrieval_miss', targetNodeId: 'cash_flow-retrieve', questionId: 'cash_flow',
  question: '两期经营现金流变化有何可核实的解释？', tool: 'search_evidence', ...overrides,
});
const evidence = (page = 1, text = '本地合成原文', documentId = 'annual-2024') => ({
  documentId, documentVersion: 1, bytesSha256: hash(documentId), locator: { kind: 'page' as const, filePage: page },
  evidenceHash: hash(text),
});
function series(inputs: GapObservation[]) {
  let gaps: ResearchGap[] = [];
  for (const input of inputs) gaps = updateGap(gaps, classifyGap(input, { gaps })!);
  return gaps[0];
}
const ampleBudget = { remaining: 30, reserve: 4 };
function confirmation(authority: 'human' | 'original_scope' = 'human') {
  const { targetNodeId, questionId, question } = observation();
  return notDisclosedConfirmationSchema.parse({
    targetNodeId, questionId, question, authority, receiptSha256: hash('可信应用确认回执'), explicitlyConfirmed: true,
    periodIds: ['FY2023', 'FY2024'], originals: ['FY2023', 'FY2024'].map(periodId => ({
      documentId: periodId, documentVersion: 1, bytesSha256: hash(periodId), periodId,
      complete: true, truncated: false, failedPages: 0, quality: 'native',
    })),
  });
}
const notDisclosed = (overrides: Partial<GapObservation> = {}) => observation({
  kind: 'not_disclosed', requiredPeriodIds: ['FY2023', 'FY2024'], notDisclosedConfirmation: confirmation(), ...overrides,
});

describe('retrieval gaps follow evidence rather than query wording', () => {
  it('directs an empty search to retrieval and a located but incomplete explanation to its source page', () => {
    const empty = classifyGap(observation())!;
    const located = classifyGap(observation({ evidence: [evidence(12)] }))!;
    expect(empty.type).toBe('retrieval_miss');
    expect(repairAction(empty, ampleBudget).action).toBe('search_evidence');
    expect(repairAction(located, ampleBudget)).toMatchObject({ action: 'read_targeted_evidence', targetNodeId: 'cash_flow-retrieve' });
  });

  it('stops keyword rotation without new evidence as partial, without asserting non-disclosure', () => {
    const gap = series(['现金流原因', '现金净额变化', '资金收付解释', '经营活动分析'].map(query => observation({ query })));
    expect(gap).toMatchObject({ type: 'retrieval_miss', status: 'partial', attempts: 4, stalledAttempts: 4,
      queryChanged: true, stopReason: 'no_new_evidence', notDisclosedConfirmation: null });
    expect(repairAction(gap, ampleBudget)).toMatchObject({ action: 'finalize_partial', maxAttempts: 0, stopWhen: ['no_new_evidence_limit'] });
  });

  it('does not count the same located content as progress when query, page label or bounding box changes', () => {
    const first = evidence(12);
    const gap = series([
      observation({ query: '原关键词', evidence: [first] }),
      ...Array.from({ length: 4 }, (_, i) => observation({ query: `改写关键词${i}`, evidence: [{ ...first,
        locator: { ...first.locator, printedPage: `${i + 1}`, box: { x0: 0, y0: 0, x1: 0.8 + i * 0.01, y1: 1 } },
      }] })),
    ]);
    expect(gap.status).toBe('partial'); expect(gap.stalledAttempts).toBe(4);
    expect(gap.seenLocatorKeys).toHaveLength(1); expect(gap.seenEvidenceHashes).toHaveLength(1);
    expect(gap.newLocatorKeys).toEqual([]); expect(gap.newEvidenceHashes).toEqual([]);
  });

  it('resets consecutive stagnation for a new locator or newly read content at an existing locator', () => {
    const original = evidence(12), extraText = evidence(12, '同页下一段真实新增内容');
    const first = series([observation({ evidence: [original] }), observation({ evidence: [original] })]);
    const addedText = classifyGap(observation({ evidence: [extraText] }), { gaps: [first] })!;
    const addedPage = classifyGap(observation({ evidence: [evidence(13)] }), { gaps: [addedText] })!;
    expect(first.stalledAttempts).toBe(1);
    expect(addedText.stalledAttempts).toBe(0); expect(addedText.newLocatorKeys).toEqual([]);
    expect(addedText.newEvidenceHashes).toHaveLength(1);
    expect(addedPage.stalledAttempts).toBe(0); expect(addedPage.newLocatorKeys).toHaveLength(1);
  });

  it('bounds total repair even when every retrieval returns another irrelevant page', () => {
    const gap = series(Array.from({ length: gapPolicyLimits.maxRetrievalAttempts }, (_, i) => observation({ evidence: [evidence(i + 1)] })));
    expect(gap).toMatchObject({ status: 'partial', stalledAttempts: 0, stopReason: 'attempt_limit' });
    expect(repairAction(gap, ampleBudget).maxAttempts).toBe(0);
  });

  it('keeps evidence local to each target node and does not borrow another question’s progress', () => {
    const cash = classifyGap(observation({ evidence: [evidence(12)] }))!;
    const risk = classifyGap(observation({ targetNodeId: 'risks-retrieve', questionId: 'risks', evidence: [evidence(12)] }), { gaps: [cash] })!;
    expect(risk.id).not.toBe(cash.id); expect(risk.newLocatorKeys).toHaveLength(1);
    expect(classifyGap(observation({ query: '再次查找', evidence: [evidence(12)] }), { gaps: [cash, risk] })!.stalledAttempts).toBe(1);
  });
});

describe('not_disclosed needs a scoped trusted confirmation', () => {
  it('accepts a human confirmation bound to the exact question and both original periods', () => {
    const gap = classifyGap(notDisclosed())!;
    expect(gap).toMatchObject({ type: 'not_disclosed', status: 'not_disclosed', stopReason: 'confirmed_not_disclosed' });
    expect(gap.notDisclosedConfirmation?.receiptSha256).toBe(hash('可信应用确认回执'));
  });

  it('stops further searching after confirmed non-disclosure while preserving the gap in delivery', () => {
    const gap = classifyGap(notDisclosed())!;
    expect(repairAction(gap, ampleBudget)).toEqual({ action: 'finalize_partial', targetNodeId: gap.targetNodeId,
      maxAttempts: 0, stopWhen: ['confirmed_not_disclosed'] });
  });

  it('accepts complete, reviewed original-scope confirmation without inferring it from search failure', () => {
    const gap = classifyGap(notDisclosed({ notDisclosedConfirmation: confirmation('original_scope') }))!;
    expect(gap.type).toBe('not_disclosed'); expect(gap.status).toBe('not_disclosed');
  });

  it('keeps a bare model/tool non-disclosure assertion as retrieval_miss through the stopping limit', () => {
    const gap = series(Array.from({ length: 4 }, () => notDisclosed({ notDisclosedConfirmation: undefined })));
    expect(gap).toMatchObject({ type: 'retrieval_miss', status: 'partial', notDisclosedConfirmation: null });
  });

  it.each([
    { complete: false }, { truncated: true }, { failedPages: 1 }, { quality: 'needs_review' as const },
  ])('rejects incomplete or unchecked automatic original coverage: %o', change => {
    const receipt = confirmation('original_scope'); receipt.originals[0] = { ...receipt.originals[0], ...change };
    expect(classifyGap(notDisclosed({ notDisclosedConfirmation: receipt }))!.type).toBe('retrieval_miss');
  });

  it.each(['question', 'node', 'period', 'missing_original'] as const)('rejects confirmation for a different or insufficient %s scope', mismatch => {
    const receipt = confirmation();
    if (mismatch === 'question') receipt.question += '另一问题';
    if (mismatch === 'node') receipt.targetNodeId = 'risks-retrieve';
    if (mismatch === 'period') receipt.periodIds[0] = 'FY2022';
    if (mismatch === 'missing_original') receipt.originals[0].periodId = 'FY2024';
    expect(classifyGap(notDisclosed({ notDisclosedConfirmation: receipt }))!.type).toBe('retrieval_miss');
  });
});

describe('conflicts, transient failures and unverified claims', () => {
  it('targets period/unit inspection instead of accepting a conflicting amount', () => {
    const gap = classifyGap(observation({ kind: 'period_unit_conflict', targetNodeId: 'cash_flow-compare',
      reason: '两期列头和单位尚未核实', evidence: [evidence(12)] }))!;
    expect(repairAction(gap, ampleBudget)).toMatchObject({ action: 'inspect_period_unit', targetNodeId: 'cash_flow-compare', maxAttempts: 2 });
  });

  it('keeps unresolved conflict partial after bounded inspection, even if more pages were read', () => {
    const gap = series([1, 2, 3].map(page => observation({ kind: 'period_unit_conflict', evidence: [evidence(page)] })));
    expect(gap).toMatchObject({ type: 'period_unit_conflict', status: 'partial', stopReason: 'attempt_limit' });
    expect(repairAction(gap, ampleBudget)).toMatchObject({ action: 'finalize_partial', maxAttempts: 0 });
  });

  it('allows two retries after a first transient timeout and keeps its target tool', () => {
    const gap = classifyGap(observation({ kind: 'tool_transient', tool: 'read_evidence', retryable: true }))!;
    expect(gap.tool).toBe('read_evidence');
    expect(repairAction(gap, ampleBudget)).toMatchObject({ action: 'retry_tool', maxAttempts: 2 });
  });

  it('stops repeated transient failure after three total attempts without resetting on changed arguments', () => {
    const gap = series(['一', '二', '三'].map(query => observation({ kind: 'tool_transient', query })));
    expect(gap).toMatchObject({ status: 'partial', attempts: 3, stopReason: 'attempt_limit' });
    expect(repairAction(gap, ampleBudget)).toMatchObject({ action: 'finalize_partial', maxAttempts: 0 });
  });

  it('does not retry a tool failure declared non-retryable by the trusted tool adapter', () => {
    const gap = classifyGap(observation({ kind: 'tool_transient', retryable: false }))!;
    expect(gap.stopReason).toBe('non_retryable');
    expect(repairAction(gap, ampleBudget)).toMatchObject({ action: 'finalize_partial', maxAttempts: 0 });
  });

  it('directs an unverified saved claim to verification of its own node and subject', () => {
    const gap = classifyGap(observation({ kind: 'unverified_claim', targetNodeId: 'cash_flow-verify', subjectId: 'cash-claim' }))!;
    expect(gap.subjectId).toBe('cash-claim');
    expect(repairAction(gap, ampleBudget)).toMatchObject({ action: 'verify_claim', targetNodeId: 'cash_flow-verify', maxAttempts: 2 });
  });

  it('does not loop indefinitely on insufficient semantic reviews despite fresh citations', () => {
    const gap = series([1, 2, 3].map(page => observation({ kind: 'unverified_claim', subjectId: 'cash-claim', evidence: [evidence(page)] })));
    expect(gap).toMatchObject({ type: 'unverified_claim', status: 'partial', stalledAttempts: 0 });
    expect(repairAction(gap, ampleBudget)).toMatchObject({ action: 'finalize_partial', maxAttempts: 0 });
  });
});

describe('budget exhaustion only permits verification and closure', () => {
  it('routes an explicit research-budget gap to closure even when ledger calls remain', () => {
    const gap = classifyGap(observation({ kind: 'budget_exhausted' }))!;
    expect(gap).toMatchObject({ type: 'budget_exhausted', status: 'partial' });
    expect(repairAction(gap, { remaining: 2, reserve: 2 })).toMatchObject({ action: 'verify_and_finalize', maxAttempts: 2 });
  });

  it('stops all repair and tool work when the parent ledger has zero calls left', () => {
    const gap = classifyGap(observation({ kind: 'budget_exhausted' }))!;
    expect(repairAction(gap, { remaining: 0, reserve: 4 })).toMatchObject({ action: 'stop', maxAttempts: 0, stopWhen: ['budget_exhausted'] });
  });

  it.each(['retrieval_miss', 'period_unit_conflict', 'tool_transient', 'unverified_claim'] as const)(
    'does not spend closure reserve on %s repair', kind => {
      const gap = classifyGap(observation({ kind }))!;
      expect(repairAction(gap, { remaining: 3, reserve: 4 })).toMatchObject({ action: 'verify_and_finalize', maxAttempts: 3 });
    });

  it('clips repair attempts to the global unreserved remainder', () => {
    const gap = classifyGap(observation())!;
    expect(repairAction(gap, { remaining: 6, reserve: 4 }).maxAttempts).toBe(2);
  });

  it('stops on an elapsed deadline even when the counter still has calls', () => {
    const gap = classifyGap(observation())!;
    expect(repairAction(gap, { ...ampleBudget, deadlineExceeded: true })).toMatchObject({ action: 'stop', maxAttempts: 0, stopWhen: ['deadline_exceeded'] });
  });
});

describe('bounded checkpoint state and pure updates', () => {
  it('retains stagnation across JSON serialization and does not mutate prior state', () => {
    const prior = series(['首次', '改写一', '改写二'].map(query => observation({ query })));
    const saved = JSON.stringify({ gaps: [prior] }), restored = gapPolicyStateSchema.parse(JSON.parse(saved));
    const next = classifyGap(observation({ query: '恢复后再改写' }), restored)!;
    const updated = updateGap(restored.gaps, next);
    expect(JSON.stringify(restored)).toBe(saved); expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ status: 'partial', attempts: 4, stalledAttempts: 4 });
  });

  it('stops safely at the evidence-history bound rather than forgetting old evidence and reopening repair', () => {
    const gap = series(Array.from({ length: 5 }, (_, round) => observation({ evidence: Array.from({ length: 64 }, (_, i) =>
      evidence(round * 64 + i + 1, `段落${round * 64 + i + 1}`)) })));
    expect(gap.status).toBe('partial'); expect(gap.stopReason).toBe('evidence_limit');
    expect(gap.seenLocatorKeys).toHaveLength(gapPolicyLimits.maxSeenEvidence);
    expect(gap.seenEvidenceHashes).toHaveLength(gapPolicyLimits.maxSeenEvidence);
    expect(repairAction(gap, ampleBudget).maxAttempts).toBe(0);
  });

  it('rejects capacity overflow instead of silently dropping another target’s retry history', () => {
    const gaps = Array.from({ length: gapPolicyLimits.maxGaps }, (_, i) => classifyGap(observation({ targetNodeId: `node-${i}` }))!);
    expect(() => updateGap(gaps, classifyGap(observation({ targetNodeId: 'new-node' }))!)).toThrow('capacity');
    expect(gaps).toHaveLength(gapPolicyLimits.maxGaps);
  });

  it('reports an explicitly resolved target without manufacturing another gap', () => {
    expect(classifyGap(observation({ kind: 'resolved' }))).toBeNull();
  });
});
