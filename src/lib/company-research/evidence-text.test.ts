import { describe, expect, it } from 'vitest';
import { citationTextRange } from './evidence-text';

describe('retained citation offsets', () => {
  it('locates a wrapped quote beyond the first excerpt window', () => {
    const prefix = '前文。'.repeat(4000), original = '经营活动产生的现金流量\n净额 100.00';
    const text = prefix + original + '后文';
    expect(citationTextRange(text, '经营活动产生的现金流量净额 100.00')).toEqual({ start: prefix.length, end: prefix.length + original.length });
  });
  it('preserves UTF-16 offsets through combining characters, NFKC expansion and fullwidth digits', () => {
    const prefix = '🧾说明：', original = 'e\u0301 ﬃ Ａ\n１００．００';
    const range = citationTextRange(prefix + original + '结束', 'éffiA100.00')!;
    expect(range).toEqual({ start: prefix.length, end: prefix.length + original.length });
    expect((prefix + original + '结束').slice(range.start, range.end)).toBe(original);
  });
  it('retains exact matches and refuses absent or whitespace-only quotes', () => {
    expect(citationTextRange('前文\n250.00\n后文', '250.00')).toEqual({ start: 3, end: 9 });
    expect(citationTextRange('原文', '其他')).toBeNull();
    expect(citationTextRange('原文\n', ' \n')).toBeNull();
  });
});
