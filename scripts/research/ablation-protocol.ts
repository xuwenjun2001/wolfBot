import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalResearchJson } from '../../src/lib/company-research/task-contracts';
import { cnyUnitPowers } from '../../src/lib/company-research/exact-decimal';
import { researchReportRevisionSchema, type ResearchReportRevision } from '../../src/lib/company-research/revision-contracts';
import { caseAnswerabilitySchema, type CaseAnswerability } from '../../src/lib/eval/financial-research-score-v2';

export const ABLATION_VARIANTS = ['A', 'B', 'B2', 'C1', 'C2', 'C2-peer'] as const;
export type AblationVariant = typeof ABLATION_VARIANTS[number];
export const VARIANT_CONCURRENCY: Record<AblationVariant, number> = { A: 1, B: 1, B2: 1, C1: 1, C2: 3, 'C2-peer': 3 };
export const DEFAULT_ABLATION_BUDGET = { maxToolCalls: 40, timeoutMs: 1_200_000 } as const;
export type AblationReasoning = 'high' | 'max' | 'harness-mock';
export interface AdapterResearchConfiguration { model: string; reasoning: 'high' | 'max'; maxToolCalls: number; timeoutMs: number }
export const ablationSha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const contractSha256 = (value: unknown) => ablationSha256(canonicalResearchJson(value));
export const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).refine(value => !value.endsWith('.'), 'Trailing dots alias paths on Windows')
  .refine(value => !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value), 'Reserved path name');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const periodSchema = z.object({ start: z.string(), end: z.string(), kind: z.string().optional() }).passthrough();
export const ablationCaseSchema = z.object({
  id: safeIdSchema, company: z.object({ symbol: z.string().min(1), name: z.string().min(1) }).passthrough(),
  asOf: z.string().min(1), documentIds: z.array(z.string().min(1)).min(2),
  primaryDocumentIds: z.array(z.string()).optional(), supportingDocumentIds: z.array(z.string()).optional(), periods: z.array(periodSchema).optional(),
  questions: z.array(z.object({ id: z.string(), text: z.string().min(1) }).passthrough()).length(3),
  reference: z.object({ facts: z.array(z.object({ metric: z.string(), period: periodSchema, rawValue: z.string(), unit: z.string(), normalizedYuan: z.string() }).passthrough()).min(1),
    changes: z.array(z.object({ metric: z.string(), percentage: z.string(), comparisonBasis: z.string().optional() }).passthrough()),
    comparisonFacts: z.array(z.unknown()).optional(), restatementConflicts: z.array(z.unknown()).optional(), humanReview: z.string().optional(),
  }).passthrough(),
  executionReadiness: z.object({ realExecutionBlocked: z.boolean(), reasons: z.array(z.string()) }).passthrough().optional(),
  answerabilityDrafts: z.unknown().optional(),
}).passthrough();
export type AblationCase = z.infer<typeof ablationCaseSchema>;
export const ablationDocumentSchema = z.object({ id: z.string(), symbol: z.string(), path: z.string(), bytesSha256: digest,
  parserReceipt: z.object({ path: z.string(), sha256: digest }).passthrough().optional(),
}).passthrough();
export const ablationDatasetSchema = z.object({ schemaVersion: z.number().int(), datasetVersion: z.string(),
  visibility: z.string().optional(), split: z.string().optional(), cases: z.array(ablationCaseSchema).min(1),
  documents: z.array(ablationDocumentSchema).optional(),
}).passthrough().superRefine((dataset, ctx) => {
  if (new Set(dataset.cases.map(sample => sample.id.toLowerCase())).size !== dataset.cases.length) ctx.addIssue({ code: 'custom', message: 'Duplicate case IDs (case-insensitive path keys)' });
  if (dataset.visibility === 'hidden' || /holdout/i.test(dataset.split ?? '')) ctx.addIssue({ code: 'custom', message: 'This development runner cannot open hidden holdout data' });
});
export const peerPairsSchema = z.object({ developmentSha256: digest, pairs: z.array(z.object({
  id: safeIdSchema, caseIds: z.array(safeIdSchema).length(2), realExecutionBlocked: z.boolean().optional(),
}).passthrough()).min(1) }).passthrough().superRefine((dataset, ctx) => {
  if (new Set(dataset.pairs.map(pair => pair.id.toLowerCase())).size !== dataset.pairs.length) ctx.addIssue({ code: 'custom', message: 'Duplicate peer IDs (case-insensitive path keys)' });
});

