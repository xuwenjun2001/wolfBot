import { describe, expect, it } from 'vitest';
import { attributeResearchTask, classifyResearchFailure, normalizeResearchQuery, parseResearchJsonl, parseResearchToolCalls,
  renderResearchAttributionMarkdown, researchFailureCategories, researchQuerySimilarity, summarizeResearchAttribution,
  type QuestionFailureSignals, type ResearchAttributionInput } from './research-failure-attribution';

type Action = { name: string; args?: Record<string, unknown>; data?: Record<string, unknown>; ok?: boolean; error?: Record<string, unknown> };
function trace(actions: Action[]) {
  return actions.flatMap((action, index) => {
    const toolCall = { id: `call-${index}`, name: action.name, arguments: JSON.stringify(action.args ?? {}) };
    const result = action.ok === false ? { ok: false, error: action.error ?? { code: 'TOOL_ERROR' } } : { ok: true, data: action.data ?? {} };
    return [{ type: 'tool_calls', data: [toolCall] }, { type: 'tool_result', data: { toolCall, result, durationMs: 10 } },
      { type: 'tool_feedback', data: [{ content: JSON.stringify(result) }] }];
  }).map(row => JSON.stringify(row)).join('\n');
}
const questionIds = ['income_profit', 'cash_flow', 'risks'];
const citation = (page: number) => ({ documentId: 'public-document', documentVersion: 1, locator: { kind: 'page', filePage: page }, quote: 'PRIVATE_SOURCE_TEXT' });
const facts = ['FY2023', 'FY2024'].flatMap(period => ['revenue', 'parent_net_profit', 'operating_cash_flow'].map(metric => ({ id: `${period}-${metric}`, metric, period: { id: period }, value: { status: 'known' }, citations: [citation(metric === 'operating_cash_flow' ? 3 : 1)] })));
function input(overrides: Partial<ResearchAttributionInput> = {}): ResearchAttributionInput {
  return { campaign: 'test-campaign', phase: 'baseline', caseId: 'dev-000001', visibility: 'development',
    task: { id: 'task-1', status: 'completed', spec: { questions: questionIds.map(id => ({ id })), periods: [{ id: 'FY2023' }, { id: 'FY2024' }], budget: { maxToolCalls: 40 } },
      report: { facts, claims: questionIds.map((questionId, index) => ({ id: `${questionId}-claim`, questionId, status: 'supported', text: 'PRIVATE_ANSWER_TEXT', citations: [citation(index + 1)] })) }, checkpoint: {} },
    result: { taskId: 'task-1', status: 'completed', score: { questions: questionIds.map(questionId => ({ questionId, completed: true })) } }, toolsText: '', observationsText: '', ...overrides };
}
function failQuestion(questionId: string, claim: Record<string, unknown>, toolsText = '', extras: Partial<ResearchAttributionInput> = {}) {
  const base = input(), task = base.task as { report: { facts: unknown[]; claims: Record<string, unknown>[] } };
  return input({ ...base, task: { ...task, status: 'partial', report: { ...task.report, claims: task.report.claims.map(c => c.questionId === questionId ? { ...c, ...claim } : c) } },
    result: { taskId: 'task-1', status: 'partial', score: { questions: questionIds.map(id => ({ questionId: id, completed: id !== questionId })) } }, toolsText, ...extras });
}
const emptySignals = (): QuestionFailureSignals => ({ reviewedNotDisclosed: [], contextLoss: [], unresolvedToolErrors: [], verificationPending: [], retrievalInsufficient: [], budgetExhausted: [] });

