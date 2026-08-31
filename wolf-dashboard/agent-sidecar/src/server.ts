import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { OpenAICompatibleProvider } from './provider.js';
import {
  PI_AGENT_CORE_PACKAGE,
  PI_AI_PACKAGE,
  PI_AGENT_VERSION,
  SIDECAR_VERSION,
  SidecarRunEngine,
} from './run-engine.js';
import { createGovernedTools } from './tools.js';
import type {
  RunRequest,
  SkillPackageInput,
  ModelProvider,
  PublicEvent,
} from './types.js';

export const SIDECAR_HOST = '127.0.0.1' as const;
export const SIDECAR_PORT = 8790 as const;
const MAX_REQUEST_BYTES = 2_000_000;

export interface SidecarServerOptions {
  provider?: ModelProvider;
  model?: string;
  fetchImpl?: typeof fetch;
  host?: string;
  port?: number;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Request body exceeded the size limit.');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function boundedString(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) throw new Error(`${name} must be a bounded string.`);
  return value;
}

function positiveLimit(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function parseSkills(value: unknown): SkillPackageInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) throw new Error('skills must be a bounded array.');
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!isRecord(raw)) throw new Error('skill descriptor must be an object.');
    const allowedKeys = new Set([
      'id', 'name', 'version', 'description', 'enabled',
      'scope', 'applicable_scope', 'source', 'content_sha256',
    ]);
    if (Object.keys(raw).some((key) => !allowedKeys.has(key))) throw new Error('skill descriptor contains an unsupported field.');
    const id = boundedString(raw.id, 'skill id', 128, true)!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('skill id has an invalid format.');
    if (ids.has(id)) throw new Error('skill ids must be unique.');
    ids.add(id);
    const name = boundedString(raw.name, 'skill name', 256, true)!;
    const version = boundedString(raw.version, 'skill version', 64, true)!;
    const description = boundedString(raw.description, 'skill description', 2_000);
    const scope = boundedString(raw.scope, 'skill scope', 256);
    const applicableScope = boundedString(raw.applicable_scope, 'skill applicable_scope', 512);
    const source = boundedString(raw.source, 'skill source', 128);
    const contentSha256 = boundedString(raw.content_sha256, 'skill content_sha256', 128);
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('skill enabled must be boolean.');
    return {
      id,
      name,
      version,
      ...(description === undefined ? {} : { description }),
      ...(scope === undefined ? {} : { scope }),
      ...(applicableScope === undefined ? {} : { applicable_scope: applicableScope }),
      ...(source === undefined ? {} : { source }),
      ...(contentSha256 === undefined ? {} : { content_sha256: contentSha256 }),
      enabled: raw.enabled !== false,
    };
  });
}