export interface AblationOptions {
  variant: AblationVariant; provider: 'mock' | 'real'; dataset: string; campaign: string;
  repeats: number; maxInputTokens: number; model: string; reasoning: AblationReasoning; cache: 'cold' | 'warm';
  taskKind: 'single' | 'peer'; rubric: string; answerability?: string; documents?: string; peerPairs?: string; registration?: string;
}
export function parseAblationOptions(args: string[]): AblationOptions {
  const supported = ['variant', 'provider', 'dataset', 'campaign', 'repeats', 'max-input-tokens', 'model', 'reasoning', 'cache', 'task-kind', 'rubric', 'answerability', 'documents', 'peer-pairs', 'registration'];
  const fields: Record<string, string> = {};
  for (const argument of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || !supported.includes(match[1]) || fields[match[1]] !== undefined) throw new Error('ABLATION_ARGUMENTS: use unique --name=value options');
    fields[match[1]] = match[2];
  }
  for (const required of ['variant', 'provider', 'dataset', 'campaign', 'repeats', 'max-input-tokens']) if (!fields[required]) throw new Error(`ABLATION_ARGUMENT_REQUIRED:${required}`);
  const integer = (field: string, max: number) => {
    const value = Number(fields[field]);
    if (!/^\d+$/.test(fields[field]) || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`ABLATION_INTEGER:${field}`);
    return value;
  };
  const variant = z.enum(ABLATION_VARIANTS).parse(fields.variant);
  const provider = z.enum(['mock', 'real']).parse(fields.provider);
  if (provider === 'real' && (!fields.model || !fields.reasoning)) throw new Error('ABLATION_REAL_EXPLICIT_MODEL_AND_REASONING_REQUIRED');
  const taskKind = z.enum(['single', 'peer']).parse(fields['task-kind'] ?? (variant === 'C2-peer' ? 'peer' : 'single'));
  if (variant === 'C2-peer' && taskKind !== 'peer') throw new Error('ABLATION_PEER_TASK_REQUIRED');
  return { variant, provider, dataset: fields.dataset, campaign: fields.campaign,
    repeats: integer('repeats', 100), maxInputTokens: integer('max-input-tokens', Number.MAX_SAFE_INTEGER),
    model: fields.model ?? 'harness-mock', reasoning: z.enum(['high', 'max', 'harness-mock']).parse(fields.reasoning ?? 'harness-mock'),
    cache: z.enum(['cold', 'warm']).parse(fields.cache ?? 'cold'), taskKind,
    rubric: fields.rubric ?? 'fixtures/company-research/rubric-v2.json', answerability: fields.answerability,
    documents: fields.documents, peerPairs: fields['peer-pairs'], registration: fields.registration };
}

/** Never coerce million_yuan or replace original facts by restated comparison facts. */
export function caseCompatibility(sample: AblationCase) {
  const scoring: string[] = [], execution: string[] = [];
  const units = [...new Set(sample.reference.facts.map(fact => fact.unit))];
  for (const unit of units) if (!(unit in cnyUnitPowers)) scoring.push(`UNSUPPORTED_V1_UNIT:${unit}`);
  if (sample.reference.comparisonFacts?.length || sample.reference.changes.some(change => change.comparisonBasis === 'restated_comparative')) scoring.push('RESTATED_COMPARISON_NOT_SUPPORTED_BY_V1');
  if (sample.documentIds.length !== 2) execution.push('ADDITIONAL_DOCUMENT_SCOPE_NOT_SUPPORTED_BY_PRODUCTION_TASK');
  if (sample.executionReadiness?.realExecutionBlocked) execution.push(...sample.executionReadiness.reasons.map(reason => `DATASET_EXECUTION_BLOCKED:${reason}`));
  let labels: CaseAnswerability | null = null;
  const parsed = caseAnswerabilitySchema.safeParse(sample.answerabilityDrafts);
  if (parsed.success) labels = parsed.data;
  return { scoringBlockers: scoring, executionBlockers: [...execution, ...scoring], inlineLabels: labels,
    inlineLabelError: parsed.success ? null : parsed.error.issues.map(issue => `${issue.path.join('.')}:${issue.message}`).join('; ') };
}

