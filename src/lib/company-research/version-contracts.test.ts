import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { researchTaskSpecSchema, researchTaskRevisionChangesSchema, researchRequestHash, researchPlanSchema, assertPlanForSpec } from './task-contracts';
import { researchDocumentSchema, documentAvailableAt, financialFactSchema } from './document-contracts';
import { researchReportRevisionSchema, reportBindingErrors, researchEventSchema } from './revision-contracts';
import { readResearchReport, readResearchRequest } from './compatibility';
import { emptyReport } from './contracts';
import { documentFixture, fixtureHash, reportFixture, specFixture } from './version-test-fixtures';

describe('financial change version contracts', () => {
  it('keeps legacy requests/reports readable and rejects unknown new versions', () => {
    expect(readResearchRequest({ symbol: '600519' }).format).toBe('legacy');
    expect(readResearchReport(emptyReport('旧报告')).format).toBe('legacy');
    expect(readResearchRequest(specFixture()).format).toBe('financial_change_v1');
    expect(() => readResearchRequest({ ...specFixture(), schemaVersion: 2 })).toThrow();
    expect(() => readResearchReport({ ...emptyReport('旧报告'), schemaVersion: 99 })).toThrow();
  });
  it('hashes the complete validated request independently of JSON key order', () => {
    const spec = specFixture(), first = researchRequestHash(spec);
    expect(researchRequestHash(Object.fromEntries(Object.entries(spec).reverse()))).toBe(first);
    for (const changed of [{ ...spec, asOf: '2025-07-01T00:00:00Z' }, { ...spec, scope: 'parent' },
      { ...spec, requestRevision: 2 }, { ...spec, budget: { ...spec.budget, maxToolCalls: 39 } },
      { ...spec, questions: spec.questions.map(q => ({ ...q, text: q.text + '重点' })) }]) expect(researchRequestHash(changed)).not.toBe(first);
    expect(() => researchRequestHash({ ...spec, actorId: 'attacker' })).toThrow();
  });
  it('limits revisions to research questions, periods and as-of without changing the company or budget', () => {
    const spec = specFixture();
    expect(researchTaskRevisionChangesSchema.safeParse({ questions: spec.questions }).success).toBe(true);
    expect(researchTaskRevisionChangesSchema.safeParse({ periods: spec.periods }).success).toBe(true);
    expect(researchTaskRevisionChangesSchema.safeParse({ asOf: '2025-07-01T00:00:00Z' }).success).toBe(true);
    expect(researchTaskRevisionChangesSchema.safeParse({}).success).toBe(false);
    expect(researchTaskRevisionChangesSchema.safeParse({ budget: { maxToolCalls: 100, timeoutMs: 3600000 } }).success).toBe(false);
    expect(researchTaskRevisionChangesSchema.safeParse({ company: { ...spec.company, symbol: '000333.SZ' } }).success).toBe(false);
  });
  it('rejects invalid identities, periods and duplicate questions; represents incomparability explicitly', () => {
    const spec = specFixture();
    expect(researchTaskSpecSchema.safeParse({ ...spec, company: { ...spec.company, exchange: 'SZ' } }).success).toBe(false);
    expect(researchTaskSpecSchema.safeParse({ ...spec, periods: [spec.periods[0], { ...spec.periods[1], start: '2024-12-31' }] }).success).toBe(false);
    expect(researchTaskSpecSchema.safeParse({ ...spec, periods: [spec.periods[1], spec.periods[0]] }).success).toBe(false);
    expect(researchTaskSpecSchema.safeParse({ ...spec, questions: [spec.questions[0], spec.questions[0], spec.questions[2]] }).success).toBe(false);
    const unequal = { ...spec, periods: [spec.periods[0], { ...spec.periods[1], kind: 'interim', end: '2024-06-30' }] };
    expect(researchTaskSpecSchema.safeParse(unequal).success).toBe(false);
    expect(researchTaskSpecSchema.safeParse({ ...unequal, comparison: { status: 'incomparable', reason: '全年与半年' } }).success).toBe(true);
  });
  it('uses verified disclosure, with conservative day precision, never fetchedAt', () => {
    const doc = documentFixture();
    expect(documentAvailableAt(doc, '2025-04-03T12:00:00+08:00')).toBe(false);
    expect(documentAvailableAt(doc, '2025-04-04T00:00:00+08:00')).toBe(true);
    expect(documentAvailableAt({ ...doc, disclosure: { status: 'unknown', reason: '待核实' } }, '2026-01-01T00:00:00Z')).toBe(false);
    expect(researchDocumentSchema.safeParse({ ...doc, bytesSha256: 'b'.repeat(64) }).success).toBe(false);
  });
  it('keeps zero distinct from missing and requires cited financial values', () => {
    const fact = reportFixture().facts[0];
    expect(financialFactSchema.parse(fact).value).toMatchObject({ status: 'known', raw: '0' });
    expect(financialFactSchema.parse({ ...fact, value: { status: 'missing', reason: '未取得' }, citations: [] }).value.status).toBe('missing');
    expect(financialFactSchema.safeParse({ ...fact, citations: [] }).success).toBe(false);
    expect(financialFactSchema.safeParse({ ...fact, value: { ...fact.value, raw: null } }).success).toBe(false);
  });
  it('checks company, document version/hash, period, page and quote bindings', () => {
    const taskId = randomUUID(), spec = specFixture(), report = reportFixture(taskId, spec), doc = documentFixture(taskId, spec);
    expect(reportBindingErrors(report, spec, [doc], () => '经营现金流原文测试')).toEqual([]);
    expect(reportBindingErrors(report, spec, [{ ...doc, version: 2 }])).toContain('CITATION_DOCUMENT_MISMATCH');
    expect(reportBindingErrors(report, spec, [{ ...doc, bytesSha256: 'b'.repeat(64) }])).toContain('CITATION_DOCUMENT_MISMATCH');
    expect(reportBindingErrors(report, spec, [{ ...doc, period: spec.periods[0] }])).toContain('CITATION_PERIOD_MISMATCH');
    expect(reportBindingErrors(report, spec, [{ ...doc, pageCount: 1 }])).toContain('CITATION_PAGE_OUT_OF_RANGE');
    expect(reportBindingErrors(report, spec, [doc], () => '其他文本')).toContain('CITATION_QUOTE_MISMATCH');
    expect(reportBindingErrors(report, spec, [{ ...doc, disclosure: { status: 'unknown', reason: '未知日期' } }])).toContain('CITATION_NOT_AVAILABLE_ASOF');
    expect(reportBindingErrors({ ...report, companySymbol: '000333.SZ' }, spec, [doc])).toContain('REPORT_REQUEST_MISMATCH');
  });
  it('keeps partial delivery explicit and refuses to promote unresolved reports', () => {
    const r = reportFixture();
    expect(readResearchReport(r).format).toBe('financial_change_v1');
    expect(researchReportRevisionSchema.safeParse({ ...r, status: 'completed' }).success).toBe(false);
    const incomplete = researchReportRevisionSchema.parse({ ...r, status: 'completed', gaps: [] });
    expect(reportBindingErrors(incomplete, specFixture(), [documentFixture(r.taskId)])).toContain('REQUIRED_QUESTION_MISSING');
    expect(reportBindingErrors(incomplete, specFixture(), [documentFixture(r.taskId)])).toContain('REQUIRED_FACT_MISSING');
  });
  it('separates plan/request revisions from event sequence and worker generation', () => {
    const taskId = randomUUID(), spec = specFixture();
    const plan = researchPlanSchema.parse({ schemaVersion: 1, taskId, requestRevision: 1, revision: 3, createdAt: new Date().toISOString(), steps: [{ id: 'verify', questionId: 'cash_flow', kind: 'verify', title: '复核现金流' }] });
    expect(() => assertPlanForSpec(plan, spec)).not.toThrow();
    expect(() => assertPlanForSpec({ ...plan, requestRevision: 2 }, spec)).toThrow('PLAN_REQUEST_MISMATCH');
    const event = { schemaVersion: 1, id: randomUUID(), taskId, sequence: 11, at: new Date().toISOString(), requestRevision: 1, planRevision: 3, reportRevision: null, attemptId: randomUUID(), generation: 7, event: { type: 'attempt.started' } };
    expect(researchEventSchema.parse(event)).toMatchObject({ sequence: 11, planRevision: 3, generation: 7 });
    expect(researchEventSchema.parse({ ...event, id: randomUUID(), sequence: 12, planRevision: 4, reportRevision: 2, attemptId: null,
      event: { type: 'report.update.queued', fromReportRevision: 2, sourceHashes: [fixtureHash], affectedPeriods: ['fy2024'] } })).toMatchObject({ event: { type: 'report.update.queued', affectedPeriods: ['fy2024'] } });
    expect(researchEventSchema.safeParse({ ...event, schemaVersion: 2 }).success).toBe(false);
    expect(researchEventSchema.safeParse({ ...event, attemptId: null }).success).toBe(false);
    expect(researchDocumentSchema.safeParse({ ...documentFixture(), original: { store: 'local', key: '../secret', sha256: fixtureHash, byteLength: 1 } }).success).toBe(false);
  });
});
