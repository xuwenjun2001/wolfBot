import { createHash } from 'node:crypto';

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const records = (value: unknown): JsonRecord[] => array(value).map(object);
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))].sort();
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(object(value)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export const researchFailureCategories = ['retrieval_miss', 'not_disclosed', 'budget_exhausted', 'verification_pending', 'context_loss', 'tool_error', 'planning'] as const;
export type ResearchFailureCategory = typeof researchFailureCategories[number];
export type TraceIssue = { file: string; line: number; code: string };
export type TraceRow = { line: number; value: JsonRecord };

/** Errors deliberately exclude the source line and JSON parser message, which can contain private text. */
export function parseResearchJsonl(text: string | undefined, file: 'tools.jsonl' | 'observations.jsonl') {
  const rows: TraceRow[] = [], issues: TraceIssue[] = [];
  for (const [index, raw] of (text ?? '').replace(/^\uFEFF/u, '').split(/\r?\n/u).entries()) {
    if (!raw.trim()) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) issues.push({ file, line: index + 1, code: 'ROW_NOT_OBJECT' });
      else rows.push({ line: index + 1, value: object(value) });
    } catch { issues.push({ file, line: index + 1, code: 'INVALID_JSON' }); }
  }
  return { rows, issues };
}

type ToolCall = {
  id: string; ordinal: number; name: string; line: number; resultLine: number | null;
  args: JsonRecord; result: JsonRecord | null; durationMs: number | null;
};

/** Count a call once by ID; tool_feedback is a replay of a result, not another call. */
export function parseResearchToolCalls(text: string | undefined) {
  const parsed = parseResearchJsonl(text, 'tools.jsonl'), calls: ToolCall[] = [], byId = new Map<string, ToolCall>();
  const issues = [...parsed.issues];
  function call(value: unknown, line: number): ToolCall | null {
    const raw = object(value), id = string(raw.id), name = string(raw.name);
    if (!id || !name) { issues.push({ file: 'tools.jsonl', line, code: 'INVALID_TOOL_CALL' }); return null; }
    const prior = byId.get(id);
    if (prior) {
      if (prior.name !== name || canonical(prior.args) !== canonical(argumentsObject(raw.arguments, line))) issues.push({ file: 'tools.jsonl', line, code: 'CONFLICTING_CALL_ID' });
      return prior;
    }
    const next: ToolCall = { id, name, ordinal: calls.length + 1, line, resultLine: null, args: argumentsObject(raw.arguments, line), result: null, durationMs: null };
    byId.set(id, next); calls.push(next); return next;
  }
  function argumentsObject(value: unknown, line: number): JsonRecord {
    try {
      const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return object(parsed);
    } catch { issues.push({ file: 'tools.jsonl', line, code: 'INVALID_TOOL_ARGUMENTS' }); return {}; }
  }
  for (const row of parsed.rows) {
    if (row.value.type === 'tool_calls') {
      if (!Array.isArray(row.value.data)) issues.push({ file: 'tools.jsonl', line: row.line, code: 'INVALID_CALL_BATCH' });
      else for (const raw of row.value.data) call(raw, row.line);
    } else if (row.value.type === 'tool_result') {
      const data = object(row.value.data), current = call(data.toolCall, row.line);
      if (!current) continue;
      if (current.result) { issues.push({ file: 'tools.jsonl', line: row.line, code: 'DUPLICATE_TOOL_RESULT' }); continue; }
      const result = object(data.result);
      if (typeof result.ok !== 'boolean') issues.push({ file: 'tools.jsonl', line: row.line, code: 'INVALID_TOOL_RESULT' });
      current.result = result; current.resultLine = row.line; current.durationMs = number(data.durationMs);
    }
  }
  return { calls, issues };
}

export function normalizeResearchQuery(query: string): string { return query.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ''); }
/** Character-bigram Jaccard; this diagnoses lexical repetition, not semantic equivalence. */
export function researchQuerySimilarity(left: string, right: string): number {
  const a = [...normalizeResearchQuery(left)], b = [...normalizeResearchQuery(right)];
  const grams = (chars: string[]) => new Set(chars.length < 2 ? chars : chars.slice(1).map((char, index) => chars[index] + char));
  const aa = grams(a), bb = grams(b), union = new Set([...aa, ...bb]);
  return union.size ? [...aa].filter(item => bb.has(item)).length / union.size : 0;
}

