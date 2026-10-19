import { z } from 'zod';
import { artifactDigest } from './artifact-store';
import { boundedJson, downloadResearchOriginal } from './network';
import { marketGet, deepSeekTools } from './connectors';
import { documentAvailableAt, type ResearchDocument } from './document-contracts';
import { canonicalResearchJson, type ResearchTaskSpec } from './task-contracts';
import { researchEvidencePeriods } from './evidence-periods';

export interface FilingCandidate {
  id: string; periodId: string; title: string; url: string; provider: 'cninfo' | 'market' | 'deepseek' | 'manual';
  disclosure: ResearchDocument['disclosure']; dateClaims: { source: string; on: string }[]; warnings: string[];
  evidence: Buffer; evidenceUrl: string;
}
const cninfoQuery = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
const ref = (b: Buffer) => ({ store: 'local' as const, key: artifactDigest(b), sha256: artifactDigest(b), byteLength: b.length });
/** CNINFO midnight is a Shanghai calendar label, not a UTC calendar day or an exact publication instant. */
export function cninfoDisclosure(item: { announcementTime?: number }, evidence: Buffer, evidenceUrl: string, otherClaims: { source: string; on: string }[] = []): Pick<FilingCandidate, 'disclosure' | 'dateClaims' | 'warnings'> {
  const epoch = item.announcementTime;
  if (!epoch || !Number.isFinite(epoch) || epoch < 946684800000 || epoch > 4102444800000) return { disclosure: { status: 'unknown', reason: '公告记录没有有效披露日期' }, dateClaims: otherClaims, warnings: ['disclosure_unknown'] };
  const on = new Date(epoch + 8 * 3600000).toISOString().slice(0, 10);
  const dateClaims = [{ source: 'cninfo:announcementTime:Asia/Shanghai', on }, ...otherClaims];
  if (otherClaims.some(c => c.on !== on)) return { disclosure: { status: 'unknown', reason: '独立披露日期依据冲突，待核查' }, dateClaims, warnings: ['disclosure_conflict'] };
  return { disclosure: { status: 'verified', precision: 'date', on, timezone: 'Asia/Shanghai', evidenceUrl, evidenceSha256: artifactDigest(evidence) }, dateClaims, warnings: [] };
}
function periodForTitle(spec: ResearchTaskSpec, title: string) {
  if (/摘要|取消|英文|提示性/.test(title)) return;
  return researchEvidencePeriods(spec).find(p => p.basis === 'cumulative' && title.includes(p.end.slice(0, 4)) && (p.kind === 'annual' ? /年度报告/.test(title) && !/半年度/.test(title) : p.kind === 'interim' ? /半年度报告/.test(title) : /季度报告/.test(title) && (p.end.slice(5, 7) === '03' ? /[一1]季度/.test(title) : p.end.slice(5, 7) === '09' ? /[三3]季度/.test(title) : false)));
}
export async function discoverResearchFilings(spec: ResearchTaskSpec, signal: AbortSignal, page = 1) {
  z.number().int().min(1).max(100).parse(page);
  const candidates: FilingCandidate[] = [], failures: string[] = [];
  const code = spec.company.symbol.slice(0, 6);
  try {
    // Resolve the real issuer ID; the historic gssh/gssz rule is not reliable for all issuers.
    const stocks = await boundedJson(await fetch('https://www.cninfo.com.cn/new/data/szse_stock.json', { signal, redirect: 'error' }), 8_000_000) as { stockList?: { code: string; orgId: string }[] };
    const issuer = spec.company.issuerId || stocks.stockList?.find(s => s.code === code)?.orgId;
    if (!issuer) throw new Error('未解析到巨潮发行人 ID');
    const data = await boundedJson(await fetch(cninfoQuery, { method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.cninfo.com.cn/' },
      body: new URLSearchParams({ stock: `${code},${issuer}`, tabName: 'fulltext', pageSize: '30', pageNum: String(page), column: '', category: '', plate: '', seDate: `${spec.periods[0].end.slice(0, 4)}-01-01~${new Date().toISOString().slice(0, 10)}`, searchkey: spec.periods.every(p => p.kind === 'annual') ? '年度报告' : '报告', isHLtitle: 'false' }),
    })) as { announcements?: { secCode: string; announcementId: string; announcementTitle: string; announcementTime: number; adjunctUrl: string }[]; hasMore?: boolean };
    for (const item of data.announcements || []) {
      if (item.secCode !== code || !/^finalpage\/[\w/.-]+\.pdf$/i.test(item.adjunctUrl)) continue;
      const title = item.announcementTitle.replace(/<[^>]*>/g, ''), period = periodForTitle(spec, title);
      if (!period) continue;
      const evidence = Buffer.from(canonicalResearchJson(item));
      candidates.push({ id: `cninfo-${item.announcementId}`, periodId: period.id, title, url: `https://static.cninfo.com.cn/${item.adjunctUrl}`, provider: 'cninfo', evidence, evidenceUrl: cninfoQuery, ...cninfoDisclosure(item, evidence, cninfoQuery) });
    }
    return { candidates, failures, hasMore: !!data.hasMore, page };
  } catch (error) { signal.throwIfAborted(); failures.push(`cninfo: ${error instanceof Error ? error.message : 'unavailable'}`); }
  try {
    const data = await marketGet(`events/announcements/${encodeURIComponent(spec.company.symbol)}?limit=100&page=${page}`, signal) as { announcements?: { title: string; symbol?: string; pdf_url?: string; url?: string; notice_date?: string }[]; has_more?: boolean };
    for (const item of data.announcements || []) {
      const period = periodForTitle(spec, item.title), url = item.pdf_url || item.url;
      if (!period || !url || (item.symbol && item.symbol.slice(0, 6) !== code)) continue;
      candidates.push({ id: `market-${artifactDigest(url).slice(0, 20)}`, periodId: period.id, title: item.title, url, provider: 'market', evidence: Buffer.from(canonicalResearchJson(item)), evidenceUrl: url,
        disclosure: { status: 'unknown', reason: '聚合公告日期尚无独立原始披露依据' }, dateClaims: item.notice_date && /^\d{4}-\d{2}-\d{2}/.test(item.notice_date) ? [{ source: 'market:notice_date', on: item.notice_date.slice(0, 10) }] : [], warnings: ['disclosure_unverified'] });
    }
    return { candidates, failures, hasMore: !!data.has_more, page };
  } catch (error) { signal.throwIfAborted(); failures.push(`market: ${error instanceof Error ? error.message : 'unavailable'}`); }
  const data = await deepSeekTools('search', { query: `${code} ${spec.periods.map(p => p.end.slice(0, 4)).join(' ')} 年度报告 site:cninfo.com.cn`, count: 5, need_content: false }, signal) as { results?: { title: string; url: string }[] };
  for (const item of data.results || []) {
    const period = periodForTitle(spec, item.title); if (!period) continue;
    candidates.push({ id: `search-${artifactDigest(item.url).slice(0, 20)}`, periodId: period.id, title: item.title, url: item.url, provider: 'deepseek', evidence: Buffer.from(canonicalResearchJson(item)), evidenceUrl: item.url, disclosure: { status: 'unknown', reason: '搜索结果不构成披露时点证明' }, dateClaims: [], warnings: ['search_link_only'] });
  }
  return { candidates, failures, hasMore: false, page };
}
export function documentEligibility(doc: Pick<ResearchDocument, 'disclosure'>, asOf: string) {
  return doc.disclosure.status === 'unknown' ? 'date_unverified' : documentAvailableAt(doc, asOf) ? 'available' : 'after_cutoff';
}
export async function acquireFiling(taskId: string, spec: ResearchTaskSpec, candidate: FilingCandidate, version: number, signal: AbortSignal) {
  const period = researchEvidencePeriods(spec).find(p => p.id === candidate.periodId); if (!period) throw new Error('资料期间不属于任务');
  const downloaded = await downloadResearchOriginal(candidate.url, AbortSignal.any([signal, AbortSignal.timeout(60000)]), 50_000_000);
  const document: ResearchDocument = { schemaVersion: 1, id: candidate.id, taskId, version, company: spec.company, period, title: candidate.title, url: candidate.url,
    mediaType: downloaded.mediaType, bytesSha256: artifactDigest(downloaded.bytes), fetchedAt: new Date().toISOString(), disclosure: candidate.disclosure, original: ref(downloaded.bytes), state: 'acquired',
    provenance: { provider: candidate.provider, finalUrl: downloaded.url, evidence: ref(candidate.evidence), dateClaims: candidate.dateClaims, warnings: candidate.warnings } };
  return { document, original: downloaded.bytes, evidence: candidate.evidence, eligibility: documentEligibility(document, spec.asOf) };
}
