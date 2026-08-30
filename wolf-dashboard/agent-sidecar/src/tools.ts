import type {
  AnalysisSubmission,
  JsonValue,
  RegisteredTool,
  SkillPackageInput,
  ToolCallContext,
  ToolResult,
} from './types.js';

export const FASTAPI_ORIGIN = 'http://127.0.0.1:8787' as const;
export const TOOL_NAMES = [
  'load_skill',
  'read_skill_reference',
  'quant_api_get',
  'screen_stocks',
  'submit_analysis',
] as const;

const MAX_TOOL_RESPONSE_BYTES = 1_000_000;
const MAX_SKILL_CONTENT_CHARS = 256_000;
const MAX_REFERENCE_CHARS = 64_000;
const MAX_REFERENCE_READS = 16;
const MAX_QUERY_KEYS = 20;
const MAX_QUERY_VALUE_CHARS = 512;

const readOnlyPathPatterns = [
  /^\/api\/v1\/symbols\/resolve$/,
  /^\/api\/v1\/quotes\/realtime\/[A-Za-z0-9._:-]+$/,
  /^\/api\/v1\/quotes\/history\/[A-Za-z0-9._:-]+$/,
  /^\/api\/v1\/indicators\/technical\/[A-Za-z0-9._:-]+$/,
  /^\/api\/v1\/research\/universes\/summary$/,
  /^\/api\/v1\/research\/universes\/[A-Za-z0-9._:-]+\/members$/,
  /^\/api\/v1\/research\/screeners\/a-share\/short-term-candidates$/,
  /^\/api\/v1\/skills\/[A-Za-z0-9._:-]+\/SKILL\.md$/,
  /^\/api\/v1\/skills\/[A-Za-z0-9._:-]+\/reference$/,
];

const screenFields = new Set([
  'exchange', 'board', 'asset_type', 'close', 'change_pct', 'amount', 'turnover',
  'ma5', 'ma10', 'ma20', 'ma30', 'ma60', 'return_5d_pct', 'return_10d_pct',
  'return_20d_pct', 'return_60d_pct', 'amount_ratio_20d', 'volatility_20d_pct',
  'max_drawdown_20d_pct', 'max_drawdown_60d_pct', 'is_st', 'is_limit_up',
  'is_limit_down', 'trade_status', 'limit_up_count_4d', 'limit_up_count_10d',
]);
const numericScreenFields = new Set([
  'close', 'change_pct', 'amount', 'turnover', 'ma5', 'ma10', 'ma20', 'ma30', 'ma60',
  'return_5d_pct', 'return_10d_pct', 'return_20d_pct', 'return_60d_pct',
  'amount_ratio_20d', 'volatility_20d_pct', 'max_drawdown_20d_pct',
  'max_drawdown_60d_pct', 'limit_up_count_4d', 'limit_up_count_10d',
]);
const stringScreenFields = new Set(['exchange', 'board', 'asset_type', 'trade_status']);
const booleanScreenFields = new Set(['is_st', 'is_limit_up', 'is_limit_down']);
const screenOps = new Set(['eq', 'gt', 'gte', 'lt', 'lte', 'between']);
const sortFields = new Set([...screenFields]);