export type FailureEvidence = { code: string; refs: string[]; detail: string };
export type QuestionFailureSignals = {
  reviewedNotDisclosed: FailureEvidence[]; contextLoss: FailureEvidence[]; unresolvedToolErrors: FailureEvidence[];
  verificationPending: FailureEvidence[]; retrievalInsufficient: FailureEvidence[]; budgetExhausted: FailureEvidence[];
};
/** The primary class names an observed bottleneck. Budget and other co-occurring signals remain visible. */
export function classifyResearchFailure(signals: QuestionFailureSignals) {
  const choices: [ResearchFailureCategory, FailureEvidence[]][] = [
    ['not_disclosed', signals.reviewedNotDisclosed], ['context_loss', signals.contextLoss], ['tool_error', signals.unresolvedToolErrors],
    ['verification_pending', signals.verificationPending], ['retrieval_miss', signals.retrievalInsufficient], ['budget_exhausted', signals.budgetExhausted],
  ];
  const selected = choices.find(([, evidence]) => evidence.length);
  return { category: selected?.[0] ?? 'planning' as ResearchFailureCategory,
    evidence: selected?.[1] ?? [{ code: 'NO_OBSERVED_COMPLETION_PATH', refs: ['task.json#/checkpoint', 'result.json#/score/questions'], detail: '问题未完成，现有轨迹没有更强的可核验归因；不推断模型意图。' }],
    contributingSignals: choices.filter(([category, evidence]) => evidence.length && category !== selected?.[0]).map(([category, evidence]) => ({ category, evidence })),
    confidence: selected ? 'observed_bottleneck' as const : 'limited' as const };
}

export type ResearchAttributionInput = {
  campaign: string; phase: string; caseId: string; visibility: 'development' | 'consumed_holdout';
  task: unknown; result: unknown; toolsText?: string; observationsText?: string; missingInputs?: string[];
  /** Only separately authorized, complete-document human assessments qualify; model prose never qualifies. */
  disclosureAssessments?: { questionId: string; verdict: 'not_disclosed'; authority: 'human_reviewed_full_documents'; evidenceRefs: string[] }[];
};
export type ResearchRealQuery = {
  campaign: string; phase: string; caseId: string; taskId: string; visibility: ResearchAttributionInput['visibility'];
  callId: string; ordinal: number; line: number; query: string; fields: string[]; questionIds: string[];
  documentIds: string[]; periodIds: string[]; topK: number | null; indexVersion: string | null;
};

function metricQuestion(metric: string): string | null {
  return ['revenue', 'parent_net_profit', 'parent_profit'].includes(metric) ? 'income_profit' : ['operating_cash_flow', 'cash_flow'].includes(metric) ? 'cash_flow' : ['risk', 'risks'].includes(metric) ? 'risks' : null;
}
const questionMetrics = (id: string) => id === 'income_profit' ? ['revenue', 'parent_net_profit'] : id === 'cash_flow' ? ['operating_cash_flow'] : [];
function locatorKey(document: string, version: unknown, locator: unknown, pageOnly = false) {
  const loc = object(locator);
  return canonical([document, version ?? 1, loc.filePage ?? null, pageOnly ? null : loc.blockId ?? null, pageOnly ? null : loc.tableId ?? null, pageOnly ? null : loc.row ?? null, pageOnly ? null : loc.column ?? null]);
}
function errorCodes(call: ToolCall): string[] {
  const error = object(call.result?.error);
  return unique([string(error.code), ...string(error.message).matchAll(/\b(?:FACT|CLAIM|CITATION|EVIDENCE|TOOL|RESEARCH|SOURCE)_[A-Z_]+\b/gu)].map(value => typeof value === 'string' ? value : value[0]));
}
function evidenceUnits(call: ToolCall): string[] | null {
  if (!['search_evidence', 'read_evidence'].includes(call.name) || call.result?.ok !== true) return null;
  const data = object(call.result.data);
  function fingerprint(raw: JsonRecord, text: string, parent: JsonRecord = {}) {
    return digest(canonical([raw.sourceId ?? parent.sourceId ?? call.args.documentId, raw.documentVersion ?? parent.documentVersion ?? call.args.documentVersion ?? 1,
      raw.bytesSha256 ?? parent.bytesSha256 ?? null, raw.locator ?? call.args.locator, raw.textOffset ?? raw.offset ?? 0, text]));
  }
  if (call.name === 'read_evidence') return typeof data.text === 'string' ? data.text ? [fingerprint(data, data.text)] : [] : null;
  if (!Array.isArray(data.hits)) return null;
  return unique(records(data.hits).flatMap(hit => [typeof hit.snippet === 'string' && hit.snippet ? fingerprint(hit, hit.snippet) : '',
    ...records(hit.context).map(context => typeof context.snippet === 'string' && context.snippet ? fingerprint(context, context.snippet, hit) : '')]));
}

