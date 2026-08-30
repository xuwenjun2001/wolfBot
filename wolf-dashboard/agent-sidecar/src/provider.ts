import type {
  ChatMessage,
  FinishReason,
  ModelProvider,
  ModelRequest,
  ModelEvent,
  TokenUsage,
  ToolDefinition,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_REQUEST_BYTES = 2_000_000;
const MAX_ERROR_BODY_BYTES = 16_384;
const MAX_STREAM_BYTES = 8_000_000;
const MAX_SSE_FRAME_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 128_000;
const MAX_TOOL_ARGUMENT_CHARS = 64_000;
const MAX_TOOL_CALLS = 32;

export type ProviderErrorCode =
  | 'NEEDS_CONFIGURATION'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'PROTOCOL_ERROR'
  | 'REQUEST_TOO_LARGE';

export class OpenAICompatibleProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, status?: number, cause?: unknown) {
    super(message, { cause });
    this.name = 'OpenAICompatibleProviderError';
    this.code = code;
    this.status = status;
  }
}

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | '';
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

interface StreamChunk {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizeFinishReason(value: string): FinishReason {
  switch (value) {
    case 'stop': return 'stop';
    case 'tool_calls':
    case 'function_call': return 'tool_calls';
    case 'length': return 'length';
    case 'content_filter': return 'content_filter';
    case 'insufficient_system_resource': return 'resource_exhausted';
    default: return 'other';
  }
}

function completionUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('OPENAI_BASE_URL cannot be empty.');
  const url = new URL(normalized);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OPENAI_BASE_URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('OPENAI_BASE_URL must not contain credentials or a fragment.');
  }
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function serializeMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
  }
}

function serializeToolChoice(choice: ModelRequest['toolChoice']): unknown {
  if (choice === undefined || typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = safePositiveInteger(value.prompt_tokens);
  const output = safePositiveInteger(value.completion_tokens);
  const total = safePositiveInteger(value.total_tokens);
  if (input === undefined || output === undefined || total === undefined || total !== input + output) {
    return undefined;
  }
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined;
  const cached = details ? safePositiveInteger(details.cached_tokens) : undefined;
  if (cached !== undefined && cached > input) return undefined;
  const completionDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : undefined;
  const reasoning = completionDetails
    ? safePositiveInteger(completionDetails.reasoning_tokens)
    : undefined;
  if (reasoning !== undefined && reasoning > output) return undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedInputTokens: cached ?? 0,
    cacheMissInputTokens: cached === undefined ? input : input - cached,
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cached === undefined ? { usageSource: 'cache_estimated' as const } : {}),
  };
}

function estimateTokens(request: ModelRequest, textChars: number, toolChars: number): TokenUsage {
  const inputBytes = Buffer.byteLength(JSON.stringify({
    messages: request.messages.map(serializeMessage),
    tools: request.tools,
  }), 'utf8');
  const inputTokens = Math.max(1, Math.ceil(inputBytes / 4));
  const outputTokens = Math.max(0, Math.ceil((textChars + toolChars) / 4));
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens: 0,
    cacheMissInputTokens: inputTokens,
    usageSource: 'estimated',
  };
}

async function readBoundedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = MAX_ERROR_BODY_BYTES - bytes;
      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(accepted);
      bytes += accepted.byteLength;
      if (accepted.byteLength < value.byteLength) {
        await reader.cancel('error body limit').catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        complete = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_STREAM_BYTES) {
        await reader.cancel('stream byte limit').catch(() => undefined);
        throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider stream exceeded its byte limit.');
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_FRAME_CHARS) {
        throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider SSE frame exceeded its character limit.');
      }
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.length > MAX_SSE_FRAME_CHARS) {
          throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider SSE frame exceeded its character limit.');
        }
        const data = frame.split('\n')
          .filter((line) => line === 'data' || line.startsWith('data:'))
          .map((line) => line === 'data' ? '' : line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) {
      const data = buffer.split('\n')
        .filter((line) => line === 'data' || line.startsWith('data:'))
        .map((line) => line === 'data' ? '' : line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  } finally {
    if (!complete) await reader.cancel('provider stream consumer stopped').catch(() => undefined);
    reader.releaseLock();
  }
}