describe('historical research trace parsing', () => {
  it('counts a tool once, ignores feedback, accepts result-only records, and preserves source lines', () => {
    const text = '\uFEFF\n' + trace([{ name: 'search_evidence', args: { query: 'x' }, data: { hits: [] } }]);
    const result = parseResearchToolCalls(text);
    expect(result.issues).toEqual([]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ ordinal: 1, line: 2, resultLine: 3, args: { query: 'x' }, result: { ok: true } });
    const only = text.split('\n').filter(row => row.includes('"type":"tool_result"')).join('\n');
    expect(parseResearchToolCalls(only).calls).toHaveLength(1);
  });
  it('reports malformed lines, arguments and duplicate/conflicting IDs without echoing private input', () => {
    const rows = parseResearchJsonl('PRIVATE_SECRET\n[]\nnull\n{"event":"ok"}\n', 'observations.jsonl');
    expect(rows.rows).toHaveLength(1);
    expect(rows.issues.map(issue => issue.code)).toEqual(['INVALID_JSON', 'ROW_NOT_OBJECT', 'ROW_NOT_OBJECT']);
    expect(JSON.stringify(rows.issues)).not.toContain('PRIVATE_SECRET');
    const raw = [
      { type: 'tool_calls', data: [{ id: 'x', name: 'record_fact', arguments: '{PRIVATE_SECRET' }] },
      { type: 'tool_result', data: { toolCall: { id: 'x', name: 'read_evidence', arguments: '{}' }, result: { ok: true } } },
      { type: 'tool_result', data: { toolCall: { id: 'x', name: 'read_evidence', arguments: '{}' }, result: { ok: true } } },
    ].map(row => JSON.stringify(row)).join('\n');
    const parsed = parseResearchToolCalls(raw);
    expect(parsed.issues.map(issue => issue.code)).toContain('INVALID_TOOL_ARGUMENTS');
    expect(parsed.issues.map(issue => issue.code)).toContain('CONFLICTING_CALL_ID');
    expect(parsed.issues.map(issue => issue.code)).toContain('DUPLICATE_TOOL_RESULT');
    expect(parsed.calls).toHaveLength(1);
    expect(JSON.stringify(parsed.issues)).not.toContain('PRIVATE_SECRET');
  });
  it('does not silently reconcile missing results or a truncated ledger', () => {
    const value = attributeResearchTask(input({ toolsText: JSON.stringify({ type: 'tool_calls', data: [{ id: 'pending', name: 'search_evidence', arguments: '{}' }] }),
      result: { status: 'partial', usage: { toolCalls: 5 } }, missingInputs: ['observations.jsonl'] }));
    expect(value.trace).toMatchObject({ completeness: 'partial', missingResults: 1, reconciled: false });
    expect(value.reportedToolCalls).toBe(5);
    expect(value.observedToolCalls).toBe(1);
  });
  it('flags task/result identity mismatch', () => {
    expect(attributeResearchTask(input({ result: { taskId: 'another-task' } })).trace.issues).toContainEqual({ file: 'task.json', line: 0, code: 'TASK_ID_MISMATCH' });
  });
});