export function attributeResearchTask(input: ResearchAttributionInput) {
  const task = object(input.task), result = object(input.result), checkpoint = object(task.checkpoint), report = object(task.report), spec = object(task.spec);
  const claims = records(report.claims ?? checkpoint.claims), facts = records(report.facts ?? checkpoint.facts), score = object(result.score);
  const questionIds = unique([...records(spec.questions).map(q => string(q.id)), ...records(score.questions).map(q => string(q.questionId)), ...claims.map(c => string(c.questionId))]);
  const parsed = parseResearchToolCalls(input.toolsText), observations = parseResearchJsonl(input.observationsText, 'observations.jsonl');
  const calls = parsed.calls, issues = [...parsed.issues, ...observations.issues];
  const taskId = string(task.id) || string(result.taskId) || `missing:${input.campaign}/${input.phase}/${input.caseId}`;
  if (task.id && result.taskId && task.id !== result.taskId) issues.push({ file: 'task.json', line: 0, code: 'TASK_ID_MISMATCH' });
  const claimQuestions = new Map<string, string>(), citedQuestions = new Map<string, Set<string>>();
  function associate(raw: JsonRecord, qids: string[]) {
    for (const citation of records(raw.citations)) for (const pageOnly of [false, true]) {
      const key = locatorKey(string(citation.documentId), citation.documentVersion, citation.locator, pageOnly), set = citedQuestions.get(key) ?? new Set<string>();
      qids.forEach(id => set.add(id)); citedQuestions.set(key, set);
    }
  }
  for (const claim of [...claims, ...calls.filter(c => c.name === 'record_claim').map(c => c.args)]) {
    const id = string(claim.id), qid = string(claim.questionId);
    if (id && qid) claimQuestions.set(id, qid);
    if (qid) associate(claim, [qid]);
  }
  for (const fact of [...facts, ...calls.filter(c => c.name === 'record_fact').map(c => c.args)]) {
    const qid = metricQuestion(string(fact.metric)); if (qid) associate(fact, [qid]);
  }
  function infer(call: ToolCall): { questionIds: string[]; basis: string } {
    if (typeof call.args.questionId === 'string') return { questionIds: [call.args.questionId].filter(q => questionIds.includes(q)), basis: 'explicit_questionId' };
    if (call.name === 'verify_claim') return { questionIds: [claimQuestions.get(string(call.args.claimId)) ?? ''].filter(Boolean), basis: 'claimId_questionId' };
    const metric = metricQuestion(string(call.args.metric));
    if (metric) return { questionIds: [metric], basis: 'metric' };
    if (call.name === 'read_evidence') {
      const key = locatorKey(string(call.args.documentId), call.args.documentVersion, call.args.locator, object(call.args.locator).kind === 'page');
      return { questionIds: [...(citedQuestions.get(key) ?? [])].sort(), basis: 'fact_claim_citation_locator' };
    }
    if (call.name === 'search_evidence') {
      const fields = unique(array(call.args.fields).map(string).map(field => metricQuestion(field) ?? ''));
      if (fields.length) return { questionIds: fields, basis: 'retrieval_fields' };
      const query = string(call.args.query), guessed: string[] = [];
      if (/风险|risk/iu.test(query)) guessed.push('risks');
      if (/现金|cash|调节|补充资料/iu.test(query)) guessed.push('cash_flow');
      if (/营业收入|净利润|revenue|profit/iu.test(query)) guessed.push('income_profit');
      return { questionIds: unique(guessed.filter(id => questionIds.includes(id))), basis: 'query_terms_heuristic' };
    }
    return { questionIds: [], basis: ['check_coverage', 'submit_report', 'list_documents'].includes(call.name) ? 'global' : 'unassigned' };
  }
  const summaries = calls.map(call => ({ id: call.id, ordinal: call.ordinal, tool: call.name, line: call.line, resultLine: call.resultLine,
    ok: typeof call.result?.ok === 'boolean' ? call.result.ok : null, durationMs: call.durationMs, ...infer(call), errorCodes: errorCodes(call),
    evidence: null as { units: number; newUnits: number } | null }));
  const toolCounts: Record<string, number> = {}, buckets: Record<string, { calls: number; tools: Record<string, number> }> = {};
  const perQuestion = Object.fromEntries(questionIds.map(id => [id, { attributedCalls: 0, allocatedCalls: 0, allocatedDurationMs: 0, tools: {} as Record<string, number> }]));
  const seenEvidence = new Set<string>(), retrieval = { calls: 0, successful: 0, failed: 0, unobservable: 0, noNewEvidence: 0, noNewEvidenceRate: null as number | null };
  const queries: ResearchRealQuery[] = [], queryRepeats: { ordinal: number; previousOrdinal: number; kind: 'exact' | 'similar'; similarity: number; sameScope: boolean }[] = [];
  const readHistory = new Map<string, { visit: number; ordinal: number }>(), visited = new Set<string>();
  const switches = { count: 0, returnVisits: 0, repeatedReadsAfterReturn: 0, repeats: [] as { ordinal: number; previousOrdinal: number; questionId: string }[], ambiguousCalls: 0 };
  let previousQuestion: string | null = null, visit = 0, identicalClaimWrites = 0, repeatedVerifications = 0;
  const claimWrites = new Map<string, string>(), verifiedHashes = new Set<string>();
  for (const [index, call] of calls.entries()) {
    const summary = summaries[index], ids = summary.questionIds;
    toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
    const bucket = ids.join('+') || (summary.basis === 'global' ? 'global' : 'unassigned'), distribution = buckets[bucket] ?? { calls: 0, tools: {} };
    distribution.calls++; distribution.tools[call.name] = (distribution.tools[call.name] ?? 0) + 1; buckets[bucket] = distribution;
    for (const id of ids) if (perQuestion[id]) {
      const q = perQuestion[id]; q.attributedCalls++; q.allocatedCalls += 1 / ids.length; q.allocatedDurationMs += (call.durationMs ?? 0) / ids.length; q.tools[call.name] = (q.tools[call.name] ?? 0) + 1;
    }
    if (ids.length === 1) {
      const current = ids[0];
      if (current !== previousQuestion) {
        if (previousQuestion !== null) switches.count++;
        if (visited.has(current)) switches.returnVisits++;
        visited.add(current); previousQuestion = current; visit++;
      }
      if (call.name === 'read_evidence') {
        const readKey = canonical([current, call.args.documentId, call.args.documentVersion ?? 1, call.args.locator, call.args.offset ?? 0]);
        const prior = readHistory.get(readKey);
        if (prior && prior.visit < visit) { switches.repeatedReadsAfterReturn++; switches.repeats.push({ ordinal: call.ordinal, previousOrdinal: prior.ordinal, questionId: current }); }
        readHistory.set(readKey, { visit, ordinal: call.ordinal });
      }
    } else switches.ambiguousCalls++;
    const units = evidenceUnits(call);
    if (['search_evidence', 'read_evidence'].includes(call.name)) {
      retrieval.calls++;
      if (call.result?.ok === false) retrieval.failed++;
      else if (units === null) retrieval.unobservable++;
      else {
        retrieval.successful++; const added = units.filter(key => !seenEvidence.has(key));
        if (!added.length) retrieval.noNewEvidence++;
        units.forEach(key => seenEvidence.add(key)); summary.evidence = { units: units.length, newUnits: added.length };
      }
    }
    if (call.name === 'search_evidence' && typeof call.args.query === 'string') {
      const query: ResearchRealQuery = { campaign: input.campaign, phase: input.phase, caseId: input.caseId, taskId, visibility: input.visibility,
        callId: call.id, ordinal: call.ordinal, line: call.line, query: call.args.query, fields: array(call.args.fields).map(string), questionIds: ids,
        documentIds: array(call.args.documentIds).map(string), periodIds: array(call.args.periodIds).map(string), topK: number(call.args.topK), indexVersion: string(object(call.result?.data).indexVersion) || null };
      const prior = queries.map(q => ({ query: q, similarity: researchQuerySimilarity(q.query, query.query) })).sort((a, b) => b.similarity - a.similarity || b.query.ordinal - a.query.ordinal)[0];
      if (prior && prior.similarity >= .85) queryRepeats.push({ ordinal: query.ordinal, previousOrdinal: prior.query.ordinal,
        kind: normalizeResearchQuery(prior.query.query) === normalizeResearchQuery(query.query) ? 'exact' : 'similar', similarity: prior.similarity,
        sameScope: canonical([prior.query.fields, prior.query.documentIds, prior.query.periodIds]) === canonical([query.fields, query.documentIds, query.periodIds]) });
      queries.push(query);
    }
    if (call.name === 'record_claim' && call.result?.ok === true) {
      const key = string(call.args.id), hash = digest(canonical(call.args));
      if (claimWrites.get(key) === hash) identicalClaimWrites++;
      claimWrites.set(key, hash);
    }
    if (call.name === 'verify_claim' && call.result?.ok === true) {
      const hash = string(object(call.result.data).claimHash);
      if (hash && verifiedHashes.has(hash)) repeatedVerifications++;
      if (hash) verifiedHashes.add(hash);
    }
  }
  retrieval.noNewEvidenceRate = retrieval.successful ? retrieval.noNewEvidence / retrieval.successful : null;
  const usage = object(result.usage ?? task.usage), maxToolCalls = number(object(spec.budget).maxToolCalls), reportedToolCalls = number(usage.toolCalls);
  const stop = string(checkpoint.stopReason), explicitBudgetStop = /预算|截止时间|budget|deadline|timeout/iu.test(stop);
  const atToolLimit = maxToolCalls !== null && (reportedToolCalls ?? calls.length) >= maxToolCalls;
  const missingInputs = unique([...(input.missingInputs ?? []), ...(input.toolsText === undefined ? ['tools.jsonl'] : []), ...(input.observationsText === undefined ? ['observations.jsonl'] : [])]);
  const scoredQuestions = records(score.questions);
  const questions = questionIds.map(questionId => {
    const selected = claims.filter(claim => claim.questionId === questionId), metrics = questionMetrics(questionId);
    const missingMetrics = metrics.filter(metric => records(spec.periods).some(period => !facts.some(fact => fact.metric === metric && object(fact.period).id === period.id && object(fact.value).status === 'known')));
    const scored = scoredQuestions.find(q => q.questionId === questionId);
    const failedNumbers = [...records(score.facts), ...records(score.changes)].filter(fact => metrics.includes(string(fact.metric)) && fact.passed === false).map(fact => string(fact.metric));
    const completed = typeof scored?.completed === 'boolean' ? scored.completed : selected.length > 0 && selected.every(claim => claim.status === 'supported') && !missingMetrics.length && !records(result.hardErrors).length;
    const related = calls.filter((_, index) => summaries[index].questionIds.includes(questionId));
    const evidence = (code: string, refs: string[], detail: string): FailureEvidence => ({ code, refs, detail });
    const failingSaves = related.filter(call => call.result?.ok === false && (call.name === 'record_fact' && missingMetrics.includes(string(call.args.metric)) && !facts.some(fact => fact.metric === call.args.metric && object(fact.period).id === call.args.periodId && object(fact.value).status === 'known') || call.name === 'record_claim' && !selected.length));
    const pending = selected.filter(claim => /尚未完成|未完成.*核验|待.*核验|pending/iu.test(string(claim.reason)));
    const lastChecks = selected.flatMap(claim => {
      const checks = related.filter(call => call.name === 'verify_claim' && call.args.claimId === claim.id && call.result?.ok === true);
      return checks.length ? [checks[checks.length - 1]] : [];
    });
    const insufficient = lastChecks.filter(call => ['insufficient', 'contradicted'].includes(string(object(call.result?.data).verdict)));
    const signals: QuestionFailureSignals = {
      reviewedNotDisclosed: (input.disclosureAssessments ?? []).filter(a => a.questionId === questionId && a.verdict === 'not_disclosed' && a.authority === 'human_reviewed_full_documents' && a.evidenceRefs.length > 0).map(a => evidence('HUMAN_COMPLETE_DOCUMENT_NONDISCLOSURE', a.evidenceRefs, '独立的完整文档人工核查明确确认该项未披露。')),
      contextLoss: observations.rows.filter(row => row.value.event === 'context.evidence_lost' && row.value.questionId === questionId && row.value.previouslyAvailable === true && row.value.source === 'context_manager' && typeof row.value.evidenceKey === 'string').map(row => evidence('EXPLICIT_CONTEXT_EVIDENCE_LOSS', [`observations.jsonl:${row.line}`], '上下文管理器直接记录此前可用证据被遗失；不由重读推断。')),
      unresolvedToolErrors: failingSaves.map(call => evidence('UNRESOLVED_REQUIRED_SAVE_REJECTED', [`tools.jsonl:${call.resultLine}`, 'task.json#/report/facts'], `必需事实或结论仍缺失，相关保存调用被拒绝；错误代码 ${errorCodes(call).join(',') || 'unknown'}。`)),
      verificationPending: pending.length ? [evidence('FINAL_CLAIM_VERIFICATION_PENDING', ['task.json#/report/claims', ...related.filter(call => call.name === 'record_claim' || call.name === 'verify_claim').map(call => `tools.jsonl:${call.resultLine ?? call.line}`)], '终态明确保留独立语义核验未完成；保存结论不等于完成核验。')] : [],
      retrievalInsufficient: insufficient.length || !missingMetrics.length && selected.some(claim => claim.status === 'evidence_gap') && !pending.length && related.some(call => ['search_evidence', 'read_evidence'].includes(call.name)) ? [evidence('RETRIEVED_EVIDENCE_INSUFFICIENT', ['task.json#/report/claims', ...insufficient.map(call => `tools.jsonl:${call.resultLine}`)], '已取得的证据不足以支持完整问题；无法据此确认整份原文未披露，也不能证明金标页必然存在。')] : [],
      budgetExhausted: atToolLimit || explicitBudgetStop ? [evidence('BUDGET_LIMIT_WITH_UNFINISHED_QUESTION', ['task.json#/usage', 'task.json#/spec/budget', 'task.json#/checkpoint'], '工具额度到顶或有明确截止停止记录，问题尚未完成；这只证明预算约束同时存在。')] : [],
    };
    return { questionId, completed, completionBasis: typeof scored?.completed === 'boolean' ? 'frozen_score' : 'report_state',
      missingMetrics, failedNumericMetrics: unique(failedNumbers), claimCount: selected.length, supportedClaims: selected.filter(c => c.status === 'supported').length,
      attribution: completed ? null : classifyResearchFailure(signals) };
  });
  const planSteps = records(object(task.plan).steps), statuses = object(checkpoint.steps);
  const unfinishedSteps = planSteps.filter(step => statuses[string(step.id)] !== 'completed').map(step => ({ id: string(step.id), questionId: string(step.questionId), kind: string(step.kind), status: string(statuses[string(step.id)]) || 'not_recorded' }));
  for (const question of questions.filter(q => !q.completed)) unfinishedSteps.push({ id: `${question.questionId}:acceptance`, questionId: question.questionId, kind: 'question_acceptance', status: 'incomplete' });
  const compactTriggers = observations.rows.filter(row => ['context.compact', 'context.compact.triggered'].includes(string(row.value.event)));
  const compactEvents = compactTriggers.length ? compactTriggers : observations.rows.filter(row => row.value.event === 'context.compacted');
  const missingResults = calls.filter(call => call.result === null).length;
  const reconciled = reportedToolCalls === null ? null : reportedToolCalls === calls.length;
  return { schemaVersion: 1 as const, campaign: input.campaign, phase: input.phase, caseId: input.caseId, taskId, visibility: input.visibility,
    status: string(result.status ?? task.status) || 'unknown', questions, toolCounts, observedToolCalls: calls.length, reportedToolCalls,
    distribution: { buckets, perQuestion, method: 'Direct question/metric, claim-ID and citation-locator linkage; retrieval fields, then lexical query terms. Shared calls allocate 1/n; global calls remain separate.' },
    retrieval, queryRepeats, switches, identicalClaimWrites, repeatedVerifications,
    compact: { observability: compactEvents.length ? 'observed_events_only' as const : 'unobservable' as const, count: compactEvents.length ? compactEvents.length : null,
      countBasis: compactTriggers.length ? 'trigger_events' : compactEvents.length ? 'completion_events_only' : null, refs: compactEvents.map(row => `observations.jsonl:${row.line}`) },
    budget: { maxToolCalls, atToolLimit, explicitBudgetStop, exhaustedWithUnfinished: (atToolLimit || explicitBudgetStop) && questions.some(q => !q.completed), unfinishedSteps: atToolLimit || explicitBudgetStop ? unfinishedSteps : [] },
    trace: { missingInputs, issues, missingResults, reconciled, completeness: missingInputs.length || issues.length || missingResults || reconciled === false ? 'partial' as const : 'complete' as const },
    calls: summaries, queries };
}