export const TOOL_SCHEMAS: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
  load_skill: {
    type: 'object', properties: { skill_id: { type: 'string', minLength: 1, maxLength: 128 } },
    required: ['skill_id'], additionalProperties: false,
  },
  read_skill_reference: {
    type: 'object', properties: {
      skill_id: { type: 'string', minLength: 1, maxLength: 128 },
      path: { type: 'string', minLength: 1, maxLength: 256 },
    }, required: ['skill_id', 'path'], additionalProperties: false,
  },
  quant_api_get: {
    type: 'object', properties: {
      path: { type: 'string', minLength: 1, maxLength: 512 },
      query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    }, required: ['path'], additionalProperties: false,
  },
  screen_stocks: {
    type: 'object', properties: {
      universe_id: { type: 'string', const: 'a-share' },
      as_of: { type: ['string', 'null'], maxLength: 32 },
      conditions: { type: 'array', minItems: 1, maxItems: 12, items: {
        type: 'object', properties: {
          field: { type: 'string' }, op: { type: 'string', enum: [...screenOps] },
          right_field: { type: 'string' }, value: {},
        }, required: ['field', 'op'], additionalProperties: false,
      } },
      sort: { type: 'array', minItems: 1, maxItems: 3, items: {
        type: 'object', properties: {
          field: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] },
        }, required: ['field', 'direction'], additionalProperties: false,
      } },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
    }, required: ['universe_id', 'conditions', 'sort'], additionalProperties: false,
  },
  submit_analysis: {
    type: 'object', properties: {
      status: { type: 'string', enum: ['completed', 'insufficient_evidence'] },
      answer: { type: 'string', minLength: 1, maxLength: 100_000 },
      evidence: { type: 'array', maxItems: 64, items: {
        type: 'object', properties: {
          toolCallId: { type: 'string', minLength: 1, maxLength: 256 },
          tool_call_id: { type: 'string', minLength: 1, maxLength: 256 },
          summary: { type: 'string', minLength: 1, maxLength: 2_000 },
          asOf: { type: ['string', 'null'], maxLength: 64 },
          as_of: { type: ['string', 'null'], maxLength: 64 },
          source: { type: 'string', maxLength: 256 },
        }, required: ['summary'], anyOf: [{ required: ['toolCallId'] }, { required: ['tool_call_id'] }], additionalProperties: false,
      } },
      dataAsOf: { type: ['string', 'null'], maxLength: 64 },
      data_as_of: { type: ['string', 'null'], maxLength: 64 },
      limitations: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 2_000 } },
      riskDisclaimer: { type: 'string', minLength: 1, maxLength: 2_000 },
      risk_disclaimer: { type: 'string', minLength: 1, maxLength: 2_000 },
    }, required: ['status', 'answer', 'evidence', 'limitations'], anyOf: [{ required: ['riskDisclaimer'] }, { required: ['risk_disclaimer'] }], additionalProperties: false,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: string, message: string): ToolResult<never> {
  return { ok: false, error: { code, message } };
}

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

function boundedJson(value: unknown, maxBytes = MAX_TOOL_RESPONSE_BYTES): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return JSON.stringify({ ok: false, error: { code: 'SERIALIZATION_ERROR', message: 'Tool result was not JSON-serializable.' } });
  }
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return serialized;
  return JSON.stringify({ ok: false, error: { code: 'RESPONSE_TOO_LARGE', message: 'Tool response exceeded the response size limit.' } });
}

function normalizeSkillId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('skill_id must be a bounded identifier.');
  }
  return value;
}

function parseLoadInput(value: unknown): { skill_id: string } {
  if (!isRecord(value)) throw new Error('load_skill arguments must be an object.');
  if (Object.keys(value).some((key) => key !== 'skill_id')) throw new Error('load_skill received an unsupported field.');
  return { skill_id: normalizeSkillId(value.skill_id) };
}

function parseReferenceInput(value: unknown): { skill_id: string; path: string } {
  if (!isRecord(value)) throw new Error('read_skill_reference arguments must be an object.');
  if (Object.keys(value).some((key) => key !== 'skill_id' && key !== 'path')) throw new Error('read_skill_reference received an unsupported field.');
  const skillId = normalizeSkillId(value.skill_id);
  if (typeof value.path !== 'string' || !value.path.trim()) throw new Error('reference path is required.');
  const path = value.path.replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes('\0') || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('reference path must remain within the selected skill.');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || !/\.(?:md|txt|json|ya?ml)$/i.test(path)) {
    throw new Error('reference path has an unsupported file type.');
  }
  return { skill_id: skillId, path };
}

