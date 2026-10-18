import { describe, it, expect } from 'vitest';
import { observeEtf } from './etf-observation';

describe('ETF observation semantics', () => {
  it('does not use the unfinished latest minute or identify investor types', () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({ time: `14:${String(i).padStart(2, '0')}`, price: 5, minuteAmount: 100 }));
    rows[30] = { time: '14:30', price: 5.02, minuteAmount: 300 };
    rows[31] = { time: '14:31', price: 5.03, minuteAmount: 1 };
    expect(observeEtf(rows)).toEqual({ label: '成交额脉冲', ratio: 3, time: '14:30', direction: '价格上行' });
  });
  it('ignores after-hours records that would otherwise create a false pulse', () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ time: `14:${String(i + 29).padStart(2, '0')}`, price: 5, minuteAmount: 100 }));
    rows.push({ time: '15:00', price: 5, minuteAmount: 100 });
    rows.push(...Array.from({ length: 30 }, (_, i) => ({ time: `15:${String(i + 1).padStart(2, '0')}`, price: 5, minuteAmount: i === 28 ? 100000 : 1 })));
    expect(observeEtf(rows)).toEqual({ label: '平稳', ratio: 1, time: '14:59', direction: '价格横盘' });
  });
  it('does not treat absent values as zero or produce ratios from a zero baseline', () => {
    expect(observeEtf([{ time: '10:01', price: null, minuteAmount: null }]).label).toBe('样本不足');
    expect(observeEtf(Array.from({ length: 15 }, () => ({ time: '10:01', price: 5, minuteAmount: 0 }))).ratio).toBeNull();
  });
});
