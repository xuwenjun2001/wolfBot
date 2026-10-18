import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenerationStatusReader, generationStatusRetryDelay, parseGenerationStatusResponse } from './generation-status-client';

const snapshot = {
  requestId: 'request-1', status: 'ready', terminal: true,
  validationStatus: 'passed', validationRunId: 'request-1', validationMatchesCurrentRun: true,
  missionAcceptanceRequired: true, missionAcceptanceSatisfied: true,
  acceptedReceiptId: 'receipt-1', previewStatus: 'running', previewUrl: 'http://localhost:4115',
  previewPort: 4115, persistedPreviewUrl: 'http://localhost:4115', errorMessage: null,
};
const validResponse = () => Response.json({ success: true, data: snapshot });
const options = { url: 'http://localhost/api/projects/project-1/generation/status' };

afterEach(() => { vi.useRealTimers(); });

describe('generation status responses', () => {
  it('requires a valid envelope and complete acceptance fields', () => {
    expect(parseGenerationStatusResponse({ success: true, data: snapshot })).toEqual(snapshot);
    for (const invalid of [null, {}, { success: false, data: snapshot }, { success: true, data: { ...snapshot, missionAcceptanceSatisfied: undefined } }, { success: true, data: { ...snapshot, previewUrl: 123 } }]) {
      expect(parseGenerationStatusResponse(invalid)).toBeNull();
    }
  });

  it.each([401, 403, 404])('stops automatic reads after HTTP %i and permits a manual retry', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html>error</html>', { status })).mockResolvedValueOnce(validResponse());
    const reader = createGenerationStatusReader({ ...options, fetcher });
    expect(await reader.read()).toMatchObject({ kind: 'error', error: { kind: 'http', status, retryable: false } });
    expect(await reader.read()).toEqual({ kind: 'skipped' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await reader.read(true)).toEqual({ kind: 'success', snapshot });
    reader.dispose();
  });

  it('backs off failed requests and resets the delay after recovery', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 500 }));
    const reader = createGenerationStatusReader({ ...options, fetcher, now: () => now });
    for (const delay of [2000, 5000, 10000, 30000, 30000]) {
      expect(await reader.read()).toMatchObject({ kind: 'error', error: { retryable: true } });
      now += delay - 1;
      expect(await reader.read()).toEqual({ kind: 'skipped' });
      now += 1;
    }
    fetcher.mockResolvedValueOnce(validResponse());
    expect(await reader.read()).toEqual({ kind: 'success', snapshot });
    expect(await reader.read()).toMatchObject({ kind: 'error' });
    now += 2000;
    expect(await reader.read()).toMatchObject({ kind: 'error' });
    expect(generationStatusRetryDelay(1)).toBe(2000);
    reader.dispose();
  });

  it.each(['invalid JSON', 'invalid contract', 'network'])('surfaces %s instead of silently keeping a running state', async (kind) => {
    const fetcher = vi.fn<typeof fetch>();
    if (kind === 'network') fetcher.mockRejectedValue(new TypeError('Failed to fetch'));
    else fetcher.mockResolvedValue(kind === 'invalid JSON' ? new Response('<html/>') : Response.json({ success: true, data: {} }));
    const reader = createGenerationStatusReader({ ...options, fetcher });
    expect(await reader.read()).toMatchObject({ kind: 'error', error: { kind: kind === 'network' ? 'network' : 'invalid_response', retryable: true } });
    reader.dispose();
  });

  it('shares one in-flight request between polling, reconciliation, and retry', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(done => { resolve = done; }));
    const reader = createGenerationStatusReader({ ...options, fetcher });
    const first = reader.read();
    expect(reader.read()).toBe(first);
    expect(reader.read(true)).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(validResponse());
    expect(await first).toEqual({ kind: 'success', snapshot });
    reader.dispose();
  });

  it('aborts after the deadline and exposes a retryable timeout', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const reader = createGenerationStatusReader({ ...options, fetcher });
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ kind: 'error', error: { kind: 'timeout', retryable: true } });
    reader.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores late responses after leaving the project, even if fetch ignores abort', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(done => { resolve = done; }));
    const reader = createGenerationStatusReader({ ...options, fetcher });
    const pending = reader.read();
    reader.dispose();
    resolve(validResponse());
    expect(await pending).toEqual({ kind: 'skipped' });
    expect(await reader.read(true)).toEqual({ kind: 'skipped' });
  });
});