function parseQuantInput(value: unknown): { path: string; query?: Record<string, string | number | boolean> } {
  if (!isRecord(value) || typeof value.path !== 'string') throw new Error('quant_api_get path is required.');
  if (Object.keys(value).some((key) => key !== 'path' && key !== 'query')) throw new Error('quant_api_get received an unsupported field.');
  if (value.path.includes('?') || value.path.includes('#') || value.path.includes('\\')) throw new Error('quant_api_get accepts path and query separately.');
  const path = value.path;
  if (!path.startsWith('/api/v1/') || !readOnlyPathPatterns.some((pattern) => pattern.test(path))) {
    throw new Error('quant_api_get path is not in the read-only allowlist.');
  }
  let query: Record<string, string | number | boolean> | undefined;
  if (value.query !== undefined) {
    if (!isRecord(value.query) || Object.keys(value.query).length > MAX_QUERY_KEYS) throw new Error('quant_api_get query is invalid.');
    query = {};
    for (const [key, item] of Object.entries(value.query)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean')) {
        throw new Error('quant_api_get query contains an invalid key or value.');
      }
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('quant_api_get query contains a non-finite number.');
      if (String(item).length > MAX_QUERY_VALUE_CHARS) throw new Error('quant_api_get query value is too long.');
      query[key] = item;
    }
  }
  return { path, ...(query ? { query } : {}) };
}

function parseScreenInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('screen_stocks arguments must be an object.');
  for (const key of Object.keys(value)) if (!['universe_id', 'as_of', 'conditions', 'sort', 'limit'].includes(key)) throw new Error(`screen_stocks field "${key}" is not supported.`);
  if (value.universe_id !== 'a-share') throw new Error('screen_stocks only supports the a-share universe.');
  const conditions = value.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > 12) throw new Error('screen_stocks requires 1 to 12 conditions.');
  const normalizedConditions: Record<string, unknown>[] = [];
  for (const condition of conditions) {
    if (!isRecord(condition) || typeof condition.field !== 'string' || typeof condition.op !== 'string') throw new Error('screen_stocks condition is invalid.');
    for (const key of Object.keys(condition)) {
      if (key !== 'field' && key !== 'op' && key !== 'right_field' && key !== 'value') throw new Error(`screen_stocks condition field "${key}" is not supported.`);
    }
    if (!screenFields.has(condition.field)) throw new Error(`screen_stocks field "${condition.field}" is not supported.`);
    if (!screenOps.has(condition.op)) throw new Error(`screen_stocks operator "${condition.op}" is not supported.`);
    const usesRight = condition.right_field !== undefined;
    const usesValue = condition.value !== undefined;
    if (usesRight === usesValue) throw new Error('Each screen_stocks condition needs exactly one right_field or value.');
    const field = condition.field;
    if (usesRight) {
      if (condition.op === 'between' || typeof condition.right_field !== 'string' || !screenFields.has(condition.right_field)) throw new Error('screen_stocks right_field is invalid.');
      if (numericScreenFields.has(field) !== numericScreenFields.has(condition.right_field) || stringScreenFields.has(field) !== stringScreenFields.has(condition.right_field) || booleanScreenFields.has(field) !== booleanScreenFields.has(condition.right_field)) {
        throw new Error('screen_stocks right_field type is incompatible.');
      }
      normalizedConditions.push({ field, op: condition.op, right_field: condition.right_field });
      continue;
    }
    const item = condition.value;
    if (condition.op === 'between') {
      if (!Array.isArray(item) || item.length !== 2 || item.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) throw new Error('between requires two finite numeric values.');
      normalizedConditions.push({ field, op: condition.op, value: item });
      continue;
    }
    if (numericScreenFields.has(field)) {
      if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error(`screen_stocks value for ${field} must be finite.`);
      if (Math.abs(item) > 1e12) throw new Error(`screen_stocks value for ${field} is out of range.`);
    } else if (stringScreenFields.has(field)) {
      if (typeof item !== 'string' || item.length > 128) throw new Error(`screen_stocks value for ${field} must be a bounded string.`);
    } else if (booleanScreenFields.has(field)) {
      if (typeof item !== 'boolean') throw new Error(`screen_stocks value for ${field} must be boolean.`);
    } else {
      throw new Error(`screen_stocks value for ${field} is unsupported.`);
    }
    normalizedConditions.push({ field, op: condition.op, value: item });
  }
  if (!Array.isArray(value.sort) || value.sort.length === 0 || value.sort.length > 3) throw new Error('screen_stocks sort is required.');
  const sort = value.sort.map((entry) => {
    if (!isRecord(entry) || typeof entry.field !== 'string' || !sortFields.has(entry.field) || (entry.direction !== 'asc' && entry.direction !== 'desc')) throw new Error('screen_stocks sort is invalid.');
    for (const key of Object.keys(entry)) if (key !== 'field' && key !== 'direction') throw new Error(`screen_stocks sort field "${key}" is not supported.`);
    return { field: entry.field, direction: entry.direction };
  });
  const limit = value.limit ?? 10;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 20) throw new Error('screen_stocks limit must be between 1 and 20.');
  if (value.as_of !== undefined && value.as_of !== null && (typeof value.as_of !== 'string' || value.as_of.length > 32)) throw new Error('screen_stocks as_of is invalid.');
  return { universe_id: 'a-share', as_of: value.as_of ?? null, conditions: normalizedConditions, sort, limit };
}