export type ResearchTaskAttribution = ReturnType<typeof attributeResearchTask>;

export function summarizeResearchAttribution(tasks: ResearchTaskAttribution[]) {
  const categories = Object.fromEntries(researchFailureCategories.map(category => [category, { count: 0, tasks: [] as string[], evidenceCodes: [] as string[] }]));
  const tools: Record<string, number> = {};
  for (const task of tasks) {
    for (const [tool, count] of Object.entries(task.toolCounts)) tools[tool] = (tools[tool] ?? 0) + count;
    for (const q of task.questions) if (q.attribution) {
      const category = categories[q.attribution.category]; category.count++; category.tasks.push(task.taskId); category.evidenceCodes.push(...q.attribution.evidence.map(item => item.code));
    }
  }
  for (const category of Object.values(categories)) { category.tasks = unique(category.tasks); category.evidenceCodes = unique(category.evidenceCodes); }
  const successfulRetrievals = tasks.reduce((sum, t) => sum + t.retrieval.successful, 0), noNewEvidence = tasks.reduce((sum, t) => sum + t.retrieval.noNewEvidence, 0);
  const contextLoss = categories.context_loss.count;
  return { tasks: tasks.length, completedTasks: tasks.filter(t => t.status === 'completed').length, failedOrPartialTasks: tasks.filter(t => t.status !== 'completed').length,
    questions: tasks.reduce((sum, t) => sum + t.questions.length, 0), failedQuestions: tasks.reduce((sum, t) => sum + t.questions.filter(q => !q.completed).length, 0),
    incompleteTraces: tasks.filter(t => t.trace.completeness !== 'complete').length, toolCalls: tasks.reduce((sum, t) => sum + t.observedToolCalls, 0), tools,
    failedToolCalls: tasks.reduce((sum, t) => sum + t.calls.filter(call => call.ok === false).length, 0),
    exactQueryRepeats: tasks.reduce((sum, t) => sum + t.queryRepeats.filter(r => r.kind === 'exact').length, 0), similarQueryRepeats: tasks.reduce((sum, t) => sum + t.queryRepeats.filter(r => r.kind === 'similar').length, 0),
    successfulRetrievals, noNewEvidence, noNewEvidenceRate: successfulRetrievals ? noNewEvidence / successfulRetrievals : null,
    questionSwitches: tasks.reduce((sum, t) => sum + t.switches.count, 0), repeatedReadsAfterReturn: tasks.reduce((sum, t) => sum + t.switches.repeatedReadsAfterReturn, 0),
    identicalClaimWrites: tasks.reduce((sum, t) => sum + t.identicalClaimWrites, 0), repeatedVerifications: tasks.reduce((sum, t) => sum + t.repeatedVerifications, 0),
    compactUnobservableTasks: tasks.filter(t => t.compact.observability === 'unobservable').length, budgetLimitedUnfinishedTasks: tasks.filter(t => t.budget.exhaustedWithUnfinished).length,
    categories, contextContention: { supported: contextLoss > 0, conclusion: contextLoss > 0 ? '有：存在上下文管理器直接记录的证据遗失事件。' : '无：现有轨迹不支持把失败归因于上下文争用。',
      limitation: '这是证据充分性结论，不证明上下文争用从未发生。工具切换、重读和重复调用不能单独证明上下文丢失；compact 没有事件时不可观测。' } };
}