export interface AblationComparisonContract {
  schemaVersion: 1; version: 'research-ablation-v1'; provider: 'mock' | 'real';
  model: string; reasoning: AblationReasoning; taskKind: 'single' | 'peer';
  datasetSha256: string; dataHashes: Record<string, string>; codeHashes: Record<string, string>;
  rubricSha256: string; labelHashes: Record<string, string>; peerPairsSha256: string | null;
  caseIds: string[]; repeats: number; budget: typeof DEFAULT_ABLATION_BUDGET;
  maxInputTokens: number; cacheCondition: 'cold' | 'warm'; concurrencyByVariant: typeof VARIANT_CONCURRENCY;
  adapter: { id: string; supportedVariants: AblationVariant[]; inputBudget: 'enforced' | 'accounted_after_task'; researchConfiguration: AdapterResearchConfiguration | null };
}
export function validateComparisonProtocol(existing: AblationComparisonContract, requested: AblationComparisonContract) {
  if (canonicalResearchJson(existing) !== canonicalResearchJson(requested)) throw new Error('ABLATION_PROTOCOL_MISMATCH: model/reasoning/data/code/scoring/budget/repeats/cache/task design changed');
}
export const runKey = (variant: AblationVariant, repeat: number, caseId: string) => {
  safeIdSchema.parse(caseId);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('ABLATION_REPEAT_ID');
  return `${variant}/repeat-${String(repeat).padStart(3, '0')}/${caseId}`;
};
export interface AblationUsage {
  inputTokens: number | null; outputTokens: number | null; unknownModelRequests: number;
  toolCalls: number; modelRequests: number; measurement: 'simulated' | 'provider_reported' | 'unknown';
}
export function validateUsage(usage: AblationUsage): AblationUsage {
  const count = z.number().int().nonnegative().safe();
  return z.object({ inputTokens: count.nullable(), outputTokens: count.nullable(), unknownModelRequests: count,
    toolCalls: count, modelRequests: count, measurement: z.enum(['simulated', 'provider_reported', 'unknown']) }).strict().parse(usage);
}
export function campaignInputState(usages: readonly AblationUsage[], cap: number) {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('ABLATION_TOKEN_CAP');
  const validated = usages.map(validateUsage);
  const inputTokens = validated.reduce((total, usage) => total + (usage.inputTokens ?? 0), 0);
  if (!Number.isSafeInteger(inputTokens)) throw new Error('ABLATION_TOKEN_SUM_OVERFLOW');
  const unknown = validated.some(usage => usage.inputTokens === null || usage.unknownModelRequests > 0);
  return { inputTokens, inputTokensAreLowerBound: unknown, cap, remaining: unknown ? 0 : Math.max(0, cap - inputTokens),
    stop: unknown || inputTokens >= cap, reason: unknown ? 'UNKNOWN_INPUT_USAGE' as const : inputTokens >= cap ? 'INPUT_TOKEN_CAP' as const : null,
    overrun: Math.max(0, inputTokens - cap) };
}
export interface DatabaseIsolationEnvironment { DATABASE_URL?: string; RESEARCH_TEST_DATABASE_URL?: string }
export function databaseIsolationBlockers(env: DatabaseIsolationEnvironment): string[] {
  if (!env.DATABASE_URL || !env.RESEARCH_TEST_DATABASE_URL || env.DATABASE_URL !== env.RESEARCH_TEST_DATABASE_URL) return ['EXPLICIT_EQUAL_DISPOSABLE_DATABASE_URLS_REQUIRED'];
  try {
    const db = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !['localhost', '127.0.0.1'].includes(db.hostname) || !/^\/research_test(?:_[a-z0-9_]+)?$/.test(db.pathname)) return ['DISPOSABLE_LOCALHOST_RESEARCH_TEST_DATABASE_REQUIRED'];
  } catch { return ['INVALID_DISPOSABLE_DATABASE_URL']; }
  return [];
}
export interface AblationWorkItem { id: string; kind: 'single' | 'peer'; cases: AblationCase[]; peerExecutionBlocked?: boolean }
export interface AblationExecutionRequest {
  variant: AblationVariant; runtimeOptions: { variant: AblationVariant }; work: AblationWorkItem;
  repeat: number; model: string; reasoning: AblationReasoning; concurrency: number; cacheCondition: 'cold' | 'warm';
  budget: typeof DEFAULT_ABLATION_BUDGET; remainingInputTokens: number; signal: AbortSignal;
}
export interface AblationExecutionResult {
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  reports: { caseId: string; report: ResearchReportRevision | null; hardErrors: string[] }[];
  usage: AblationUsage; phaseDurationsMs: Record<string, number | null>;
  treeSummary: { id: string; parentId: string | null; role: string; status: string }[];
  error: string | null;
}
export const ablationReportResultSchema = z.object({ caseId: safeIdSchema,
  report: researchReportRevisionSchema.nullable(), hardErrors: z.array(z.string()) }).strict();
