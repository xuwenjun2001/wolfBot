/** Amount arithmetic uses decimal strings and BigInt; no binary floating point enters financial results. */
export interface ExactDecimal { coefficient: bigint; scale: number }
export const cnyUnitPowers = { yuan: 0, thousand_yuan: 3, ten_thousand_yuan: 4, million_yuan: 6, hundred_million_yuan: 8 } as const;
const ten = (n: number) => 10n ** BigInt(n);
export function decimal(value: string): ExactDecimal {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 120) throw new Error('Invalid decimal');
  const scale = value.split('.')[1]?.length || 0;
  if (scale > 20) throw new Error('Decimal precision exceeds limit');
  return { coefficient: BigInt(value.replace('.', '')), scale };
}
export function decimalText(value: ExactDecimal, trim = true): string {
  const negative = value.coefficient < 0n, digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, '0');
  let text = value.scale ? `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}` : digits;
  if (trim && value.scale) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return `${negative ? '-' : ''}${text}`;
}
export function subtract(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const scale = Math.max(a.scale, b.scale);
  return { coefficient: a.coefficient * ten(scale - a.scale) - b.coefficient * ten(scale - b.scale), scale };
}
export function multiplyPowerOfTen(a: ExactDecimal, power: number): ExactDecimal {
  return { coefficient: a.coefficient * ten(power), scale: a.scale };
}
export function percentChange(before: ExactDecimal, after: ExactDecimal, places = 6): string | null {
  const delta = subtract(after, before), denominator = before.coefficient < 0n ? -before.coefficient : before.coefficient;
  if (!denominator) return null;
  const numerator = delta.coefficient * ten(before.scale) * 100n * ten(places);
  const divisor = denominator * ten(delta.scale), sign = numerator < 0n ? -1n : 1n, absolute = numerator < 0n ? -numerator : numerator;
  const rounded = (absolute + divisor / 2n) / divisor;
  return decimalText({ coefficient: sign * rounded, scale: places }, false);
}