describe('research call allocation and repetition', () => {
  it('links metric/claim/citation calls, allocates shared pages once, and separates global calls', () => {
    const value = attributeResearchTask(input({ toolsText: trace([
      { name: 'record_fact', args: { metric: 'operating_cash_flow' } },
      { name: 'verify_claim', args: { claimId: 'risks-claim' } },
      { name: 'search_evidence', args: { fields: ['revenue', 'cash_flow'], query: '营业收入 现金流' }, data: { hits: [] } },
      { name: 'check_coverage' },
    ]) }));
    expect(value.distribution.buckets).toMatchObject({ cash_flow: { calls: 1 }, risks: { calls: 1 }, 'cash_flow+income_profit': { calls: 1 }, global: { calls: 1 } });
    expect(value.distribution.perQuestion.cash_flow.allocatedCalls).toBe(1.5);
    expect(value.distribution.perQuestion.income_profit.allocatedCalls).toBe(.5);
    expect(value.calls[1]).toMatchObject({ questionIds: ['risks'], basis: 'claimId_questionId' });
    expect(value.observedToolCalls).toBe(4);
  });
  it('allocates a shared cash-flow/risk search equally when the tool uses the singular risk field', () => {
    const value = attributeResearchTask(input({ toolsText: trace([
      { name: 'search_evidence', args: { fields: ['cash_flow', 'risk'], query: '经营活动现金流量净额 可能面对的风险' }, data: { hits: [] } },
    ]) }));
    expect(value.calls[0]).toMatchObject({ questionIds: ['cash_flow', 'risks'], basis: 'retrieval_fields' });
    expect(value.queries[0].questionIds).toEqual(['cash_flow', 'risks']);
    expect(value.distribution.buckets['cash_flow+risks']).toEqual({ calls: 1, tools: { search_evidence: 1 } });
    expect(value.distribution.perQuestion.cash_flow.allocatedCalls).toBe(.5);
    expect(value.distribution.perQuestion.risks.allocatedCalls).toBe(.5);
    expect(value.distribution.perQuestion.income_profit.allocatedCalls).toBe(0);
    expect(value.observedToolCalls).toBe(1);
  });
  it('uses citation locators to expose returns and re-reads, while offsets distinguish continuation', () => {
    const read = (page: number, offset = 0): Action => ({ name: 'read_evidence', args: { documentId: 'public-document', documentVersion: 1, locator: { kind: 'page', filePage: page }, offset },
      data: { sourceId: 'public-document', documentVersion: 1, locator: { kind: 'page', filePage: page }, offset, text: `page-${page}-${offset}` } });
    // Page 2 is cash_flow, page 3 is shared risk/cash-flow due to financial fact citations.
    const value = attributeResearchTask(input({ toolsText: trace([read(1), read(2), read(1)]) }));
    expect(value.switches).toMatchObject({ count: 2, returnVisits: 1, repeatedReadsAfterReturn: 1 });
    expect(value.switches.repeats[0]).toMatchObject({ ordinal: 3, previousOrdinal: 1, questionId: 'income_profit' });
    expect(attributeResearchTask(input({ toolsText: trace([read(1), read(2), read(1, 100)]) })).switches.repeatedReadsAfterReturn).toBe(0);
  });
  it('counts repeated located content among successful retrievals and excludes failures/unknown output from that denominator', () => {
    const search: Action = { name: 'search_evidence', args: { query: '现金流变动原因', fields: ['cash_flow'] }, data: { hits: [{ sourceId: 'd', documentVersion: 1, locator: { kind: 'block', filePage: 10, blockId: 'b' }, snippet: 'same content' }] } };
    const value = attributeResearchTask(input({ toolsText: trace([search, search, { ...search, ok: false }, { ...search, data: {} }]) }));
    expect(value.retrieval).toMatchObject({ calls: 4, successful: 2, noNewEvidence: 1, noNewEvidenceRate: .5, failed: 1, unobservable: 1 });
    expect(value.calls[1].evidence).toEqual({ units: 1, newUnits: 0 });
  });
  it('keeps a changed content/version fingerprint and an expanded read as new evidence', () => {
    const read = (text: string, version = 1): Action => ({ name: 'read_evidence', args: { documentId: 'd', locator: { kind: 'page', filePage: 1 } }, data: { sourceId: 'd', documentVersion: version, locator: { kind: 'page', filePage: 1 }, text } });
    expect(attributeResearchTask(input({ toolsText: trace([read('short'), read('short expanded'), read('short', 2)]) })).retrieval.noNewEvidence).toBe(0);
  });
  it('normalizes literal repeats and counts each similar query once with filter changes visible', () => {
    expect(normalizeResearchQuery('ＡＢＣ， 现金流！')).toBe('abc现金流');
    expect(researchQuerySimilarity('经营活动现金流量净额变动原因', '经营活动现金流量净额变动原因说明')).toBeGreaterThanOrEqual(.85);
    const value = attributeResearchTask(input({ toolsText: trace([
      { name: 'search_evidence', args: { query: '经营活动现金流量净额变动原因', periodIds: ['FY2023'] }, data: { hits: [] } },
      { name: 'search_evidence', args: { query: '经营活动现金流量净额变动原因！', periodIds: ['FY2024'] }, data: { hits: [] } },
      { name: 'search_evidence', args: { query: '经营活动现金流量净额变动原因说明', periodIds: ['FY2024'] }, data: { hits: [] } },
    ]) }));
    expect(value.queryRepeats).toHaveLength(2);
    expect(value.queryRepeats[0]).toMatchObject({ kind: 'exact', sameScope: false });
    expect(value.queryRepeats[1]).toMatchObject({ kind: 'similar' });
    expect(value.queries[0]).toMatchObject({ questionIds: ['cash_flow'], periodIds: ['FY2023'] });
  });
  it('detects identical state writes and repeated verification of an unchanged claim hash', () => {
    const write: Action = { name: 'record_claim', args: { id: 'risks-claim', questionId: 'risks', text: 'same' } };
    const verify: Action = { name: 'verify_claim', args: { claimId: 'risks-claim' }, data: { claimHash: 'same-hash', verdict: 'supported' } };
    const value = attributeResearchTask(input({ toolsText: trace([write, write, verify, verify]) }));
    expect(value.identicalClaimWrites).toBe(1);
    expect(value.repeatedVerifications).toBe(1);
  });
});