function parseSubmission(value: unknown): AnalysisSubmission {
  if (!isRecord(value)) throw new Error('submit_analysis arguments must be an object.');
  const supported = new Set(['status', 'answer', 'evidence', 'dataAsOf', 'data_as_of', 'limitations', 'riskDisclaimer', 'risk_disclaimer']);
  if (Object.keys(value).some((key) => !supported.has(key))) throw new Error('submit_analysis received an unsupported field.');
  if (value.status !== 'completed' && value.status !== 'insufficient_evidence') throw new Error('submit_analysis status must be completed or insufficient_evidence.');
  if (typeof value.answer !== 'string' || !value.answer.trim() || value.answer.length > 100_000) throw new Error('submit_analysis answer is required and bounded.');
  if (!Array.isArray(value.evidence) || value.evidence.length > 64) throw new Error('submit_analysis evidence is invalid.');
  const evidence = value.evidence.map((item) => {
    if (!isRecord(item)) throw new Error('submit_analysis evidence item is invalid.');
    if (Object.keys(item).some((key) => !['toolCallId', 'tool_call_id', 'summary', 'asOf', 'as_of', 'source'].includes(key))) throw new Error('submit_analysis evidence item has an unsupported field.');
    const toolCallId = item.toolCallId ?? item.tool_call_id;
    const asOf = item.asOf ?? item.as_of;
    if (typeof toolCallId !== 'string' || !toolCallId.trim() || typeof item.summary !== 'string' || !item.summary.trim()) throw new Error('submit_analysis evidence item is invalid.');
    if (asOf !== undefined && asOf !== null && (typeof asOf !== 'string' || asOf.length > 64)) throw new Error('submit_analysis evidence asOf is invalid.');
    if (item.source !== undefined && (typeof item.source !== 'string' || item.source.length > 256)) throw new Error('submit_analysis evidence source is invalid.');
    return { toolCallId, summary: item.summary, ...(asOf === undefined ? {} : { asOf: asOf as string | null }), ...(item.source === undefined ? {} : { source: item.source as string }) };
  });
  if (value.status === 'completed' && evidence.length === 0) throw new Error('completed submissions require evidence.');
  if (!Array.isArray(value.limitations) || value.limitations.length === 0 || value.limitations.length > 32 || value.limitations.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2_000)) throw new Error('submit_analysis limitations are required.');
  const riskDisclaimer = value.riskDisclaimer ?? value.risk_disclaimer;
  const dataAsOf = value.dataAsOf ?? value.data_as_of;
  if (typeof riskDisclaimer !== 'string' || !riskDisclaimer.trim() || riskDisclaimer.length > 2_000) throw new Error('submit_analysis riskDisclaimer is required.');
  if (dataAsOf !== undefined && dataAsOf !== null && (typeof dataAsOf !== 'string' || dataAsOf.length > 64)) throw new Error('submit_analysis dataAsOf is invalid.');
  return {
    status: value.status,
    answer: value.answer,
    evidence,
    ...(dataAsOf === undefined ? {} : { dataAsOf: dataAsOf as string | null }),
    limitations: value.limitations,
    riskDisclaimer,
  };
}