export function validateExecutionResult(result: AblationExecutionResult): AblationExecutionResult {
  return z.object({ status: z.enum(['completed', 'partial', 'failed', 'cancelled']),
    reports: z.array(ablationReportResultSchema), usage: z.custom<AblationUsage>().transform(validateUsage),
    phaseDurationsMs: z.record(z.string(), z.number().finite().nonnegative().nullable()),
    treeSummary: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), role: z.string(), status: z.string() }).strict()),
    error: z.string().nullable(),
  }).strict().parse(result);
}
/** Trusted composition port. CLI cannot load an arbitrary executable adapter path. */
export interface AblationExecutionAdapter {
  id: string; provider: 'mock' | 'real'; supportedVariants: AblationVariant[];
  inputBudget: 'enforced' | 'accounted_after_task';
  researchConfiguration?: AdapterResearchConfiguration;
  assertDisposableDatabase?: () => Promise<void>;
  run: (request: AblationExecutionRequest) => Promise<AblationExecutionResult>;
}
export function realExecutionBlockers(input: {
  options: AblationOptions; adapter?: AblationExecutionAdapter; env: DatabaseIsolationEnvironment;
  rubricFrozen: boolean; allLabelsConfirmed: boolean; registrationApproved: boolean;
  registrationBound: boolean; approvalReceiptBound: boolean; caseBlockers: string[]; peerReviewed: boolean;
}): string[] {
  const { options, adapter } = input;
  return [
    ...(!adapter || adapter.provider !== 'real' ? ['APPROVED_PRODUCTION_ADAPTER_UNAVAILABLE'] : []),
    ...(adapter && !adapter.supportedVariants.includes(options.variant) ? [`RUNTIME_VARIANT_UNSUPPORTED:${options.variant}`] : []),
    ...(adapter && (adapter.inputBudget !== 'enforced' || !adapter.assertDisposableDatabase) ? ['ADAPTER_INPUT_CAP_AND_DATABASE_PROOF_REQUIRED'] : []),
    ...(!adapter?.researchConfiguration || options.model !== adapter.researchConfiguration.model || options.reasoning !== adapter.researchConfiguration.reasoning ? ['ADAPTER_ACTUAL_RESEARCH_CONFIGURATION_MISMATCH'] : []),
    ...(adapter?.researchConfiguration && (adapter.researchConfiguration.maxToolCalls !== DEFAULT_ABLATION_BUDGET.maxToolCalls || adapter.researchConfiguration.timeoutMs !== DEFAULT_ABLATION_BUDGET.timeoutMs) ? ['ADAPTER_ACTUAL_BUDGET_MISMATCH'] : []),
    ...databaseIsolationBlockers(input.env),
    ...(!input.rubricFrozen ? ['RUBRIC_NOT_HUMAN_FROZEN'] : []),
    ...(!input.allLabelsConfirmed ? ['ANSWERABILITY_NOT_HUMAN_FROZEN'] : []),
    ...(!input.registrationApproved ? ['EXPLICIT_APPROVED_REGISTRATION_REQUIRED'] : []),
    ...(!input.registrationBound ? ['REGISTRATION_PROTOCOL_OR_TOKEN_BUDGET_MISMATCH'] : []),
    ...(!input.approvalReceiptBound ? ['EXPLICIT_USER_APPROVAL_RECEIPT_REQUIRED'] : []),
    ...(options.taskKind === 'peer' && !input.peerReviewed ? ['PEER_TASK_REGISTRATION_NOT_CONFIRMED'] : []),
    ...input.caseBlockers,
  ];
}
export class AblationExecutionFailure extends Error {
  constructor(message: string, readonly partial: Partial<AblationExecutionResult>) { super(message); }
}
export function createHarnessMockAdapter(): AblationExecutionAdapter {
  return { id: 'harness-mock-v1-no-production-agent', provider: 'mock', supportedVariants: [...ABLATION_VARIANTS], inputBudget: 'enforced',
    async run(request) {
      const simulated = Math.min(1000, request.remainingInputTokens);
      const parent = `mock-${request.work.id}`;
      return { status: simulated < 1000 ? 'partial' : 'completed',
        reports: request.work.cases.map(sample => ({ caseId: sample.id, report: null, hardErrors: ['HARNESS_MOCK_NO_PRODUCTION_REPORT'] })),
        usage: { inputTokens: simulated, outputTokens: simulated ? 100 : 0, unknownModelRequests: 0, modelRequests: simulated ? 1 : 0, toolCalls: simulated ? 3 : 0, measurement: 'simulated' },
        phaseDurationsMs: { preparation: 0, model: 0, tools: 0, verification: 0 },
        treeSummary: [{ id: parent, parentId: null, role: 'harness-transport', status: 'completed' },
          ...Array.from({ length: request.concurrency }, (_, index) => ({ id: `${parent}-${index}`, parentId: parent, role: 'synthetic-route-placeholder', status: 'completed' }))],
        error: simulated < 1000 ? 'SIMULATED_INPUT_BUDGET_EXHAUSTED' : null };
    } };
}
