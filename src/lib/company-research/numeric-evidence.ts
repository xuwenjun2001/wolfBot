import type { FinancialFact } from './document-contracts';
import { disclosedAmount } from './financial-normalization';
import { decimal, decimalText } from './exact-decimal';

export const financialLabels: Record<FinancialFact['metric'], RegExp> = {
  revenue: /(?<!总)营业收入/, total_operating_income: /营业总收入/,
  parent_net_profit: /归属于(?:上市公司|母公司)股东的净利润/,
  operating_cash_flow: /经营活动(?:产生的)?现金流量净额/,
};
/** Keep amount boundaries while joining PDF-wrapped Chinese labels. */
export function numericEvidenceText(text: string) {
  return text.normalize('NFKC').replace(/(?<=[\d)])\s+(?=[\d(−-])/g, '|').replace(/\s+/gu, '');
}
/** Reuse the disclosure parser: parentheses and Unicode minus signs retain their sign. */
export function evidenceAmounts(text: string): string[] {
  const tokens = numericEvidenceText(text).matchAll(/(?<![\d.,(−-])(?:\([\d,]+(?:\.\d+)?\)|[−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\d.,)])/g);
  return [...tokens].flatMap(token => {
    const amount = disclosedAmount(token[0], '元');
    return amount.status === 'known' ? [decimalText(decimal(amount.raw))] : [];
  });
}
/** Locate a year-labelled amount column; flattened ambiguous headers are not guessed. */
export function yearAmountColumn(text: string, labelIndex: number, year: string, count: number): number | null {
  const prefix = text.slice(0, labelIndex);
  // A report title proves document identity, not a numeric column. Prefer the table's unit heading.
  const unitStart = prefix.lastIndexOf('单位');
  let header = prefix.slice(unitStart >= 0 ? unitStart : prefix.lastIndexOf('报告') + 2);
  if (unitStart < 0 && !prefix.includes('报告')) header = prefix;
  const firstMetric = Math.min(header.length, ...Object.values(financialLabels).map(re => re.exec(header)?.index ?? header.length));
  header = header.slice(0, firstMetric);
  const headings = [...header.matchAll(/((?:19|20)\d{2})年(?!末|度?报告|年度报告)/g)];
  const years = headings.map(m => m[1]);
  if (!years.length || years.filter(y => y === year).length !== 1) return null;
  const index = years.indexOf(year);
  if (index < 0) return null;
  // The first year is unambiguous even when later years have split restatement columns.
  const firstGroup = header.slice(headings[0].index! + headings[0][0].length, headings[1]?.index ?? header.length);
  if (index === 0 && !/调整前|调整后/.test(firstGroup)) return 0;
  // Other columns need a one-to-one header/value mapping, without percentage or restatement subcolumns.
  if (count === years.length && !/调整前|调整后|增减|变动|%/.test(header)) return index;
  return null;
}