/** Safe to commit: allowlist statistics only; never interpolate queries, answers, source text, or error messages. */
export function renderResearchAttributionMarkdown(tasks: ResearchTaskAttribution[], summary = summarizeResearchAttribution(tasks)): string {
  const percent = (value: number | null) => value === null ? '不可计算' : `${(value * 100).toFixed(2)}%`;
  const rows = tasks.map((task, index) => {
    const alias = `T${String(index + 1).padStart(2, '0')}`;
    const failures = task.questions.filter(q => !q.completed).map(q => `${['income_profit', 'cash_flow', 'risks'].includes(q.questionId) ? q.questionId : 'other'}:${q.attribution?.category}`).join('；') || '—';
    const distribution = Object.entries(task.distribution.buckets).map(([bucket, value]) => `${/^(?:income_profit|cash_flow|risks)(?:\+(?:income_profit|cash_flow|risks))*$|^(?:global|unassigned)$/u.test(bucket) ? bucket : 'other'}=${value.calls}`).join('；');
    const label = task.visibility === 'development' && /^dev-\d{6}$/u.test(task.caseId) ? task.caseId : '历史保留';
    return `| ${alias} | ${label} | ${task.status === 'completed' ? 'completed' : task.status === 'partial' ? 'partial' : 'other'} | ${task.observedToolCalls}/${task.reportedToolCalls ?? '?'} | ${distribution} | ${task.queryRepeats.filter(r => r.kind === 'exact').length}/${task.queryRepeats.filter(r => r.kind === 'similar').length} | ${task.retrieval.noNewEvidence}/${task.retrieval.successful} | ${task.switches.count}/${task.switches.repeatedReadsAfterReturn} | ${task.budget.exhaustedWithUnfinished ? '是' : '否'} | ${failures} |`;
  });
  return `# U01 历史轨迹失败归因\n\n${summary.contextContention.conclusion}${summary.contextContention.limitation}\n\n共 ${summary.tasks} 个实际任务，completed ${summary.completedTasks}，partial/failed/unknown ${summary.failedOrPartialTasks}；${summary.questions} 个问题中 ${summary.failedQuestions} 个未完成。漏失或不完整轨迹 ${summary.incompleteTraces}。这批任务跨版本、提示词和修复阶段，仅作历史诊断。\n\n各工具调用：${Object.entries(summary.tools).sort().map(([name, count]) => `${name}=${count}`).join('，')}。总计 ${summary.toolCalls}，失败调用 ${summary.failedToolCalls}。相同 query 重复 ${summary.exactQueryRepeats}，高度相似 query 重复 ${summary.similarQueryRepeats}；成功检索/读取中无新定位内容 ${summary.noNewEvidence}/${summary.successfulRetrievals}（${percent(summary.noNewEvidenceRate)}）。\n\n跨问题切换 ${summary.questionSwitches}，返回原问题后重复读取 ${summary.repeatedReadsAfterReturn}。相同 claim 输入重复保存 ${summary.identicalClaimWrites}，同 claimHash 重复核验 ${summary.repeatedVerifications}；它们说明调用分配可优化，不直接证明质量收益。${summary.compactUnobservableTasks}/${summary.tasks} 任务的 compact 次数不可观测；${summary.budgetLimitedUnfinishedTasks} 个任务额度到顶且仍有未完成问题。\n\n| 任务 | 资料 | 状态 | 观察/账本工具 | 问题调用分布 | 同/相似 query | 无新证据/成功检索读取 | 切换/返回重读 | 到顶未完成 | 失败问题归类 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n| 失败类别 | 问题数 | 依据代码 |\n| --- | --- | --- |\n${researchFailureCategories.map(category => `| ${category} | ${summary.categories[category].count} | ${summary.categories[category].evidenceCodes.join('，') || '无符合条件的直接证据'} |`).join('\n')}\n\n按问题分布依据显式 questionId、metric、claimId 和最终/历史引用定位关联；搜索优先使用 fields，再用 query 词项推断。共享调用进入组合桶，每个相关问题分摊 1/n；覆盖检查和提交为 global。切换统计只使用单问题归属调用，忽略共享或未知调用，因此只是可观察代理。\n\n重复 query 使用 NFKC、大小写及标点规范化；高度相似门槛为字符二元组 Jaccard ≥0.85，每个后续 query 最多计一次，并在 JSON 保留过滤范围是否相同。相同词串跨文档过滤不一定是浪费。无新证据采用文档版本、定位、偏移和返回内容 SHA-256 去重，分母仅为可解析的成功 search/read；不等于语义信息增益，重叠或扩展片段仍可能记为新单元。\n\n每个失败问题只有一个主要类别，预算等共现因素另留在受控 JSON。retrieval_miss 表示已取回证据不足，不能单凭此判断原文存在答案或原文未披露；not_disclosed 必须有完整文档人工核查回执。verification_pending 表示终态明确缺少独立语义核验。context_loss 只接受直接上下文管理器遗失事件，不能由重复读取推断。预算到顶记录使用原 40 次上限及公开 checkpoint 的步骤状态，未记载步骤标 not_recorded。\n\n逐调用归属、失败依据行号、未完成计划步骤和真实 query 仅保存于受控 evidence/U01 目录。本文不包含历史保留题、答案正文或隐藏思维链。\n`;
}