function asChunk(value: unknown): StreamChunk {
  if (!isRecord(value)) throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider returned a non-object response chunk.');
  return value as StreamChunk;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  readonly model: string;
  readonly baseUrl: string;
  readonly configured: boolean;
  private readonly apiKey: string;
  private readonly reasoningEffort: OpenAICompatibleProviderOptions['reasoningEffort'];
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
    this.configured = Boolean(this.apiKey);
    this.baseUrl = completionUrl(options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL);
    this.model = (options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini').trim();
    const effort = (options.reasoningEffort ?? process.env.OPENAI_REASONING_EFFORT ?? '').trim();
    if (effort && !['low', 'medium', 'high', 'max'].includes(effort)) {
      throw new Error('OPENAI_REASONING_EFFORT must be low, medium, high, or max.');
    }
    this.reasoningEffort = effort as OpenAICompatibleProviderOptions['reasoningEffort'];
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    if (!this.model) throw new Error('OPENAI_MODEL cannot be empty.');
  }

  async *complete(request: ModelRequest): AsyncGenerator<ModelEvent> {
    if (!this.apiKey) {
      throw new OpenAICompatibleProviderError(
        'NEEDS_CONFIGURATION',
        'OPENAI_API_KEY is not configured.',
      );
    }
    const body: Record<string, unknown> = {
      model: request.model || this.model,
      messages: request.messages.map(serializeMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((tool: ToolDefinition) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = serializeToolChoice(request.toolChoice ?? 'auto');
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    const reasoningEffort = this.reasoningEffort || request.reasoning?.effort;
    if (reasoningEffort && request.reasoning?.enabled !== false) {
      body.reasoning_effort = reasoningEffort;
    }
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
      throw new OpenAICompatibleProviderError('REQUEST_TOO_LARGE', 'Provider request exceeded its byte limit.');
    }
    const headers = new Headers({
      Accept: 'text/event-stream',
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    });
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers,
        body: serialized,
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw new OpenAICompatibleProviderError('NETWORK_ERROR', 'Provider request failed before a response was received.', undefined, error);
    }
    if (!response.ok) {
      await readBoundedText(response.body);
      throw new OpenAICompatibleProviderError('HTTP_ERROR', `Provider request failed with HTTP ${response.status}.`, response.status);
    }
    if (!response.body) throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider returned no response body.');

    let responseId: string | undefined;
    let responseModel = request.model || this.model;
    let finishReason: FinishReason | undefined;
    let usage: TokenUsage | undefined;
    let textChars = 0;
    let toolChars = 0;
    let sawDone = false;
    const toolCalls = new Map<number, ToolCallState>();
    const contentType = response.headers.get('content-type') ?? '';
    const dataStream = contentType.includes('text/event-stream')
      ? readSseData(response.body)
      : (async function* (): AsyncGenerator<string> {
          yield await readBoundedText(response.body);
        })();

    for await (const raw of dataStream) {
      if (raw.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      let chunk: StreamChunk;
      try {
        chunk = asChunk(JSON.parse(raw));
      } catch (error) {
        if (error instanceof OpenAICompatibleProviderError) throw error;
        throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider returned malformed JSON.', undefined, error);
      }
      const id = typeof chunk.id === 'string' && chunk.id.trim() ? chunk.id : undefined;
      const semantic = chunk.usage !== undefined || (Array.isArray(chunk.choices) && chunk.choices.length > 0);
      if (semantic && !id && !responseId) {
        throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider response chunk has no response ID.');
      }
      if (id && responseId && id !== responseId) {
        throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider changed response ID within one response.');
      }
      if (!responseId && id) {
        responseId = id;
        if (typeof chunk.model === 'string' && chunk.model.trim()) responseModel = chunk.model;
        yield { type: 'response_start', responseId, model: responseModel };
      }
      const parsedUsage = parseUsage(chunk.usage);
      if (chunk.usage !== undefined && parsedUsage === undefined) {
        throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider returned inconsistent token usage.');
      }
      if (parsedUsage) {
        usage = parsedUsage;
        yield { type: 'usage', usage };
      }
      if (!Array.isArray(chunk.choices)) continue;
      for (const rawChoice of chunk.choices) {
        if (!isRecord(rawChoice) || rawChoice.index !== 0) {
          throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider returned an invalid choice index.');
        }
        const delta = isRecord(rawChoice.delta)
          ? rawChoice.delta
          : isRecord(rawChoice.message)
            ? rawChoice.message
            : undefined;
        if (typeof delta?.content === 'string' && delta.content) {
          textChars += delta.content.length;
          if (textChars > MAX_TEXT_CHARS) throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider response text exceeded its limit.');
          yield { type: 'text_delta', delta: delta.content };
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const [position, rawCall] of delta.tool_calls.entries()) {
            if (!isRecord(rawCall)) {
              throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider returned an invalid tool-call index.');
            }
            const index = rawCall.index === undefined
              ? position
              : typeof rawCall.index === 'number'
                ? rawCall.index
                : Number.NaN;
            if (!Number.isSafeInteger(index) || index < 0) {
              throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider returned an invalid tool-call index.');
            }
            let call = toolCalls.get(index);
            if (!call) {
              if (toolCalls.size >= MAX_TOOL_CALLS) throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider returned too many tool calls.');
              const idValue = typeof rawCall.id === 'string' && rawCall.id.trim() ? rawCall.id : '';
              if (!idValue) throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider started a tool call without an ID.');
              call = { id: idValue, name: '', arguments: '' };
              toolCalls.set(index, call);
            } else if (typeof rawCall.id === 'string' && rawCall.id.trim() && rawCall.id !== call.id) {
              throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider changed a tool-call ID.');
            }
            const fn = isRecord(rawCall.function) ? rawCall.function : undefined;
            const nameDelta = typeof fn?.name === 'string' ? fn.name : '';
            const argumentsDelta = typeof fn?.arguments === 'string' ? fn.arguments : '';
            call.name += nameDelta;
            call.arguments += argumentsDelta;
            toolChars += nameDelta.length + argumentsDelta.length;
            if (call.name.length > 256) throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider tool name exceeded its limit.');
            if (call.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider tool arguments exceeded their limit.');
            yield {
              type: 'tool_call_delta',
              index,
              ...(typeof rawCall.id === 'string' ? { id: rawCall.id } : {}),
              ...(nameDelta ? { nameDelta } : {}),
              ...(argumentsDelta ? { argumentsDelta } : {}),
            };
          }
        }
        if (typeof rawChoice.finish_reason === 'string' && rawChoice.finish_reason) {
          finishReason = normalizeFinishReason(rawChoice.finish_reason);
        }
      }
    }
    if (contentType.includes('text/event-stream') && !sawDone) {
      throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider stream ended without [DONE].');
    }
    if (!finishReason) throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider stream ended without a finish reason.');
    if (!responseId) {
      throw new OpenAICompatibleProviderError('PROTOCOL_ERROR', 'Provider response did not contain an ID.');
    }
    if (!usage) {
      usage = estimateTokens(request, textChars, toolChars);
      yield { type: 'usage', usage };
    }
    yield { type: 'finish', reason: finishReason, rawReason: finishReason };
  }
}
