import { describe, expect, it } from 'vitest';
import { documentFixture, reportFixture, specFixture } from './version-test-fixtures';
import { reportBindingErrors, researchReportRevisionSchema } from './revision-contracts';
import { researchEvidencePeriods } from './evidence-periods';
import { researchTaskSpecSchema } from './task-contracts';
import { deriveSingleQuarter } from './financial-comparison';
import type { FinancialFact } from './document-contracts';

describe('reported periods and financial derivation provenance', () => {
  it('requires a located prior-period label and a restatement basis for later-report values', () => {
    const spec = specFixture(), doc = documentFixture(), report = reportFixture(doc.taskId);
    const fact = report.facts[0];
    Object.assign(fact, { period: spec.periods[0], restatement: 'restated', accountingBasis: '2024-restatement', periodEvidence: [{ ...fact.citations[0], quote: '2023年（调整后）' }] });
    const text = () => '2023年（调整后） 经营现金流原文测试';
    expect(reportBindingErrors(report, spec, [doc], text, text)).toEqual([]);
    for (const change of [{ periodEvidence: [] }, { accountingBasis: undefined }, { restatement: 'original' }, { periodEvidence: [{ ...fact.citations[0], quote: '2024年' }] }]) {
      const modified = researchReportRevisionSchema.parse({ ...report, facts: [{ ...fact, ...change }] });
      expect(reportBindingErrors(modified, spec, [doc], text, text)).toContain('CITATION_PERIOD_MISMATCH');
    }
    const forged = structuredClone(report); forged.facts[0].periodEvidence![0].quote = '2023年（不存在的列）';
    expect(reportBindingErrors(forged, spec, [doc], text, text)).toContain('CITATION_LOCATOR_MISMATCH');
    expect(reportBindingErrors(report, spec, [{ ...doc, disclosure: { status: 'unknown', reason: 'unknown' } }], text, text)).toContain('CITATION_NOT_AVAILABLE_ASOF');
    expect(reportBindingErrors(report, spec, [{ ...doc, state: 'unreadable' }], text, text)).toContain('CITATION_DOCUMENT_UNUSABLE');
  });
  it('only admits the selected quarters and their exact cumulative inputs', () => {
    const spec = researchTaskSpecSchema.parse({ ...specFixture(), periods: [2023, 2024].map(y => ({ id: `${y}Q2`, start: `${y}-04-01`, end: `${y}-06-30`, kind: 'quarter', basis: 'single_quarter' })) });
    expect(researchEvidencePeriods(spec).map(p => p.id)).toEqual(['2023Q2', '2024Q2', 'ytd_2023_06', 'ytd_2023_03', 'ytd_2024_06', 'ytd_2024_03']);
    expect(researchEvidencePeriods(specFixture())).toEqual(specFixture().periods);
    const collision = structuredClone(spec); collision.periods[1].id = 'ytd_2024_06';
    expect(new Set(researchEvidencePeriods(collision).map(p => p.id)).size).toBe(6);
  });
  it('recomputes quarter facts and rejects missing, altered or cyclic supporting inputs', () => {
    const spec = researchTaskSpecSchema.parse({ ...specFixture(), periods: [2023, 2024].map(y => ({ id: `${y}Q2`, start: `${y}-04-01`, end: `${y}-06-30`, kind: 'quarter', basis: 'single_quarter' })) });
    const periods = researchEvidencePeriods(spec), report = reportFixture(undefined, spec), base = report.facts[0];
    const input = (id: string, raw: string, periodId: string): FinancialFact => ({ ...base, id, period: periods.find(p => p.id === periodId)!, value: { status: 'known', raw, unit: 'yuan', currency: 'CNY', decimals: 0 }, citations: [{ ...base.citations[0], documentId: id }] });
    const h1 = input('h1', '250', 'ytd_2024_06'), q1 = input('q1', '100', 'ytd_2024_03'), quarter = deriveSingleQuarter(h1, q1);
    report.facts = [quarter]; report.supportingFacts = [h1, q1]; report.claims = [];
    const docs = [h1, q1].map(f => ({ ...documentFixture(report.taskId, spec), id: f.id, period: f.period }));
    expect(reportBindingErrors(report, spec, docs)).toEqual([]);
    const bad = structuredClone(report); bad.facts[0].value = { status: 'known', raw: '151', unit: 'yuan', currency: 'CNY', decimals: 0 };
    expect(reportBindingErrors(bad, spec, docs)).toContain('DERIVED_FACT_MISMATCH');
    expect(reportBindingErrors({ ...report, supportingFacts: [] }, spec, docs)).toContain('DERIVED_INPUT_INVALID');
    const missing = structuredClone(report); missing.supportingFacts![1].value = { status: 'missing', reason: 'not obtained' };
    expect(reportBindingErrors(missing, spec, docs)).toContain('DERIVED_INPUT_INVALID');
    const cycle = structuredClone(report); cycle.supportingFacts![0].derivedFrom = [quarter.id];
    expect(reportBindingErrors(cycle, spec, docs)).toContain('DERIVED_INPUT_INVALID');
    const lostCitation = structuredClone(report); lostCitation.facts[0].citations.pop();
    expect(reportBindingErrors(lostCitation, spec, docs)).toContain('DERIVED_FACT_MISMATCH');
    const future = docs.map(d => ({ ...d, disclosure: { status: 'verified' as const, precision: 'instant' as const, at: '2030-01-01T00:00:00Z', evidenceUrl: d.url, evidenceSha256: d.bytesSha256 } }));
    expect(reportBindingErrors(report, spec, future)).toContain('CITATION_NOT_AVAILABLE_ASOF');
  });
});
