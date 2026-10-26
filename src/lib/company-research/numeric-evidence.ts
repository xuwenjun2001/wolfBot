import type { FinancialFact } from './document-contracts';
import { disclosedAmount } from './financial-normalization';
import { decimal, decimalText } from './exact-decimal';

export const financialLabels: Record<FinancialFact['metric'], RegExp> = {
  revenue: /(?<!总)营业收入/, total_operating_income: /营业总收入/,
  parent_net_profit: /归属于(?:上市公司|母公司)股东的净利润/,
  operating_cash_flow: /(?<!每股)经营活动(?:产生的)?现金流量净额/,
};
export const monetaryUnitPattern = '(?:百万元|亿元|万元|千元|元)';
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
/** Select the closest year-heading group, excluding report titles, dates and earlier tables. */
export function financialTableHeader(text: string, labelIndex: number) {
  const prefix = text.slice(0, labelIndex);
  const allYears = [...prefix.matchAll(/((?:19|20)\d{2})年(?!末|度?报告|年度报告|年报|\d{1,2}月)/g)];
  const units = [...prefix.matchAll(new RegExp(`(?:单位[:：]?(?:人民币)?|人民币)${monetaryUnitPattern}`, 'g'))];
  const latestUnit = units.at(-1), previousUnit = units.at(-2);
  // A unit may appear before the year row or just below it. In both layouts, an
  // earlier balance-sheet table and narrative years cannot pollute these columns.
  const afterLatestUnit = latestUnit && allYears.some(year => year.index! > latestUnit.index!);
  const boundary = latestUnit ? afterLatestUnit ? latestUnit.index! : (previousUnit ? previousUnit.index! + previousUnit[0].length : 0) : 0;
  const years = allYears.filter(year => year.index! >= boundary);
  if (!years.length) return { text: '', start: labelIndex, end: labelIndex };
  let start = years[0].index!;
  for (let i = 1; i < years.length; i++) {
    const between = prefix.slice(years[i - 1].index! + years[i - 1][0].length, years[i].index!);
    if (between.length > 240 || Object.values(financialLabels).some(label => label.test(between))) start = years[i].index!;
  }
  let header = prefix.slice(start);
  const firstMetric = Math.min(header.length, ...Object.values(financialLabels).map(re => re.exec(header)?.index ?? header.length));
  header = header.slice(0, firstMetric);
  return { text: header, start, end: start + header.length };
}

/** Locate a year-labelled amount column; accept only explicit or bounded summary-table layouts. */
export function yearAmountColumn(text: string, labelIndex: number, year: string, count: number, restatement: FinancialFact['restatement'] = 'original'): number | null {
  const header = financialTableHeader(text, labelIndex).text;
  const headings = [...header.matchAll(/((?:19|20)\d{2})年(?!末|度?报告|年度报告|年报|\d{1,2}月)/g)];
  const years = headings.map(m => m[1]);
  if (!years.length || years.filter(y => y === year).length !== 1) return null;
  const index = years.indexOf(year);
  if (index < 0) return null;
  // The first year is unambiguous even when later years have split restatement columns.
  const firstGroup = header.slice(headings[0].index! + headings[0][0].length, headings[1]?.index ?? header.length);
  if (index === 0 && !/调整前|调整后/.test(firstGroup)) return 0;
  // Other columns need a one-to-one header/value mapping, without percentage or restatement subcolumns.
  if (count === years.length && !/调整前|调整后|增减|变动|%/.test(header)) return index;
  if (restatement !== 'restated') return null;
  const adjustments = [...header.matchAll(/调整(前|后)(?:\(\d+\)|注\d+)?/g)];
  const ratio = /(?:增减|变动)[^%]{0,30}%/.test(header);
  const group = header.slice(headings[index].index! + headings[index][0].length, headings[index + 1]?.index ?? header.length);
  // A single explicitly adjusted column has no hidden extra value column.
  if (count === years.length && /调整后/.test(group) && !/调整前|%/.test(header)) return index;
  // Supported annual summary grammar: current, prior (before/after), change, optional older.
  // Exactly one split prior-year group is permitted; repeated years or another split stay ambiguous.
  const ordered = years.length >= 2 && years.length <= 3 && years.every((value, i) => !i || Number(years[i - 1]) - Number(value) === 1);
  const oneSplit = adjustments.length >= 2 && adjustments.length <= (years.length === 3 ? 3 : 2)
    && adjustments[0][1] !== adjustments[1][1] && (adjustments.length === 2 || adjustments[2][1] === '后');
  const withinPriorOrFlattened = adjustments.length && adjustments[0].index! > headings[1]?.index!;
  if (ordered && index === 1 && oneSplit && withinPriorOrFlattened && count === years.length + 1 + Number(ratio)
    && (years.length === 2 || ratio)) return adjustments[0][1] === '后' ? 1 : 2;
  if (ordered && index === 1 && !adjustments.length && ratio && count === years.length + 1) return 1;
  return null;
}

/** A unit on another metric row or in a later per-share table cannot establish this amount's scale. */
export function financialRowUnits(text: string, labelIndex: number, labelLength: number) {
  const header = financialTableHeader(text, labelIndex), before = text.slice(0, header.end);
  const declarations = [...before.matchAll(new RegExp(`(?:单位[:：]?(?:人民币)?|人民币)(${monetaryUnitPattern})`, 'g'))];
  const declaration = declarations.at(-1);
  const units: string[] = [];
  if (declaration && (declaration.index! >= header.start || !Object.values(financialLabels).some(label => label.test(text.slice(declaration.index! + declaration[0].length, header.start))))) units.push(declaration[1]);
  const rowUnit = text.slice(labelIndex + labelLength).match(new RegExp(`^\\((?:人民币)?(${monetaryUnitPattern})\\)`));
  if (rowUnit) units.push(rowUnit[1]);
  const unitContext = text.slice(Math.max(0, declaration?.index ?? header.start), header.end);
  const foreignCurrency = /(?:币种[:：]*(?!人民币|[:：])[\p{L}]{2,}|港元|港币|美元|美金|欧元|英镑|日元|新台币|\b(?:HKD|USD|EUR)\b)/u.test(unitContext);
  return { units, foreignCurrency, header };
}
