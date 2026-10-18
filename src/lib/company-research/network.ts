import { lookup } from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import ipaddr from 'ipaddr.js';

export function publicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === 'unicast';
  } catch { return false; }
}
export async function validatePublicUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('仅允许公开 HTTP(S) 资料链接');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('拒绝访问内网或保留地址');
  url.hash = '';
  return { url, address: addresses[0] };
}
export async function boundedJson(response: Response, maxBytes = 3_000_000): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`外部接口 HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('外部接口未返回内容');
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > maxBytes) throw new Error('资料超过读取上限'); chunks.push(value);
  } } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Pin the validated DNS answer for the actual socket; revalidate each redirect. */
export async function downloadResearchOriginal(value: string, signal: AbortSignal, maxBytes = 15_000_000, redirects = 0): Promise<{ bytes: Buffer; url: string; mediaType: 'application/pdf' | 'text/html' }> {
  signal.throwIfAborted();
  if (redirects > 3) throw new Error('资料重定向过多');
  const { url, address } = await validatePublicUrl(value);
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, { signal, family: address.family,
      lookup: (_hostname, _options, cb) => cb(null, address.address, address.family), headers: { 'User-Agent': 'wolfbot-Research/1.0' } }, res => {
      if (res.statusCode && [301,302,303,307,308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location) { reject(new Error('PDF 缺少重定向地址')); return; }
        downloadResearchOriginal(new URL(res.headers.location, url).href, signal, maxBytes, redirects + 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`PDF HTTP ${res.statusCode}`)); return; }
      if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); reject(new Error('资料超过读取上限')); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) req.destroy(new Error('资料超过读取上限')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        const result = Buffer.concat(chunks), type = String(res.headers['content-type'] || '').split(';')[0].toLowerCase();
        if (result.subarray(0, 5).equals(Buffer.from('%PDF-')) && ['application/pdf', 'application/octet-stream', ''].includes(type)) resolve({ bytes: result, url: url.href, mediaType: 'application/pdf' });
        else if (type === 'text/html' && /<(?:!doctype\s+html|html|body)\b/i.test(result.subarray(0, 4096).toString('utf8')) && !result.includes(0)) resolve({ bytes: result, url: url.href, mediaType: 'text/html' });
        else reject(new Error('资料类型不支持或内容与类型不符'));
      });
    });
    req.on('error', reject);
  });
}
export async function downloadPdf(value: string, signal: AbortSignal, redirects = 0): Promise<Buffer> {
  const result = await downloadResearchOriginal(value, signal, 15_000_000, redirects);
  if (result.mediaType !== 'application/pdf') throw new Error('资料不是 PDF');
  return result.bytes;
}