function parseRunRequest(body: unknown, signal: AbortSignal): RunRequest {
  if (!isRecord(body)) throw new Error('Run request must be a JSON object.');
  const known = new Set(['run_id', 'runId', 'question', 'prompt', 'system_prompt', 'systemPrompt', 'selected_skill', 'selectedSkill', 'skills', 'max_turns', 'maxTurns', 'max_total_tool_calls', 'maxTotalToolCalls', 'max_market_requests', 'maxMarketRequests', 'max_output_tokens', 'maxOutputTokens', 'timeout_ms', 'timeoutMs', 'reasoning', 'temperature']);
  for (const key of Object.keys(body)) if (!known.has(key)) throw new Error(`Unsupported run request field: ${key}.`);
  const runId = boundedString(body.run_id ?? body.runId, 'run_id', 256, true)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(runId)) throw new Error('run_id has an invalid format.');
  const question = boundedString(body.question ?? body.prompt, 'question', 32_000, true)!;
  const systemPrompt = boundedString(body.system_prompt ?? body.systemPrompt, 'system_prompt', 64_000);
  const selectedSkillValue = body.selected_skill ?? body.selectedSkill;
  if (selectedSkillValue !== undefined && selectedSkillValue !== null && typeof selectedSkillValue !== 'string') throw new Error('selected_skill must be a string or null.');
  const reasoning = body.reasoning === undefined ? undefined : (() => {
    if (!isRecord(body.reasoning)) throw new Error('reasoning must be an object.');
    if (body.reasoning.enabled !== undefined && typeof body.reasoning.enabled !== 'boolean') throw new Error('reasoning.enabled must be boolean.');
    if (body.reasoning.effort !== undefined && !['low', 'medium', 'high', 'max'].includes(String(body.reasoning.effort))) throw new Error('reasoning.effort is invalid.');
    return { ...(body.reasoning.enabled === undefined ? {} : { enabled: body.reasoning.enabled }), ...(body.reasoning.effort === undefined ? {} : { effort: body.reasoning.effort as 'low' | 'medium' | 'high' | 'max' }) };
  })();
  if (body.temperature !== undefined && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw new Error('temperature must be between 0 and 2.');
  const skills = parseSkills(body.skills);
  const maxTurns = positiveLimit(body.max_turns ?? body.maxTurns, 'max_turns');
  const maxTotalToolCalls = positiveLimit(body.max_total_tool_calls ?? body.maxTotalToolCalls, 'max_total_tool_calls');
  const maxMarketRequests = positiveLimit(body.max_market_requests ?? body.maxMarketRequests, 'max_market_requests');
  const maxOutputTokens = positiveLimit(body.max_output_tokens ?? body.maxOutputTokens, 'max_output_tokens');
  const timeoutMs = positiveLimit(body.timeout_ms ?? body.timeoutMs, 'timeout_ms');
  return {
    runId,
    question,
    signal,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(selectedSkillValue === undefined ? {} : { selectedSkill: selectedSkillValue as string | null }),
    ...(skills === undefined ? {} : { skills }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxTotalToolCalls === undefined ? {} : { maxTotalToolCalls }),
    ...(maxMarketRequests === undefined ? {} : { maxMarketRequests }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
  };
}

export function createSidecarServer(options: SidecarServerOptions = {}): Server {
  const provider = options.provider ?? new OpenAICompatibleProvider({ fetchImpl: options.fetchImpl });
  const model = options.model ?? (provider instanceof OpenAICompatibleProvider ? provider.model : process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
  let active: ActiveRun | undefined;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', `http://${SIDECAR_HOST}:${options.port ?? SIDECAR_PORT}`).pathname;
    if (method === 'GET' && path === '/healthz') {
      jsonResponse(res, 200, {
        status: 'ok',
        service: 'wolfbot-agent-sidecar',
        version: SIDECAR_VERSION,
        agent: { name: 'pi-agent', version: PI_AGENT_VERSION },
        sdk: { core: PI_AGENT_CORE_PACKAGE, ai: PI_AI_PACKAGE, version: PI_AGENT_VERSION },
        identity: `pi-agent:${PI_AGENT_VERSION}`,
        pi_agent_version: PI_AGENT_VERSION,
        provider: { name: provider.name, configured: provider instanceof OpenAICompatibleProvider ? provider.configured : true },
        listen: { host: SIDECAR_HOST, port: options.port ?? SIDECAR_PORT },
      });
      return;
    }
    const cancelMatch = path.match(/^\/internal\/v1\/runs\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const runId = decodeURIComponent(cancelMatch[1]);
      if (!active || active.runId !== runId) {
        jsonResponse(res, 404, { error: { code: 'RUN_NOT_FOUND', message: 'Run is not active.' } });
        return;
      }
      active.controller.abort(new DOMException('Run cancelled by caller.', 'AbortError'));
      jsonResponse(res, 202, { run_id: runId, status: 'cancellation_requested' });
      return;
    }
    if (method === 'POST' && path === '/internal/v1/runs') {
      if (active) {
        jsonResponse(res, 409, { error: { code: 'RUN_ACTIVE', message: 'Another run is already active.' }, run_id: active.runId });
        return;
      }
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (error) {
        jsonResponse(res, 400, { error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid request.' } });
        return;
      }
      const controller = new AbortController();
      let request: RunRequest;
      try {
        request = parseRunRequest(body, controller.signal);
        if (request.selectedSkill && request.selectedSkill !== 'none' && !(request.skills ?? []).some((skill) => skill.id === request.selectedSkill && skill.enabled !== false)) {
          throw new Error('selected_skill is not present in enabled skills.');
        }
      } catch (error) {
        jsonResponse(res, 400, { error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid run request.' } });
        return;
      }
      active = { runId: request.runId, controller };
      const requestClosed = () => {
        if (!res.writableEnded && !controller.signal.aborted) controller.abort(new DOMException('Client disconnected.', 'AbortError'));
      };
      req.once('aborted', requestClosed);
      res.once('close', requestClosed);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const sink = async (event: PublicEvent): Promise<void> => {
        if (res.writableEnded || res.destroyed) return;
        const line = `${JSON.stringify(event)}\n`;
        if (!res.write(line)) await new Promise<void>((resolve) => res.once('drain', resolve));
      };
      try {
        const engine = new SidecarRunEngine({
          provider,
          model,
          tools: createGovernedTools({ skills: request.skills, selectedSkill: request.selectedSkill, fetchImpl: options.fetchImpl }),
        });
        await engine.run(request, sink);
      } catch {
        if (!res.writableEnded && !res.destroyed) {
          await sink({
            type: 'run_failed', runId: request.runId, sequence: 0, eventId: `${request.runId}:transport-error`, timestamp: Date.now(),
            error: { code: 'RUN_FAILED', message: 'Sidecar could not start the run.' },
          });
        }
      } finally {
        if (active?.runId === request.runId) active = undefined;
        if (!res.writableEnded) res.end();
      }
      return;
    }
    if (path.startsWith('/internal/')) {
      jsonResponse(res, 404, { error: { code: 'NOT_FOUND', message: 'Sidecar endpoint not found.' } });
      return;
    }
    jsonResponse(res, 404, { error: { code: 'NOT_FOUND', message: 'Sidecar endpoint not found.' } });
  };

  return createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) jsonResponse(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Sidecar request failed.' } });
      else if (!res.writableEnded) res.end();
    });
  });
}
