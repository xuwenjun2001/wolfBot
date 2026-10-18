import { describe, expect, it } from 'vitest';
import { cninfoDisclosure, documentEligibility } from './filing-acquisition';
import { downloadResearchOriginal } from './network';
import { documentFixture } from './version-test-fixtures';
import { filingImportSchema } from './acquisition-service';

describe('original filing provenance and cutoff', () => {
  it('interprets CNINFO calendar labels in Shanghai and conservatively uses end of day', () => {
    const result = cninfoDisclosure({ announcementTime: 1743609600000 }, Buffer.from('official'), 'https://www.cninfo.com.cn/');
    expect(result.disclosure).toMatchObject({ on: '2025-04-03', precision: 'date' });
    const doc = { ...documentFixture(), disclosure: result.disclosure };
    expect(documentEligibility(doc, '2025-04-03T12:00:00+08:00')).toBe('after_cutoff');
    expect(documentEligibility(doc, '2025-04-04T00:00:00+08:00')).toBe('available');
  });
  it('retains unknown/conflicting dates without substituting fetchedAt', () => {
    const conflict = cninfoDisclosure({ announcementTime: 1743609600000 }, Buffer.from('official'), 'https://www.cninfo.com.cn/', [{ source: 'other', on: '2025-04-02' }]);
    expect(conflict.dateClaims).toHaveLength(2); expect(conflict.warnings).toContain('disclosure_conflict');
    expect(documentEligibility({ ...documentFixture(), disclosure: conflict.disclosure }, '2030-01-01T00:00:00Z')).toBe('date_unverified');
    expect(cninfoDisclosure({}, Buffer.from('x'), 'https://example.com').disclosure.status).toBe('unknown');
  });
  it('does not let import callers assert a verified disclosure or a trusted actor', () => {
    expect(filingImportSchema.safeParse({ provider: 'manual', url: 'https://example.com/a.pdf', title: '年报', periodId: 'fy2024', disclosure: documentFixture().disclosure }).success).toBe(false);
  });
  it('rejects private original downloads before opening a socket', async () => {
    await expect(downloadResearchOriginal('http://127.0.0.1/report.pdf', AbortSignal.timeout(1000))).rejects.toThrow('内网');
    await expect(downloadResearchOriginal('http://user:pass@example.com/', AbortSignal.timeout(1000))).rejects.toThrow('公开');
  });
});
