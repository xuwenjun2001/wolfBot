import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadResearchOriginal } from './network';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ default: { get: mocks.get } }));
afterEach(() => vi.clearAllMocks());
function response(status: number, headers: Record<string, string>, body = '') {
  mocks.get.mockImplementationOnce((_url, _opts, cb) => {
    const req = new EventEmitter() as EventEmitter & { destroy: (e: Error) => void };
    req.destroy = e => req.emit('error', e);
    queueMicrotask(() => {
      const res = Object.assign(new EventEmitter(), { statusCode: status, headers, resume() {}, destroy() {} });
      cb(res);
      queueMicrotask(() => { res.emit('data', Buffer.from(body)); res.emit('end'); });
    });
    return req;
  });
}
describe('bounded original download transport', () => {
  it('pins DNS and rechecks redirects including private destinations', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    response(302, { location: 'http://localhost/private.pdf' });
    await expect(downloadResearchOriginal('https://example.com/a.pdf', AbortSignal.timeout(1000))).rejects.toThrow('内网');
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const options = mocks.get.mock.calls[0][1];
    const callback = vi.fn(); options.lookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });
  it('enforces streamed byte limits and rejects mismatched types', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    response(200, { 'content-type': 'application/pdf' }, '%PDF-too-long');
    await expect(downloadResearchOriginal('https://example.com/a', AbortSignal.timeout(1000), 5)).rejects.toThrow('上限');
    response(200, { 'content-type': 'image/png' }, '%PDF-1.7');
    await expect(downloadResearchOriginal('https://example.com/a', AbortSignal.timeout(1000))).rejects.toThrow('类型');
    response(200, { 'content-type': 'text/html' }, '<html><body>report</body></html>');
    expect((await downloadResearchOriginal('https://example.com/a', AbortSignal.timeout(1000))).mediaType).toBe('text/html');
  });
});
