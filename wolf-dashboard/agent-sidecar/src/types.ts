export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ModelRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  maxTokens?: number;
  temperature?: number;
  reasoning?: { enabled: boolean; effort?: 'low' | 'medium' | 'high' | 'max' };
  signal?: AbortSignal;
}

export type ModelEvent =
  | { type: 'response_start'; responseId: string; model: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_delta'; index: number; id?: string; nameDelta?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; rawReason?: string };

export type FinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'resource_exhausted'
  | 'other';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheMissInputTokens: number;
  reasoningTokens?: number;
  usageSource?: 'estimated' | 'cache_estimated' | 'mixed';
}

export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallContext {
  runId: string;
  turn: number;
  toolCallId: string;
  signal: AbortSignal;
}

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: JsonValue } };

/** Internal budget/artifact classification. Never sent to the provider. */
export type ToolCategory = 'skill' | 'market' | 'terminal';

export interface RegisteredTool extends ToolDefinition {
  category: ToolCategory;
  terminal?: boolean;
  parseInput?: (value: unknown) => unknown;
  execute(input: unknown, context: ToolCallContext): Promise<ToolResult>;
}

export interface RunLimits {
  maxTurns: number;
  maxTotalToolCalls: number;
  maxMarketRequests: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface SkillPackageInput {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  /** Optional metadata sent by FastAPI for routing and audit display. */
  scope?: string;
  applicable_scope?: string;
  source?: string;
  content_sha256?: string;
}

export interface RunRequest {
  runId: string;
  question: string;
  signal?: AbortSignal;
  systemPrompt?: string;
  selectedSkill?: string | null;
  skills?: SkillPackageInput[];
  maxTurns?: number;
  maxTotalToolCalls?: number;
  maxMarketRequests?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  reasoning?: { enabled?: boolean; effort?: 'low' | 'medium' | 'high' | 'max' };
  temperature?: number;
}

export interface AnalysisEvidence {
  toolCallId: string;
  summary: string;
  asOf?: string | null;
  source?: string;
}

export interface AnalysisSubmission {
  status: 'completed' | 'insufficient_evidence';
  answer: string;
  evidence: AnalysisEvidence[];
  dataAsOf?: string | null;
  limitations: string[];
  riskDisclaimer: string;
}

export interface PublicError {
  code: string;
  message: string;
}

export interface PublicEvent {
  type: string;
  runId: string;
  sequence: number;
  eventId: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface PublicRunResult {
  status: 'completed' | 'needs_configuration' | 'cancelled' | 'timeout' | 'failed';
  turns: number;
  usage: TokenUsage;
  startedAt: number;
  finishedAt: number;
  error?: PublicError;
  submission?: AnalysisSubmission;
}
