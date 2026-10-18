import type { QuantGenerationTerminalSnapshot } from '@/lib/quant/generation-terminal';

export interface GenerationStatusError {
  kind: 'http' | 'network' | 'timeout' | 'invalid_response';
  status: number | null;
  message: string;
  retryable: boolean;
}

export type GenerationStatusReadResult =
  | { kind: 'success'; snapshot: QuantGenerationTerminalSnapshot }
  | { kind: 'error'; error: GenerationStatusError }
  | { kind: 'skipped' };

const TERMINAL_STATUSES = new Set([
  'idle', 'running', 'preview_pending', 'needs_revalidation', 'ready',
  'failed', 'cancelled', 'needs_clarification', 'refused',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseGenerationStatusResponse(value: unknown): QuantGenerationTerminalSnapshot | null {
  const envelope = record(value);
  const data = record(envelope?.data);
  if (!data || envelope?.success !== true ||
    typeof data.status !== 'string' || !TERMINAL_STATUSES.has(data.status) ||
    typeof data.terminal !== 'boolean' ||
    !['passed', 'failed', 'pending'].includes(String(data.validationStatus)) ||
    typeof data.validationMatchesCurrentRun !== 'boolean' ||
    typeof data.missionAcceptanceRequired !== 'boolean' ||
    typeof data.missionAcceptanceSatisfied !== 'boolean' ||
    !['starting', 'running', 'stopped', 'error'].includes(String(data.previewStatus)) ||
    !['requestId', 'validationRunId', 'acceptedReceiptId', 'previewUrl', 'persistedPreviewUrl', 'errorMessage']
      .every(key => data[key] === null || typeof data[key] === 'string') ||
    !(data.previewPort === null || (Number.isInteger(data.previewPort) && Number(data.previewPort) > 0 && Number(data.previewPort) <= 65535))) {
    return null;
  }
  return data as unknown as QuantGenerationTerminalSnapshot;
}

export function generationStatusRetryDelay(failureCount: number): number {
  return [2_000, 5_000, 10_000, 30_000][Math.min(Math.max(0, failureCount - 1), 3)];
}

function httpError(status: number): GenerationStatusError {
  const message = status === 401
    ? '登录状态已失效，请重新登录后重试。'
    : status === 403
      ? '当前账号无法读取任务状态，请确认访问权限后重试。'
      : status === 404
        ? '任务状态服务暂不可用，请重试。'
        : '暂时无法读取任务状态，正在重试。';
  return { kind: 'http', status, message, retryable: status >= 500 || status === 408 || status === 429 };
}

// The reader owns one request and its retry budget across React effect restarts.
export function createGenerationStatusReader(options: {
  url: string;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let disposed = false;
  let controller: AbortController | null = null;
  let inFlight: Promise<GenerationStatusReadResult> | null = null;
  let nextAttemptAt = 0;
  let stopped = false;
  let failures = 0;

  async function request(): Promise<GenerationStatusReadResult> {
    const currentController = new AbortController();
    controller = currentController;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      currentController.abort();
    }, options.timeoutMs ?? 10_000);
    let result: GenerationStatusReadResult;
    try {
      const response = await fetcher(options.url, { cache: 'no-store', signal: currentController.signal });
      if (!response.ok) {
        result = { kind: 'error', error: httpError(response.status) };
      } else {
        const payload: unknown = await response.json().catch(() => null);
        const snapshot = parseGenerationStatusResponse(payload);
        result = snapshot
          ? { kind: 'success', snapshot }
          : { kind: 'error', error: { kind: 'invalid_response', status: response.status, message: '任务状态响应异常，请重试。', retryable: true } };
      }
    } catch {
      result = { kind: 'error', error: {
        kind: timedOut ? 'timeout' : 'network', status: null,
        message: timedOut ? '读取任务状态超时，正在重试。' : '无法连接任务状态服务，正在重试。',
        retryable: true,
      } };
    } finally {
      clearTimeout(timer);
      if (controller === currentController) controller = null;
    }
    if (disposed || (currentController.signal.aborted && !timedOut)) return { kind: 'skipped' };
    if (timedOut) result = { kind: 'error', error: { kind: 'timeout', status: null, message: '读取任务状态超时，正在重试。', retryable: true } };
    if (result.kind === 'error') {
      failures += 1;
      stopped = !result.error.retryable;
      nextAttemptAt = now() + generationStatusRetryDelay(failures);
    } else {
      failures = 0;
      stopped = false;
      nextAttemptAt = 0;
    }
    return result;
  }

  return {
    read(force = false): Promise<GenerationStatusReadResult> {
      if (disposed) return Promise.resolve({ kind: 'skipped' });
      if (inFlight) return inFlight;
      if (!force && (stopped || now() < nextAttemptAt)) return Promise.resolve({ kind: 'skipped' });
      inFlight = request().finally(() => { inFlight = null; });
      return inFlight;
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
