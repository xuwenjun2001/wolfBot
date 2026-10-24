export interface PercentageInterval {
  lower: number;
  upper: number;
}

export function roundTo(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** Math.max(0, Math.floor(digits));
  return Math.round(value * factor) / factor;
}

/**
 * Wilson score interval is stable for small samples and avoids reporting a
 * misleading 100%-100% confidence interval after only one or two attempts.
 */
export function wilsonScoreInterval(
  passed: number,
  total: number,
  z = 1.959963984540054,
): PercentageInterval {
  if (!Number.isFinite(total) || total <= 0) return { lower: 0, upper: 0 };
  const sampleSize = Math.max(1, Math.floor(total));
  const successes = Math.min(sampleSize, Math.max(0, Math.floor(passed)));
  const proportion = successes / sampleSize;
  const zSquared = z ** 2;
  const denominator = 1 + zSquared / sampleSize;
  const centre = proportion + zSquared / (2 * sampleSize);
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * sampleSize)) / sampleSize,
  );
  return {
    lower: roundTo(Math.max(0, ((centre - margin) / denominator) * 100)),
    upper: roundTo(Math.min(100, ((centre + margin) / denominator) * 100)),
  };
}

export function populationStandardDeviation(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length <= 1) return 0;
  const average = finite.reduce((total, value) => total + value, 0) / finite.length;
  const variance = finite.reduce(
    (total, value) => total + (value - average) ** 2,
    0,
  ) / finite.length;
  return roundTo(Math.sqrt(variance));
}

export interface PairedBinaryObservation {
  /** One registered question (include the repeat ID when there are repeats). */
  key: string;
  baseline: boolean;
  candidate: boolean;
}

/**
 * Resample whole question pairs, never the two arms independently. The interval
 * and difference use proportions (-1..1), unlike Wilson's percentage output.
 * Company/repeat correlation is not removed by question-level resampling.
 */
export function pairedBootstrapInterval(
  observations: readonly PairedBinaryObservation[],
  options: { iterations?: number; seed?: number; confidence?: number } = {},
) {
  const iterations = options.iterations ?? 10_000;
  const seed = options.seed ?? 20261024;
  const confidence = options.confidence ?? .95;
  if (!Number.isSafeInteger(iterations) || iterations < 100 || iterations > 1_000_000) throw new Error('PAIRED_BOOTSTRAP_ITERATIONS');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('PAIRED_BOOTSTRAP_SEED');
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) throw new Error('PAIRED_BOOTSTRAP_CONFIDENCE');
  const keys = new Set<string>();
  for (const pair of observations) {
    if (!pair.key.trim() || keys.has(pair.key)) throw new Error('PAIRED_BOOTSTRAP_QUESTION_KEY');
    if (typeof pair.baseline !== 'boolean' || typeof pair.candidate !== 'boolean') throw new Error('PAIRED_BOOTSTRAP_BINARY_REQUIRED');
    keys.add(pair.key);
  }
  const total = observations.length;
  const metadata = { method: 'question_paired_percentile_bootstrap' as const, total, iterations, seed, confidence, units: 'proportion_difference' as const };
  if (!total) return { ...metadata, baselinePassed: 0, candidatePassed: 0, difference: null, interval: null };
  const baselinePassed = observations.filter(pair => pair.baseline).length;
  const candidatePassed = observations.filter(pair => pair.candidate).length;
  const deltas = observations.map(pair => Number(pair.candidate) - Number(pair.baseline));
  let state = seed >>> 0;
  // Mulberry32 accepts every uint32 seed, including zero.
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const sampled = Array.from({ length: iterations }, () => {
    let delta = 0;
    for (let i = 0; i < total; i++) delta += deltas[Math.floor(random() * total)];
    return delta / total;
  }).sort((a, b) => a - b);
  const quantile = (probability: number) => {
    const index = (sampled.length - 1) * probability;
    const lower = Math.floor(index), weight = index - lower;
    return sampled[lower] * (1 - weight) + sampled[Math.ceil(index)] * weight;
  };
  const tail = (1 - confidence) / 2;
  return { ...metadata, baselinePassed, candidatePassed, difference: (candidatePassed - baselinePassed) / total,
    interval: { lower: quantile(tail), upper: quantile(1 - tail) } };
}
