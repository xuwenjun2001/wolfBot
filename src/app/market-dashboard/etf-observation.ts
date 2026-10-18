import type { DashboardRow } from '@/lib/quant/market-dashboard-types';

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Amount pulses are observations, never inferred investor identities or flows. */
export function observeEtf(rows: DashboardRow[]) {
  const bars = rows.filter(row => {
    if (!/^\d{2}:\d{2}$/.test(String(row.time))) return false;
    const [hour, minute] = String(row.time).split(':').map(Number), time = hour * 60 + minute;
    const tradingMinute = minute < 60 && ((time >= 571 && time <= 690) || (time >= 781 && time <= 900));
    return tradingMinute && typeof row.minuteAmount === 'number' && row.minuteAmount >= 0 && typeof row.price === 'number' && row.price > 0;
  });
  if (bars.length < 12) return { label: '样本不足', ratio: null, time: null, direction: '待观察' };
  // Ignore the latest possibly unfinished minute. Exclude the opening auction
  // from the baseline and do not treat a missing minute as zero turnover.
  const index = bars.length - 2, current = bars[index];
  const baseline = bars.slice(Math.max(1, index - 30), index).map(row => Number(row.minuteAmount));
  if (baseline.length < 8) return { label: '样本不足', ratio: null, time: null, direction: '待观察' };
  const center = median(baseline);
  if (center <= 0) return { label: '基线不足', ratio: null, time: String(current.time), direction: '待观察' };
  const ratio = Number(current.minuteAmount) / center;
  const change = Number(current.price) / Number(bars[index - 1].price) - 1;
  const direction = change > .0005 ? '价格上行' : change < -.0005 ? '价格下行' : '价格横盘';
  return { label: ratio >= 2.4 ? '成交额脉冲' : ratio >= 1.6 ? '成交额放大' : '平稳', ratio, time: String(current.time), direction };
}
