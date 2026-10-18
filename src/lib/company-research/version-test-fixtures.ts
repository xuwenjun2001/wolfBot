import { randomUUID } from 'node:crypto';
import { researchTaskSpecSchema, type ResearchTaskSpec } from './task-contracts';
import { researchDocumentSchema } from './document-contracts';
import { researchReportRevisionSchema } from './revision-contracts';

export const fixtureHash = 'a'.repeat(64);
export function specFixture(): ResearchTaskSpec {
  return researchTaskSpecSchema.parse({ schemaVersion: 1, kind: 'financial_change', requestRevision: 1,
    company: { symbol: '600519.SH', name: '贵州茅台', exchange: 'SH' },
    periods: [{ id: 'fy2023', start: '2023-01-01', end: '2023-12-31', kind: 'annual', basis: 'cumulative' },
      { id: 'fy2024', start: '2024-01-01', end: '2024-12-31', kind: 'annual', basis: 'cumulative' }],
    asOf: '2025-06-30T15:59:59.999Z', questions: [{ id: 'income_profit', text: '收入利润变化' }, { id: 'cash_flow', text: '现金流变化' }, { id: 'risks', text: '风险变化' }],
    scope: 'consolidated', currency: 'CNY', comparison: { status: 'comparable' }, budget: { maxToolCalls: 40, timeoutMs: 1200000 } });
}
export function documentFixture(taskId: string = randomUUID(), spec = specFixture()) {
  return researchDocumentSchema.parse({ schemaVersion: 1, id: 'annual-2024', taskId, version: 1, company: spec.company,
    period: spec.periods[1], title: '公开年报测试', url: 'https://static.cninfo.com.cn/test.pdf', bytesSha256: fixtureHash,
    fetchedAt: '2026-10-18T00:00:00Z', mediaType: 'application/pdf', disclosure: { status: 'verified', precision: 'date', on: '2025-04-03', timezone: 'Asia/Shanghai', evidenceUrl: 'https://www.cninfo.com.cn/', evidenceSha256: fixtureHash },
    original: { store: 'local', key: fixtureHash, sha256: fixtureHash, byteLength: 10 }, state: 'acquired', pageCount: 143 });
}
export function reportFixture(taskId: string = randomUUID(), spec = specFixture()) {
  const citation = { documentId: 'annual-2024', documentVersion: 1, bytesSha256: fixtureHash, locator: { kind: 'page' as const, filePage: 5 }, quote: '经营现金流原文测试' };
  return researchReportRevisionSchema.parse({ schemaVersion: 1, taskId, requestRevision: 1, planRevision: 1, revision: 1,
    companySymbol: spec.company.symbol, periodIds: spec.periods.map(p => p.id), asOf: spec.asOf, generatedAt: '2026-10-18T01:00:00Z', status: 'partial',
    facts: [{ id: 'cash2024', companySymbol: spec.company.symbol, period: spec.periods[1], metric: 'operating_cash_flow', scope: 'consolidated', restatement: 'original', value: { status: 'known', raw: '0', unit: 'yuan', currency: 'CNY', decimals: 2 }, citations: [citation] }],
    claims: [{ id: 'claim1', questionId: 'cash_flow', text: '需要对照另一期间', kind: 'fact', status: 'supported', factIds: ['cash2024'], citations: [citation] }],
    gaps: [{ code: 'evidence_gap', questionId: 'income_profit', message: '缺少其他事实，保留 partial' }] });
}
