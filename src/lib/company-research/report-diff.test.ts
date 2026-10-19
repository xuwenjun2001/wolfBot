import { describe, expect, it } from 'vitest';
import { reportFixture } from './version-test-fixtures';
import { buildResearchReportDiff } from './report-diff';

describe('immutable report differences', () => {
  it('does not invent changes when a new revision contains the same findings and sources', () => {
    const before = reportFixture(), after = structuredClone(before);
    after.revision = 2;
    after.generatedAt = '2026-10-20T10:00:00.000Z';
    const diff = buildResearchReportDiff(before, after);
    expect(diff.status).toBe('unchanged');
    expect(diff.facts.every(item => item.status === 'unchanged')).toBe(true);
    expect(diff.claims.every(item => item.status === 'unchanged')).toBe(true);
    expect(diff.evidence).toEqual({ added: [], removed: [] });
  });

  it('separates a numeric restatement, a revised supported claim and its source replacement', () => {
    const before = reportFixture(), after = structuredClone(before);
    after.revision = 2;
    after.facts[0].value = { status: 'known', raw: '12', unit: 'yuan', currency: 'CNY', decimals: 2 };
    after.facts[0].restatement = 'restated';
    after.facts[0].citations[0] = { ...after.facts[0].citations[0], documentId: 'annual-2025', bytesSha256: 'b'.repeat(64) };
    after.claims[0].text = '新版报告显示现金流判断已有变化';
    after.claims[0].citations[0] = { ...after.claims[0].citations[0], documentId: 'annual-2025', bytesSha256: 'b'.repeat(64) };

    const diff = buildResearchReportDiff(before, after);
    expect(diff.status).toBe('changed');
    expect(diff.facts[0]).toMatchObject({ status: 'changed', before: { value: { raw: '0' } }, after: { value: { raw: '12' }, restatement: 'restated' } });
    expect(diff.claims[0]).toMatchObject({ status: 'revised', reason: expect.stringContaining('变化') });
    expect(diff.evidence.added).toHaveLength(1);
    expect(diff.evidence.removed).toHaveLength(1);
    expect(JSON.stringify(diff.evidence)).not.toContain('经营现金流原文测试');
  });

  it('distinguishes newly supported findings from withdrawn support', () => {
    const before = reportFixture(), after = structuredClone(before);
    before.claims[0].status = 'evidence_gap';
    before.claims[0].reason = '旧报告没有完成语义核验';
    after.revision = 2;
    after.claims[0].status = 'supported';
    after.claims[0].reason = undefined;
    const supported = buildResearchReportDiff(before, after);
    expect(supported.claims[0]).toMatchObject({ status: 'supported', after: { status: 'supported' } });

    const withdrawn = structuredClone(after);
    withdrawn.revision = 3;
    withdrawn.claims[0].status = 'conflict';
    withdrawn.claims[0].reason = '新版证据与原结论冲突';
    const diff = buildResearchReportDiff(after, withdrawn);
    expect(diff.claims[0]).toMatchObject({ status: 'withdrawn', reason: '新版证据与原结论冲突' });
  });

  it('compares exact normalized amounts and includes period evidence in source differences', () => {
    const before = reportFixture(), after = structuredClone(before); after.revision = 2;
    before.facts[0].value = { status: 'known', raw: '1000', unit: 'yuan', currency: 'CNY', decimals: 0 };
    after.facts[0].value = { status: 'known', raw: '1', unit: 'thousand_yuan', currency: 'CNY', decimals: 0 };
    after.facts[0].normalization = { version: 'decimal-v1', rawText: '1', unitLabel: '千元', normalizedYuan: '1000' };
    after.facts[0].periodEvidence = [{ ...after.facts[0].citations[0], documentId: 'period-header', bytesSha256: 'c'.repeat(64) }];
    const diff = buildResearchReportDiff(before, after);
    expect(diff.facts[0].status).toBe('unchanged');
    expect(diff.evidence.added).toHaveLength(1);
  });
});
