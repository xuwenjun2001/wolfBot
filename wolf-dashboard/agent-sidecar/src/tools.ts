import type {
  AnalysisSubmission,
  JsonValue,
  RegisteredTool,
  SkillPackageInput,
  ToolCallContext,
  ToolCategory,
  ToolResult,
} from './types.js';

export const FASTAPI_ORIGIN = 'http://127.0.0.1:8787' as const;

/** Model-visible market and terminal tools. Skill tools are added per run. */
export const MARKET_TOOL_NAMES = [
  'get_market_session_context',
  'resolve_symbol',
  'resolve_board',
  'get_board_snapshot',
  'get_board_breadth',
  'get_board_members',
  'get_realtime_quote',
  'get_price_history',
  'get_technical_indicators',
  'get_universe_summary',
  'get_universe_members',
  'get_preset_candidates',
  'screen_stocks',
] as const;
export const SKILL_TOOL_NAMES = ['load_skill', 'read_skill_reference'] as const;
export const TERMINAL_TOOL_NAME = 'submit_analysis' as const;
export const TOOL_NAMES = [
  ...SKILL_TOOL_NAMES,
  ...MARKET_TOOL_NAMES,
  TERMINAL_TOOL_NAME,
] as const;

/** Historical tool name kept readable by the backend; never registered again. */
export const LEGACY_TOOL_NAMES = ['quant_api_get'] as const;

const MAX_TOOL_RESPONSE_BYTES = 1_000_000;
const MAX_SKILL_CONTENT_CHARS = 256_000;
const MAX_REFERENCE_CHARS = 64_000;
const MAX_REFERENCE_READS = 16;
const MAX_AVAILABLE_REFERENCES = 32;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

const SYMBOL_PATTERN = /^(?:sh|sz|bj)[0-9]{6}$/;
const BOARD_ID_PATTERN = /^[a-f0-9]{8,64}$/;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ADJUSTMENTS = ['none', 'qfq', 'hfq'] as const;
const PRESET_MODES = ['short_term', 'limit_up_relay', 'trend_liquidity'] as const;
const BOARD_TYPES = ['industry', 'concept', 'theme', 'region'] as const;
const BOARD_MEMBER_SORTS = ['change_pct', 'amount', 'turnover', 'close'] as const;
const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const UNIVERSE_ID = 'a-share' as const;

/**
 * Classified backend failures the model is allowed to see verbatim. The
 * allowlist stops an arbitrary backend response body from defining a new error
 * code, while still letting the agent tell "no such board" apart from "the
 * upstream dropped the connection" and choose a different next step.
 */
export const GOVERNED_ERROR_CODES = [
  'BOARD_NOT_FOUND',
  'AMBIGUOUS_BOARD',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_RATE_LIMITED',
  'NO_SESSION_DATA',
  'STALE_BOARD_DATA',
  'INSUFFICIENT_COVERAGE',
  'UPSTREAM_INVALID_RESPONSE',
  'INVALID_BOARD_TYPE',
  'INVALID_SORT_FIELD',
  'INVALID_SORT_DIRECTION',
] as const;
const governedErrorCodes = new Set<string>(GOVERNED_ERROR_CODES);

export const SCREEN_FIELDS = [
  'exchange', 'board', 'asset_type', 'close', 'change_pct', 'amount', 'turnover',
  'ma5', 'ma10', 'ma20', 'ma30', 'ma60', 'return_5d_pct', 'return_10d_pct',
  'return_20d_pct', 'return_60d_pct', 'amount_ratio_20d', 'volatility_20d_pct',
  'max_drawdown_20d_pct', 'max_drawdown_60d_pct', 'is_st', 'is_limit_up',
  'is_limit_down', 'trade_status', 'limit_up_count_4d', 'limit_up_count_10d',
] as const;
export const SCREEN_OPS = ['eq', 'gt', 'gte', 'lt', 'lte', 'between'] as const;

const screenFields = new Set<string>(SCREEN_FIELDS);
const numericScreenFields = new Set([
  'close', 'change_pct', 'amount', 'turnover', 'ma5', 'ma10', 'ma20', 'ma30', 'ma60',
  'return_5d_pct', 'return_10d_pct', 'return_20d_pct', 'return_60d_pct',
  'amount_ratio_20d', 'volatility_20d_pct', 'max_drawdown_20d_pct',
  'max_drawdown_60d_pct', 'limit_up_count_4d', 'limit_up_count_10d',
]);
const stringScreenFields = new Set(['exchange', 'board', 'asset_type', 'trade_status']);
const booleanScreenFields = new Set(['is_st', 'is_limit_up', 'is_limit_down']);
const screenOps = new Set<string>(SCREEN_OPS);
const numericScreenRanges = new Map<string, readonly [number, number]>([
  ['close', [0, 1_000_000]],
  ['change_pct', [-100, 1_000]],
  ['amount', [0, 1e16]],
  ['turnover', [0, 100]],
  ['ma5', [0, 1_000_000]],
  ['ma10', [0, 1_000_000]],
  ['ma20', [0, 1_000_000]],
  ['ma30', [0, 1_000_000]],
  ['ma60', [0, 1_000_000]],
  ['return_5d_pct', [-100, 10_000]],
  ['return_10d_pct', [-100, 10_000]],
  ['return_20d_pct', [-100, 10_000]],
  ['return_60d_pct', [-100, 10_000]],
  ['amount_ratio_20d', [0, 100]],
  ['volatility_20d_pct', [0, 1_000]],
  ['max_drawdown_20d_pct', [-100, 0]],
  ['max_drawdown_60d_pct', [-100, 0]],
  ['limit_up_count_4d', [0, 4]],
  ['limit_up_count_10d', [0, 10]],
]);