async function fetchWithTimeout(fetchImpl: typeof fetch, input: string | URL, init: RequestInit, signal: AbortSignal, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Tool request timed out.', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  const combined = AbortSignal.any([signal, controller.signal]);
  try {
    return await fetchImpl(input, { ...init, signal: combined, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_TOOL_RESPONSE_BYTES) throw new Error('Tool response exceeded the response size limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Tool response had no body.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TOOL_RESPONSE_BYTES) {
        await reader.cancel('tool response byte limit').catch(() => undefined);
        throw new Error('Tool response exceeded the response size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('FastAPI returned malformed JSON.');
  }
}

export interface ToolRuntimeOptions {
  skills?: SkillPackageInput[];
  /** undefined means automatic model selection; null or "none" means no skill. */
  selectedSkill?: string | null;
  fetchImpl?: typeof fetch;
}

export function createGovernedTools(options: ToolRuntimeOptions = {}): RegisteredTool[] {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const skills = [...(options.skills ?? [])];
  const selectedSkill = options.selectedSkill;
  let loadedSkill: string | null = null;
  let referenceReads = 0;

  const skillById = (id: string): SkillPackageInput | undefined => skills.find((skill) => skill.id === id && skill.enabled !== false);
  const callFastApi = async (path: string, init: RequestInit, context: ToolCallContext): Promise<ToolResult> => {
    try {
      const response = await fetchWithTimeout(fetchImpl, `${FASTAPI_ORIGIN}${path}`, init, context.signal);
      if (!response.ok) return failure('FASTAPI_HTTP_ERROR', `FastAPI read-only request failed with HTTP ${response.status}.`);
      return ok(await readResponseJson(response));
    } catch (error) {
      if (context.signal.aborted) return failure('CANCELLED', 'Tool request was cancelled.');
      const message = error instanceof Error ? error.message : '';
      if (message.includes('size limit')) return failure('FASTAPI_RESPONSE_TOO_LARGE', 'FastAPI response exceeded the size limit.');
      if (message.includes('malformed JSON')) return failure('FASTAPI_PROTOCOL_ERROR', 'FastAPI returned malformed JSON.');
      return failure('FASTAPI_REQUEST_ERROR', 'FastAPI request failed.');
    }
  };
  const skillPath = (skillId: string, suffix: string): string => `/api/v1/skills/${encodeURIComponent(skillId)}${suffix}`;

  return [
    {
      name: 'load_skill', description: 'Load the selected enabled skill SKILL.md.', inputSchema: TOOL_SCHEMAS.load_skill,
      parseInput: parseLoadInput,
      execute: async (raw, context) => {
        const input = parseLoadInput(raw);
        if (selectedSkill === null || selectedSkill === 'none') return failure('SKILL_NOT_SELECTED', 'No skill was selected for this run.');
        if (selectedSkill !== undefined && input.skill_id !== selectedSkill) return failure('SKILL_NOT_ALLOWED', 'Only the selected skill may be loaded.');
        if (loadedSkill && loadedSkill !== input.skill_id) return failure('SKILL_LIMIT', 'Only one skill may be loaded per run.');
        const skill = skillById(input.skill_id);
        if (!skill) return failure('SKILL_UNAVAILABLE', 'Selected skill is unavailable.');
        let content = skill.content;
        if (typeof content !== 'string') {
          const fetched = await callFastApi(
            skillPath(input.skill_id, '/SKILL.md'),
            { method: 'GET', headers: { Accept: 'application/json' } },
            context,
          );
          if (!fetched.ok) return fetched;
          if (!isRecord(fetched.data) || typeof fetched.data.content !== 'string') return failure('FASTAPI_PROTOCOL_ERROR', 'FastAPI returned invalid skill content.');
          content = fetched.data.content;
        }
        if (content.length > MAX_SKILL_CONTENT_CHARS) return failure('SKILL_TOO_LARGE', 'Selected skill content exceeded the size limit.');
        loadedSkill = input.skill_id;
        return ok({ skill_id: skill.id, name: skill.name, version: skill.version, content });
      },
    },
    {
      name: 'read_skill_reference', description: 'Read one bounded reference file from the selected skill.', inputSchema: TOOL_SCHEMAS.read_skill_reference,
      parseInput: parseReferenceInput,
      execute: async (raw, context) => {
        const input = parseReferenceInput(raw);
        if (loadedSkill !== input.skill_id) return failure('SKILL_NOT_LOADED', 'Load the selected skill before reading references.');
        if (++referenceReads > MAX_REFERENCE_READS) return failure('REFERENCE_READ_LIMIT', 'Skill reference read budget exhausted.');
        const skill = skillById(input.skill_id);
        if (!skill) return failure('SKILL_UNAVAILABLE', 'Selected skill is unavailable.');
        let content = skill.references?.[input.path];
        if (typeof content !== 'string') {
          const query = new URLSearchParams({ path: input.path });
          const fetched = await callFastApi(
            `${skillPath(input.skill_id, '/reference')}?${query.toString()}`,
            { method: 'GET', headers: { Accept: 'application/json' } },
            context,
          );
          if (!fetched.ok) return fetched;
          if (!isRecord(fetched.data) || typeof fetched.data.content !== 'string') return failure('FASTAPI_PROTOCOL_ERROR', 'FastAPI returned invalid skill reference content.');
          content = fetched.data.content;
        }
        if (content.length > MAX_REFERENCE_CHARS) return failure('REFERENCE_TOO_LARGE', 'Skill reference exceeded the size limit.');
        return ok({ skill_id: input.skill_id, path: input.path, content });
      },
    },
    {
      name: 'quant_api_get', description: 'Read one allowlisted FastAPI market or research endpoint.', inputSchema: TOOL_SCHEMAS.quant_api_get,
      parseInput: parseQuantInput,
      execute: async (raw, context) => {
        const input = parseQuantInput(raw);
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(input.query ?? {})) query.set(key, String(value));
        const path = query.toString() ? `${input.path}?${query.toString()}` : input.path;
        return callFastApi(path, { method: 'GET', headers: { Accept: 'application/json' } }, context);
      },
    },
    {
      name: 'screen_stocks', description: 'Run the deterministic allowlisted A-share screener.', inputSchema: TOOL_SCHEMAS.screen_stocks,
      parseInput: parseScreenInput,
      execute: async (raw, context) => {
        const input = parseScreenInput(raw);
        return callFastApi('/api/v1/research/screeners/a-share/query', {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: boundedJson(input),
        }, context);
      },
    },
    {
      name: 'submit_analysis', description: 'Submit the final evidence-backed analysis or evidence insufficiency result.', inputSchema: TOOL_SCHEMAS.submit_analysis,
      terminal: true,
      parseInput: parseSubmission,
      execute: async (raw) => ok(parseSubmission(raw)),
    },
  ];
}

export function publicToolResult(result: ToolResult): JsonValue {
  if (result.ok) return { ok: true, data: result.data as JsonValue };
  return { ok: false, error: { code: result.error.code, message: result.error.message } };
}