describe('observable failure attribution', () => {
  it.each([
    ['reviewedNotDisclosed', 'not_disclosed'], ['contextLoss', 'context_loss'], ['unresolvedToolErrors', 'tool_error'],
    ['verificationPending', 'verification_pending'], ['retrievalInsufficient', 'retrieval_miss'], ['budgetExhausted', 'budget_exhausted'],
  ] as const)('supports the %s category with explicit evidence', (key, category) => {
    const signals = emptySignals(); signals[key] = [{ code: 'OBSERVED', refs: ['tools.jsonl:2'], detail: 'observable' }];
    expect(classifyResearchFailure(signals)).toMatchObject({ category, confidence: 'observed_bottleneck' });
  });
  it('uses a limited planning fallback instead of inventing a mechanism', () => {
    expect(classifyResearchFailure(emptySignals())).toMatchObject({ category: 'planning', confidence: 'limited' });
  });
  it('does not promote a model claim of non-disclosure or an unsuccessful search into not_disclosed', () => {
    const value = attributeResearchTask(failQuestion('cash_flow', { status: 'evidence_gap', reason: '未找到，原文未披露原因' }, trace([
      { name: 'search_evidence', args: { fields: ['cash_flow'], query: '原因' }, data: { hits: [] } },
      { name: 'verify_claim', args: { claimId: 'cash_flow-claim' }, data: { verdict: 'insufficient' } },
    ])));
    expect(value.questions.find(q => q.questionId === 'cash_flow')?.attribution?.category).toBe('retrieval_miss');
    expect(attributeResearchTask(failQuestion('cash_flow', { status: 'evidence_gap' }, '', { disclosureAssessments: [{ questionId: 'cash_flow', verdict: 'not_disclosed', authority: 'human_reviewed_full_documents', evidenceRefs: ['authorized-review.json#/cash-flow'] }] })).questions.find(q => q.questionId === 'cash_flow')?.attribution?.category).toBe('not_disclosed');
  });
  it('does not call an unvisited missing-number question a retrieval miss merely because a shared summary was read', () => {
    const base = failQuestion('cash_flow', { status: 'evidence_gap' }, trace([{ name: 'search_evidence', args: { fields: ['revenue', 'cash_flow'], query: '主要数据' }, data: { hits: [] } }]));
    const task = base.task as { report: { facts: typeof facts; claims: unknown[] } };
    const value = attributeResearchTask({ ...base, task: { ...task, usage: { toolCalls: 40 }, report: { ...task.report, facts: facts.filter(fact => fact.metric !== 'operating_cash_flow') } } });
    expect(value.questions.find(q => q.questionId === 'cash_flow')?.attribution?.category).toBe('budget_exhausted');
  });
  it('preserves pending verification as primary even when the original quota is at its limit', () => {
    const base = failQuestion('risks', { status: 'evidence_gap', reason: '尚未完成独立语义核验' });
    const task = base.task as Record<string, unknown>;
    const value = attributeResearchTask({ ...base, task: { ...task, usage: { toolCalls: 40 }, plan: { steps: [{ id: 'risks-verify', questionId: 'risks', kind: 'verify' }, { id: 'risks-report', questionId: 'risks', kind: 'report' }] },
      checkpoint: { steps: { 'risks-verify': 'pending', 'risks-report': 'completed' }, submitted: true } } });
    const failure = value.questions.find(q => q.questionId === 'risks')?.attribution;
    expect(failure?.category).toBe('verification_pending');
    expect(failure?.contributingSignals.map(signal => signal.category)).toContain('budget_exhausted');
    expect(value.budget).toMatchObject({ atToolLimit: true, exhaustedWithUnfinished: true });
    expect(value.budget.unfinishedSteps).toContainEqual({ id: 'risks-verify', questionId: 'risks', kind: 'verify', status: 'pending' });
    expect(value.budget.unfinishedSteps.find(step => step.id === 'risks-report')).toBeUndefined();
  });
  it('attributes unresolved numeric rejections to tools and does not blame recovered errors', () => {
    const bad = trace([{ name: 'record_fact', args: { metric: 'revenue', periodId: 'FY2024' }, ok: false, error: { code: 'TOOL_ERROR', message: 'PRIVATE_ERROR: FACT_UNIT_UNVERIFIED' } }]);
    const base = failQuestion('income_profit', { status: 'evidence_gap' }, bad), task = base.task as { report: { facts: typeof facts; claims: unknown[] } };
    const value = attributeResearchTask({ ...base, task: { ...task, report: { ...task.report, facts: facts.filter(fact => fact.id !== 'FY2024-revenue') } } });
    expect(value.questions.find(q => q.questionId === 'income_profit')?.attribution?.category).toBe('tool_error');
    expect(value.calls[0].errorCodes).toContain('FACT_UNIT_UNVERIFIED');
    expect(attributeResearchTask(input({ toolsText: bad })).questions.every(q => q.attribution === null)).toBe(true);
    expect(JSON.stringify(value.questions)).not.toContain('PRIVATE_ERROR');
    const recoveredPeriod = trace([{ name: 'record_fact', args: { metric: 'revenue', periodId: 'FY2023' }, ok: false }]);
    const otherPeriodMissing = attributeResearchTask({ ...base, toolsText: recoveredPeriod, task: { ...task, report: { ...task.report, facts: facts.filter(fact => fact.id !== 'FY2024-revenue') } } });
    expect(otherPeriodMissing.questions.find(q => q.questionId === 'income_profit')?.attribution?.category).not.toBe('tool_error');
  });
  it('reports compact as unobservable despite large usage and only accepts directly recorded loss', () => {
    const value = attributeResearchTask(input({ result: { usage: { inputTokens: 9999999 } }, observationsText: JSON.stringify({ event: 'model.finished', inputTokens: 9999999 }) }));
    expect(value.compact).toEqual({ observability: 'unobservable', count: null, countBasis: null, refs: [] });
    const compact = attributeResearchTask(input({ observationsText: [{ event: 'context.compact.triggered' }, { event: 'context.compacted' }].map(row => JSON.stringify(row)).join('\n') }));
    expect(compact.compact).toMatchObject({ observability: 'observed_events_only', count: 1, countBasis: 'trigger_events' });
    const failed = attributeResearchTask(failQuestion('risks', { status: 'evidence_gap' }, '', { observationsText: JSON.stringify({ event: 'context.evidence_lost', source: 'context_manager', previouslyAvailable: true, evidenceKey: 'public-key', questionId: 'risks' }) }));
    expect(summarizeResearchAttribution([failed]).contextContention.supported).toBe(true);
    expect(summarizeResearchAttribution([value]).contextContention.supported).toBe(false);
  });
  it('keeps all seven classes including zero counts and never prints queries/answers/source/errors in public Markdown', () => {
    const value = attributeResearchTask(failQuestion('cash_flow', { status: 'evidence_gap', reason: 'PRIVATE_REASON' }, trace([
      { name: 'search_evidence', args: { query: 'PRIVATE_QUERY', fields: ['cash_flow'] }, data: { hits: [] } },
    ]), { visibility: 'consumed_holdout', caseId: 'PRIVATE_CASE' }));
    const summary = summarizeResearchAttribution([value]), markdown = renderResearchAttributionMarkdown([value]);
    expect(Object.keys(summary.categories)).toEqual([...researchFailureCategories]);
    expect(summary).toMatchObject({ tasks: 1, failedQuestions: 1, incompleteTraces: 0, contextContention: { supported: false } });
    for (const text of ['PRIVATE_QUERY', 'PRIVATE_ANSWER_TEXT', 'PRIVATE_SOURCE_TEXT', 'PRIVATE_REASON', 'PRIVATE_CASE']) expect(markdown).not.toContain(text);
    expect(markdown).toContain('历史保留');
    expect(value.queries[0].query).toBe('PRIVATE_QUERY');
  });
});