const symbolProperty = {
  type: 'string',
  pattern: '^(?:sh|sz|bj)[0-9]{6}$',
  description: 'Canonical symbol returned by resolve_symbol, e.g. sh603259. Never pass a company name.',
} as const;
const adjustmentProperty = {
  type: 'string',
  enum: [...ADJUSTMENTS],
  default: 'qfq',
  description: 'Price adjustment: qfq (forward, default), hfq (backward) or none.',
} as const;
const barLimitProperty = {
  type: 'integer',
  minimum: 1,
  maximum: 800,
  description: 'Number of most recent daily bars to return. Ask for the smallest window that answers the question.',
} as const;
const boardIdProperty = {
  type: 'string',
  pattern: '^[a-f0-9]{8,64}$',
  description: 'Opaque board_id returned by resolve_board. Never a provider board code, a name, or a URL.',
} as const;
const boardTradeDateProperty = {
  type: 'string',
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  description: 'Optional trade date. Omit to use the effective trade date from get_market_session_context.',
} as const;

export const TOOL_SCHEMAS: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
  load_skill: {
    type: 'object',
    properties: { skill_id: { type: 'string', minLength: 1, maxLength: 128, description: 'Identifier of the enabled skill allowed for this run.' } },
    required: ['skill_id'], additionalProperties: false,
  },
  read_skill_reference: {
    type: 'object', properties: {
      skill_id: { type: 'string', minLength: 1, maxLength: 128, description: 'Identifier of the skill already loaded in this run.' },
      path: {
        type: 'string', minLength: 1, maxLength: 256,
        pattern: '^references\\/(?:[A-Za-z0-9._-]+\\/)*[A-Za-z0-9._-]+\\.md$',
        description: 'One Markdown path taken verbatim from load_skill.available_references. Never guess a path.',
      },
    }, required: ['skill_id', 'path'], additionalProperties: false,
  },
  resolve_symbol: {
    type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: 80, description: 'Chinese name, six-digit code, or canonical symbol of one tradable security or index.' },
    }, required: ['query'], additionalProperties: false,
  },
  get_market_session_context: {
    type: 'object', properties: {}, additionalProperties: false,
  },
  resolve_board: {
    type: 'object', properties: {
      query: {
        type: 'string', minLength: 1, maxLength: 40,
        description: 'Sector, concept, industry, theme or region name, e.g. 液冷板块. Suffixes like 板块/概念/行业 are accepted.',
      },
      board_type: {
        type: 'string', enum: [...BOARD_TYPES],
        description: 'Optional filter when the question names the classification explicitly.',
      },
    }, required: ['query'], additionalProperties: false,
  },
  get_board_snapshot: {
    type: 'object', properties: { board_id: boardIdProperty, trade_date: boardTradeDateProperty },
    required: ['board_id'], additionalProperties: false,
  },
  get_board_breadth: {
    type: 'object', properties: { board_id: boardIdProperty, trade_date: boardTradeDateProperty },
    required: ['board_id'], additionalProperties: false,
  },
  get_board_members: {
    type: 'object', properties: {
      board_id: boardIdProperty,
      trade_date: boardTradeDateProperty,
      sort: { type: 'string', enum: [...BOARD_MEMBER_SORTS], description: 'Ranking field. Defaults to change_pct.' },
      direction: { type: 'string', enum: [...SORT_DIRECTIONS], description: 'Ranking direction. Defaults to desc.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Members per list (1-50).' },
    }, required: ['board_id'], additionalProperties: false,
  },
  get_realtime_quote: {
    type: 'object', properties: { symbol: symbolProperty }, required: ['symbol'], additionalProperties: false,
  },
  get_price_history: {
    type: 'object', properties: { symbol: symbolProperty, adjustment: adjustmentProperty, limit: barLimitProperty },
    required: ['symbol'], additionalProperties: false,
  },
  get_technical_indicators: {
    type: 'object', properties: { symbol: symbolProperty, adjustment: adjustmentProperty, limit: barLimitProperty },
    required: ['symbol'], additionalProperties: false,
  },
  get_universe_summary: {
    type: 'object', properties: {}, additionalProperties: false,
  },
  get_universe_members: {
    type: 'object', properties: {
      page: { type: 'integer', minimum: 1, description: 'One-based page index.' },
      page_size: { type: 'integer', minimum: 1, maximum: 200, description: 'Members per page (1-200).' },
    }, additionalProperties: false,
  },
  get_preset_candidates: {
    type: 'object', properties: {
      mode: { type: 'string', enum: [...PRESET_MODES], description: 'Fixed screening mode maintained by the backend.' },
      as_of: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'Optional trade date. Omit for the latest available date.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum candidates to return (1-20).' },
    }, required: ['mode'], additionalProperties: false,
  },
  screen_stocks: {
    type: 'object', properties: {
      as_of: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'Optional trade date. Omit for the latest available date.' },
      conditions: {
        type: 'array', minItems: 1, maxItems: 12, description: 'All conditions are combined with AND.', items: {
          type: 'object', properties: {
            field: { type: 'string', enum: [...SCREEN_FIELDS] },
            op: { type: 'string', enum: [...SCREEN_OPS] },
            right_field: { type: 'string', enum: [...SCREEN_FIELDS], description: 'Compare against another field of the same type. Mutually exclusive with value.' },
            value: {
              description: 'Number, string or boolean matching the field type; a two-number array for between. Mutually exclusive with right_field.',
              anyOf: [
                { type: 'number' }, { type: 'string', maxLength: 80 }, { type: 'boolean' },
                { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
              ],
            },
          }, required: ['field', 'op'], additionalProperties: false,
          oneOf: [
            { required: ['value'], not: { required: ['right_field'] } },
            { required: ['right_field'], not: { required: ['value'] } },
          ],
        },
      },
      sort: {
        type: 'array', minItems: 1, maxItems: 4, items: {
          type: 'object', properties: {
            field: { type: 'string', enum: [...SCREEN_FIELDS] },
            direction: { type: 'string', enum: ['asc', 'desc'] },
          }, required: ['field', 'direction'], additionalProperties: false,
        },
      },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
    }, required: ['conditions', 'sort'], additionalProperties: false,
  },
  submit_analysis: {
    type: 'object', properties: {
      status: { type: 'string', enum: ['completed', 'insufficient_evidence'] },
      answer: { type: 'string', minLength: 1, maxLength: 100_000 },
      evidence: { type: 'array', maxItems: 64, items: {
        type: 'object', properties: {
          toolCallId: { type: 'string', minLength: 1, maxLength: 256, description: 'Exact tool_call_id copied from a successful tool result; never use a tool name.' },
          tool_call_id: { type: 'string', minLength: 1, maxLength: 256, description: 'Exact tool_call_id copied from a successful tool result; never use a tool name.' },
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

function failure(code: string, message: string, details?: JsonValue): ToolResult<never> {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
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

function assertObject(name: string, value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} arguments must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${name} does not accept the field "${key}". Allowed fields: ${allowed.join(', ') || 'none'}.`);
  }
  return value;
}

function parseSymbol(name: string, value: unknown): string {
  if (typeof value !== 'string' || !SYMBOL_PATTERN.test(value)) {
    throw new Error(`${name} requires a canonical symbol such as sh603259; call resolve_symbol first when you only have a name.`);
  }
  return value;
}

function parseAdjustment(value: unknown): (typeof ADJUSTMENTS)[number] {
  if (value === undefined) return 'qfq';
  if (typeof value !== 'string' || !(ADJUSTMENTS as readonly string[]).includes(value)) {
    throw new Error(`adjustment must be one of ${ADJUSTMENTS.join(', ')}.`);
  }
  return value as (typeof ADJUSTMENTS)[number];
}

function parseIntegerInRange(name: string, value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function parseAsOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw new Error('as_of must be an ISO calendar date such as 2026-08-28.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('as_of must be a valid ISO calendar date such as 2026-08-28.');
  }
  return value;
}

function normalizeSkillId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('skill_id must be a bounded identifier.');
  }
  return value;
}

function parseLoadInput(value: unknown): { skill_id: string } {
  const input = assertObject('load_skill', value, ['skill_id']);
  return { skill_id: normalizeSkillId(input.skill_id) };
}

function parseReferenceInput(value: unknown): { skill_id: string; path: string } {
  const input = assertObject('read_skill_reference', value, ['skill_id', 'path']);
  const skillId = normalizeSkillId(input.skill_id);
  if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('reference path is required.');
  const path = input.path.replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes('\0') || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('reference path must remain within the selected skill.');
  }
  if (!/^references\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/i.test(path)) {
    throw new Error('reference path must be a Markdown file under references/.');
  }
  return { skill_id: skillId, path };
}

export function parseResolveInput(value: unknown): { query: string } {
  const input = assertObject('resolve_symbol', value, ['query']);
  if (typeof input.query !== 'string') throw new Error('resolve_symbol query must be a string.');
  const query = input.query.trim();
  if (!query || query.length > 80 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error('resolve_symbol query must be 1 to 80 printable characters.');
  return { query };
}

/** Reject C0 controls and DEL without relying on an escaped character class. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parseSessionInput(value: unknown): Record<string, never> {
  assertObject('get_market_session_context', value ?? {}, []);
  return {};
}

export function parseResolveBoardInput(value: unknown): { query: string; board_type?: string } {
  const input = assertObject('resolve_board', value, ['query', 'board_type']);
  if (typeof input.query !== 'string') throw new Error('resolve_board query must be a string.');
  const query = input.query.trim();
  if (!query || query.length > 40 || hasControlCharacters(query)) {
    throw new Error('resolve_board query must be 1 to 40 printable characters.');
  }
  if (input.board_type !== undefined && (typeof input.board_type !== 'string' || !(BOARD_TYPES as readonly string[]).includes(input.board_type))) {
    throw new Error(`resolve_board board_type must be one of ${BOARD_TYPES.join(', ')}.`);
  }
  return { query, ...(input.board_type === undefined ? {} : { board_type: input.board_type as string }) };
}

function parseBoardId(name: string, value: unknown): string {
  if (typeof value !== 'string' || !BOARD_ID_PATTERN.test(value)) {
    throw new Error(`${name} requires the opaque board_id returned by resolve_board; a board name or a provider board code is not valid.`);
  }
  return value;
}

function parseBoardQuoteInput(name: string, value: unknown): { board_id: string; trade_date?: string } {
  const input = assertObject(name, value, ['board_id', 'trade_date']);
  const tradeDate = parseAsOf(input.trade_date);
  return {
    board_id: parseBoardId(name, input.board_id),
    ...(tradeDate === undefined ? {} : { trade_date: tradeDate }),
  };
}

export function parseBoardMembersInput(value: unknown): {
  board_id: string; trade_date?: string; sort?: string; direction?: string; limit?: number;
} {
  const input = assertObject('get_board_members', value, ['board_id', 'trade_date', 'sort', 'direction', 'limit']);
  const tradeDate = parseAsOf(input.trade_date);
  if (input.sort !== undefined && (typeof input.sort !== 'string' || !(BOARD_MEMBER_SORTS as readonly string[]).includes(input.sort))) {
    throw new Error(`get_board_members sort must be one of ${BOARD_MEMBER_SORTS.join(', ')}.`);
  }
  if (input.direction !== undefined && (typeof input.direction !== 'string' || !(SORT_DIRECTIONS as readonly string[]).includes(input.direction))) {
    throw new Error(`get_board_members direction must be one of ${SORT_DIRECTIONS.join(', ')}.`);
  }
  return {
    board_id: parseBoardId('get_board_members', input.board_id),
    ...(tradeDate === undefined ? {} : { trade_date: tradeDate }),
    ...(input.sort === undefined ? {} : { sort: input.sort as string }),
    ...(input.direction === undefined ? {} : { direction: input.direction as string }),
    ...(input.limit === undefined ? {} : { limit: parseIntegerInRange('limit', input.limit, 1, 50) }),
  };
}

function parseSymbolOnlyInput(name: string, value: unknown): { symbol: string } {
  const input = assertObject(name, value, ['symbol']);
  return { symbol: parseSymbol(name, input.symbol) };
}

function parseSeriesInput(name: string, value: unknown): { symbol: string; adjustment: string; limit?: number } {
  const input = assertObject(name, value, ['symbol', 'adjustment', 'limit']);
  return {
    symbol: parseSymbol(name, input.symbol),
    adjustment: parseAdjustment(input.adjustment),
    ...(input.limit === undefined ? {} : { limit: parseIntegerInRange('limit', input.limit, 1, 800) }),
  };
}

function parseUniverseSummaryInput(value: unknown): Record<string, never> {
  assertObject('get_universe_summary', value ?? {}, []);
  return {};
}

function parseUniverseMembersInput(value: unknown): { page?: number; page_size?: number } {
  const input = assertObject('get_universe_members', value ?? {}, ['page', 'page_size']);
  return {
    ...(input.page === undefined ? {} : { page: parseIntegerInRange('page', input.page, 1, 100_000) }),
    ...(input.page_size === undefined ? {} : { page_size: parseIntegerInRange('page_size', input.page_size, 1, 200) }),
  };
}

function parsePresetInput(value: unknown): { mode: string; as_of?: string; limit?: number } {
  const input = assertObject('get_preset_candidates', value, ['mode', 'as_of', 'limit']);
  if (typeof input.mode !== 'string' || !(PRESET_MODES as readonly string[]).includes(input.mode)) {
    throw new Error(`get_preset_candidates mode must be one of ${PRESET_MODES.join(', ')}.`);
  }
  const asOf = parseAsOf(input.as_of);
  return {
    mode: input.mode,
    ...(asOf === undefined ? {} : { as_of: asOf }),
    ...(input.limit === undefined ? {} : { limit: parseIntegerInRange('limit', input.limit, 1, 20) }),
  };
}

export function parseScreenInput(value: unknown): Record<string, unknown> {
  const input = assertObject('screen_stocks', value, ['as_of', 'conditions', 'sort', 'limit']);
  const conditions = input.conditions;
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
    const numericField = numericScreenFields.has(field);
    const stringField = stringScreenFields.has(field);
    const booleanField = booleanScreenFields.has(field);
    if ((stringField || booleanField) && condition.op !== 'eq') {
      throw new Error(`screen_stocks ${field} only supports the eq operator.`);
    }
    if (condition.op === 'between' && !numericField) {
      throw new Error('screen_stocks between only supports numeric fields.');
    }
    if (usesRight) {
      if (condition.op === 'between' || typeof condition.right_field !== 'string' || !screenFields.has(condition.right_field)) throw new Error('screen_stocks right_field is invalid.');
      if (numericField !== numericScreenFields.has(condition.right_field) || stringField !== stringScreenFields.has(condition.right_field) || booleanField !== booleanScreenFields.has(condition.right_field)) {
        throw new Error('screen_stocks right_field type is incompatible.');
      }
      normalizedConditions.push({ field, op: condition.op, right_field: condition.right_field });
      continue;
    }
    const item = condition.value;
    if (condition.op === 'between') {
      if (!Array.isArray(item) || item.length !== 2 || item.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) throw new Error('between requires two finite numeric values.');
      const range = numericScreenRanges.get(field);
      if (!range || item.some((entry) => entry < range[0] || entry > range[1])) throw new Error(`screen_stocks value for ${field} is out of range.`);
      if (item[0] > item[1]) throw new Error('between lower bound must not exceed upper bound.');
      normalizedConditions.push({ field, op: condition.op, value: item });
      continue;
    }
    if (numericField) {
      if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error(`screen_stocks value for ${field} must be finite.`);
      const range = numericScreenRanges.get(field);
      if (!range || item < range[0] || item > range[1]) throw new Error(`screen_stocks value for ${field} is out of range.`);
    } else if (stringField) {
      if (typeof item !== 'string' || !item.trim() || item.length > 80) throw new Error(`screen_stocks value for ${field} must be a non-empty bounded string.`);
      const lowered = item.toLowerCase();
      if ([';', '--', '/*', '*/', ' union ', 'select ', 'drop ', 'exec', 'import ', '__', ' or '].some((token) => lowered.includes(token))) {
        throw new Error('screen_stocks string values cannot contain SQL, script or OR expressions.');
      }
    } else if (booleanField) {
      if (typeof item !== 'boolean') throw new Error(`screen_stocks value for ${field} must be boolean.`);
    } else {
      throw new Error(`screen_stocks value for ${field} is unsupported.`);
    }
    normalizedConditions.push({ field, op: condition.op, value: item });
  }
  if (!Array.isArray(input.sort) || input.sort.length === 0 || input.sort.length > 4) throw new Error('screen_stocks sort requires 1 to 4 fields.');
  const sort = input.sort.map((entry) => {
    if (!isRecord(entry) || typeof entry.field !== 'string' || !screenFields.has(entry.field) || (entry.direction !== 'asc' && entry.direction !== 'desc')) throw new Error('screen_stocks sort is invalid.');
    for (const key of Object.keys(entry)) if (key !== 'field' && key !== 'direction') throw new Error(`screen_stocks sort field "${key}" is not supported.`);
    return { field: entry.field, direction: entry.direction };
  });
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 20) throw new Error('screen_stocks limit must be between 1 and 20.');
  const asOf = parseAsOf(input.as_of);
  return { universe_id: UNIVERSE_ID, as_of: asOf ?? null, conditions: normalizedConditions, sort, limit };
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

class ToolRequestTimeoutError extends Error {
  constructor() {
    super('Tool request timed out.');
    this.name = 'ToolRequestTimeoutError';
  }
}

async function fetchWithTimeout(fetchImpl: typeof fetch, input: string | URL, init: RequestInit, signal: AbortSignal, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ToolRequestTimeoutError()), timeoutMs);
  timer.unref?.();
  const combined = AbortSignal.any([signal, controller.signal]);
  try {
    return await fetchImpl(input, { ...init, signal: combined, redirect: 'error' });
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw new ToolRequestTimeoutError();
    throw error;
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

/** Build a sidecar-controlled query string; the model never supplies raw keys. */
function queryString(entries: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

/**
 * Extract a classified backend error the model may act on.
 *
 * Only codes on {@link GOVERNED_ERROR_CODES} are surfaced verbatim, so a
 * backend response body can never invent a new error vocabulary. Anything else
 * stays an opaque transport failure.
 */
function governedFailure(status: number, body: unknown): ToolResult<never> | undefined {
  const detail = isRecord(body) && isRecord(body.detail) ? body.detail : isRecord(body) ? body : undefined;
  if (!detail || typeof detail.code !== 'string' || !governedErrorCodes.has(detail.code)) return undefined;
  const message = typeof detail.message === 'string' && detail.message.trim()
    ? detail.message.slice(0, 500)
    : 'The market backend rejected the request.';
  const details: Record<string, JsonValue> = { status };
  if (Array.isArray(detail.candidates)) {
    details.candidates = detail.candidates.slice(0, 8).map((item) => ({
      board_id: isRecord(item) && typeof item.board_id === 'string' ? item.board_id : '',
      name: isRecord(item) && typeof item.name === 'string' ? item.name : '',
      board_type: isRecord(item) && typeof item.board_type === 'string' ? item.board_type : '',
      provider: isRecord(item) && typeof item.provider === 'string' ? item.provider : '',
    }));
  }
  return failure(detail.code, message, details);
}

export interface ToolRuntimeOptions {
  skills?: SkillPackageInput[];
  /** undefined means automatic model selection; null or "none" means no skill. */
  selectedSkill?: string | null;
  fetchImpl?: typeof fetch;
  /** Internal test/diagnostic override; never model-visible. */
  requestTimeoutMs?: number;
}

/** Sorted, integrity-checked reference paths the model is allowed to read. */
function availableReferences(fetched: unknown): string[] {
  const offered = isRecord(fetched) && Array.isArray(fetched.available_references)
    ? fetched.available_references.filter((item): item is string => typeof item === 'string')
    : [];
  const unique = [...new Set(offered)]
    .filter((path) => /^references\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/i.test(path));
  unique.sort();
  return unique.slice(0, MAX_AVAILABLE_REFERENCES);
}

export function createGovernedTools(options: ToolRuntimeOptions = {}): RegisteredTool[] {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs) && (options.requestTimeoutMs as number) > 0
    ? options.requestTimeoutMs as number
    : DEFAULT_TOOL_TIMEOUT_MS;
  const skills = [...(options.skills ?? [])];
  const selectedSkill = options.selectedSkill;
  let loadedSkill: string | null = null;
  let loadedReferences: string[] = [];
  let referenceReads = 0;

  const skillById = (id: string): SkillPackageInput | undefined => skills.find((skill) => skill.id === id && skill.enabled !== false);
  const callFastApi = async (path: string, init: RequestInit, context: ToolCallContext): Promise<ToolResult> => {
    try {
      const response = await fetchWithTimeout(fetchImpl, `${FASTAPI_ORIGIN}${path}`, init, context.signal, requestTimeoutMs);
      if (!response.ok) {
        // A classified backend failure ("no such board" vs "the upstream
        // dropped the connection") has to reach the model, or it cannot choose
        // between re-routing, falling back, and ending the run.
        let body: unknown;
        try {
          body = await readResponseJson(response);
        } catch {
          body = undefined;
        }
        return governedFailure(response.status, body)
          ?? failure('FASTAPI_HTTP_ERROR', `FastAPI read-only request failed with HTTP ${response.status}.`, { status: response.status });
      }
      return ok(await readResponseJson(response));
    } catch (error) {
      if (context.signal.aborted) return failure('CANCELLED', 'Tool request was cancelled.');
      if (error instanceof ToolRequestTimeoutError) return failure('FASTAPI_TIMEOUT', 'FastAPI request timed out.');
      const message = error instanceof Error ? error.message : '';
      if (message.includes('size limit')) return failure('FASTAPI_RESPONSE_TOO_LARGE', 'FastAPI response exceeded the size limit.');
      if (message.includes('malformed JSON')) return failure('FASTAPI_PROTOCOL_ERROR', 'FastAPI returned malformed JSON.');
      return failure('FASTAPI_REQUEST_ERROR', 'FastAPI request failed.');
    }
  };
  const getJson = (path: string, context: ToolCallContext): Promise<ToolResult> =>
    callFastApi(path, { method: 'GET', headers: { Accept: 'application/json' } }, context);
  const skillPath = (skillId: string, suffix: string): string => `/api/v1/skills/${encodeURIComponent(skillId)}${suffix}`;

  const skillsAvailable = skills.some((skill) => skill.enabled !== false);
  const skillToolsVisible = selectedSkill !== null && selectedSkill !== 'none' && skillsAvailable
    && (selectedSkill === undefined || skills.some((skill) => skill.id === selectedSkill && skill.enabled !== false));

  const skillTools: RegisteredTool[] = [
    {
      name: 'load_skill', category: 'skill',
      description: 'Load the selected enabled skill SKILL.md and the exact list of reference paths it allows.',
      inputSchema: TOOL_SCHEMAS.load_skill,
      parseInput: parseLoadInput,
      execute: async (raw, context) => {
        const input = parseLoadInput(raw);
        if (selectedSkill === null || selectedSkill === 'none') return failure('SKILL_NOT_SELECTED', 'No skill was selected for this run.');
        if (selectedSkill !== undefined && input.skill_id !== selectedSkill) return failure('SKILL_NOT_ALLOWED', 'Only the selected skill may be loaded.');
        if (loadedSkill && loadedSkill !== input.skill_id) return failure('SKILL_LIMIT', 'Only one skill may be loaded per run.');
        const skill = skillById(input.skill_id);
        if (!skill) return failure('SKILL_UNAVAILABLE', 'Selected skill is unavailable.');
        const response = await getJson(skillPath(input.skill_id, '/SKILL.md'), context);
        if (!response.ok) return response;
        if (!isRecord(response.data) || typeof response.data.content !== 'string') return failure('FASTAPI_PROTOCOL_ERROR', 'FastAPI returned invalid skill content.');
        if (!Array.isArray(response.data.available_references)) return failure('FASTAPI_PROTOCOL_ERROR', 'FastAPI returned no skill reference index.');
        const content = response.data.content;
        if (content.length > MAX_SKILL_CONTENT_CHARS) return failure('SKILL_TOO_LARGE', 'Selected skill content exceeded the size limit.');
        loadedSkill = input.skill_id;
        loadedReferences = availableReferences(response.data);
        return ok({
          skill_id: skill.id,
          name: skill.name,
          version: skill.version,
          content,
          available_references: loadedReferences,
        });
      },
    },
    {
      name: 'read_skill_reference', category: 'skill',
      description: 'Read one reference file whose path came verbatim from load_skill.available_references.',
      inputSchema: TOOL_SCHEMAS.read_skill_reference,
      parseInput: parseReferenceInput,
      execute: async (raw, context) => {
        const input = parseReferenceInput(raw);
        if (loadedSkill !== input.skill_id) return failure('SKILL_NOT_LOADED', 'Load the selected skill before reading references.');
        if (!loadedReferences.includes(input.path)) {
          const offered = loadedReferences.length ? loadedReferences.join(', ') : 'none';
          return failure('REFERENCE_NOT_AVAILABLE', `Reference path is not offered by this skill. Available: ${offered}.`);
        }
        if (++referenceReads > MAX_REFERENCE_READS) return failure('REFERENCE_READ_LIMIT', 'Skill reference read budget exhausted.');
        const skill = skillById(input.skill_id);
        if (!skill) return failure('SKILL_UNAVAILABLE', 'Selected skill is unavailable.');
        const response = await getJson(`${skillPath(input.skill_id, '/reference')}${queryString({ path: input.path })}`, context);
        if (!response.ok) return response;
        if (!isRecord(response.data) || typeof response.data.content !== 'string') return failure('FASTAPI_PROTOCOL_ERROR', 'FastAPI returned invalid skill reference content.');
        const content = response.data.content;
        if (content.length > MAX_REFERENCE_CHARS) return failure('REFERENCE_TOO_LARGE', 'Skill reference exceeded the size limit.');
        return ok({ skill_id: input.skill_id, path: input.path, content });
      },
    },
  ];

  const marketTools: RegisteredTool[] = [
    {
      name: 'get_market_session_context', category: 'market',
      description: 'Read the Beijing-time observation point, A-share market phase, and the effective trade date. Call this first whenever the question says today, yesterday, or recently.',
      inputSchema: TOOL_SCHEMAS.get_market_session_context,
      parseInput: parseSessionInput,
      execute: async (raw, context) => {
        parseSessionInput(raw);
        return getJson('/api/v1/market/session', context);
      },
    },
    {
      name: 'resolve_symbol', category: 'market',
      description: 'Resolve one tradable security or index (stock, ETF, index) to the canonical symbol the quote tools require. Not for sectors, concepts, industries or themes.',
      inputSchema: TOOL_SCHEMAS.resolve_symbol,
      parseInput: parseResolveInput,
      execute: async (raw, context) => {
        const input = parseResolveInput(raw);
        return getJson(`/api/v1/symbols/resolve${queryString({ query: input.query })}`, context);
      },
    },
    {
      name: 'resolve_board', category: 'market',
      description: 'Resolve a sector, concept, industry, theme or region name to one board object with its type, provider and constituent basis. Use this, not resolve_symbol, for 板块/概念/行业/赛道/主题 questions.',
      inputSchema: TOOL_SCHEMAS.resolve_board,
      parseInput: parseResolveBoardInput,
      execute: async (raw, context) => {
        const input = parseResolveBoardInput(raw);
        return getJson(`/api/v1/boards/resolve${queryString({ query: input.query, board_type: input.board_type })}`, context);
      },
    },
    {
      name: 'get_board_snapshot', category: 'market',
      description: 'Read one board change percent, observation point, market phase, source and constituent basis for the effective trade date.',
      inputSchema: TOOL_SCHEMAS.get_board_snapshot,
      parseInput: (value) => parseBoardQuoteInput('get_board_snapshot', value),
      execute: async (raw, context) => {
        const input = parseBoardQuoteInput('get_board_snapshot', raw);
        return getJson(
          `/api/v1/boards/${encodeURIComponent(input.board_id)}/snapshot${queryString({ trade_date: input.trade_date })}`,
          context,
        );
      },
    },
    {
      name: 'get_board_breadth', category: 'market',
      description: 'Read advancing/declining constituent counts and the constituent coverage the counts were computed from.',
      inputSchema: TOOL_SCHEMAS.get_board_breadth,
      parseInput: (value) => parseBoardQuoteInput('get_board_breadth', value),
      execute: async (raw, context) => {
        const input = parseBoardQuoteInput('get_board_breadth', raw);
        return getJson(
          `/api/v1/boards/${encodeURIComponent(input.board_id)}/breadth${queryString({ trade_date: input.trade_date })}`,
          context,
        );
      },
    },
    {
      name: 'get_board_members', category: 'market',
      description: 'Read board constituents with leaders and laggards for the effective trade date.',
      inputSchema: TOOL_SCHEMAS.get_board_members,
      parseInput: parseBoardMembersInput,
      execute: async (raw, context) => {
        const input = parseBoardMembersInput(raw);
        return getJson(
          `/api/v1/boards/${encodeURIComponent(input.board_id)}/members${queryString({
            trade_date: input.trade_date, sort: input.sort, direction: input.direction, limit: input.limit,
          })}`,
          context,
        );
      },
    },
    {
      name: 'get_realtime_quote', category: 'market',
      description: 'Read the latest available quote for one canonical symbol.',
      inputSchema: TOOL_SCHEMAS.get_realtime_quote,
      parseInput: (value) => parseSymbolOnlyInput('get_realtime_quote', value),
      execute: async (raw, context) => {
        const input = parseSymbolOnlyInput('get_realtime_quote', raw);
        return getJson(`/api/v1/quotes/realtime/${encodeURIComponent(input.symbol)}`, context);
      },
    },
    {
      name: 'get_price_history', category: 'market',
      description: 'Read recent daily bars (open/high/low/close/volume) for one canonical symbol.',
      inputSchema: TOOL_SCHEMAS.get_price_history,
      parseInput: (value) => parseSeriesInput('get_price_history', value),
      execute: async (raw, context) => {
        const input = parseSeriesInput('get_price_history', raw);
        return getJson(
          `/api/v1/quotes/history/${encodeURIComponent(input.symbol)}${queryString({ period: 'daily', adjustment: input.adjustment, limit: input.limit })}`,
          context,
        );
      },
    },
    {
      name: 'get_technical_indicators', category: 'market',
      description: 'Read moving averages, windowed returns, volatility and drawdown for one canonical symbol.',
      inputSchema: TOOL_SCHEMAS.get_technical_indicators,
      parseInput: (value) => parseSeriesInput('get_technical_indicators', value),
      execute: async (raw, context) => {
        const input = parseSeriesInput('get_technical_indicators', raw);
        return getJson(
          `/api/v1/indicators/technical/${encodeURIComponent(input.symbol)}${queryString({ period: 'daily', adjustment: input.adjustment, limit: input.limit })}`,
          context,
        );
      },
    },
    {
      name: 'get_universe_summary', category: 'market',
      description: 'Read A-share universe coverage: member count, latest trade date and data freshness.',
      inputSchema: TOOL_SCHEMAS.get_universe_summary,
      parseInput: parseUniverseSummaryInput,
      execute: async (raw, context) => {
        parseUniverseSummaryInput(raw);
        return getJson(`/api/v1/research/universes/summary${queryString({ universe_id: UNIVERSE_ID })}`, context);
      },
    },
    {
      name: 'get_universe_members', category: 'market',
      description: 'Page through A-share universe members.',
      inputSchema: TOOL_SCHEMAS.get_universe_members,
      parseInput: parseUniverseMembersInput,
      execute: async (raw, context) => {
        const input = parseUniverseMembersInput(raw);
        return getJson(
          `/api/v1/research/universes/${UNIVERSE_ID}/members${queryString({ page: input.page, page_size: input.page_size })}`,
          context,
        );
      },
    },
    {
      name: 'get_preset_candidates', category: 'market',
      description: 'Run one backend-maintained fixed screening mode and read its candidate table.',
      inputSchema: TOOL_SCHEMAS.get_preset_candidates,
      parseInput: parsePresetInput,
      execute: async (raw, context) => {
        const input = parsePresetInput(raw);
        return getJson(
          `/api/v1/research/screeners/a-share/short-term-candidates${queryString({ universe_id: UNIVERSE_ID, mode: input.mode, as_of: input.as_of, limit: input.limit })}`,
          context,
        );
      },
    },
    {
      name: 'screen_stocks', category: 'market',
      description: 'Run a custom allowlisted A-share screen built from the enumerated fields and operators.',
      inputSchema: TOOL_SCHEMAS.screen_stocks,
      parseInput: parseScreenInput,
      execute: async (raw, context) => {
        const input = parseScreenInput(raw);
        return callFastApi('/api/v1/research/screeners/a-share/query', {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: boundedJson(input),
        }, context);
      },
    },
  ];

  const terminalTool: RegisteredTool = {
    name: TERMINAL_TOOL_NAME, category: 'terminal',
    description: 'Submit the final evidence-backed analysis or insufficient-evidence result. Evidence must copy exact tool_call_id values from successful tool results. This ends the run.',
    inputSchema: TOOL_SCHEMAS.submit_analysis,
    terminal: true,
    parseInput: parseSubmission,
    execute: async (raw) => ok(parseSubmission(raw)),
  };

  return [...(skillToolsVisible ? skillTools : []), ...marketTools, terminalTool];
}

export function toolCategory(name: string): ToolCategory | undefined {
  if ((SKILL_TOOL_NAMES as readonly string[]).includes(name)) return 'skill';
  if ((MARKET_TOOL_NAMES as readonly string[]).includes(name)) return 'market';
  if (name === TERMINAL_TOOL_NAME) return 'terminal';
  return undefined;
}

export function publicToolResult(result: ToolResult): JsonValue {
  if (result.ok) return { ok: true, data: result.data as JsonValue };
  return {
    ok: false,
    error: {
      code: result.error.code,
      message: result.error.message,
      ...(result.error.details === undefined ? {} : { details: result.error.details }),
    },
  };
}
