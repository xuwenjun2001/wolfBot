import { createHash } from 'node:crypto';
import { sectionKeys, sectionLabels, type ResearchReport, type Source } from './contracts';

export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/** Citation integrity is deterministic. Semantic support still requires research/acceptance review. */
export function coverage(report: ResearchReport, sources: Source[], asOf: string) {
  const errors: string[] = [];
  const gaps: string[] = [];
  const verify = (citation: { sourceId: string; quote: string }, label: string) => {
    const source = sources.find(s => s.id === citation.sourceId);
    if (!source) { errors.push(`${label}：引用来源未读取 ${citation.sourceId}`); return; }
    if (source.publishedAt && source.publishedAt.slice(0, 10) > asOf.slice(0, 10)) errors.push(`${label}：引用晚于研究截止日`);
    if (!normalize(source.content).includes(normalize(citation.quote))) errors.push(`${label}：引用片段不在原文中 ${citation.sourceId}`);
  };
  for (const key of sectionKeys) {
    const section = report[key];
    if (!section.claims.length) gaps.push(`${sectionLabels[key]}缺少可核查结论`);
    gaps.push(...section.gaps.map(g => `${sectionLabels[key]}：${g}`));
    section.claims.forEach(claim => claim.citations.forEach(c => verify(c, sectionLabels[key])));
  }
  if (!report.metrics.length) gaps.push('近期财报缺少财务指标');
  report.metrics.forEach(metric => verify(metric.citation, metric.label));
  return { errors: [...new Set(errors)], gaps: [...new Set(gaps)], complete: errors.length === 0 && gaps.length === 0 };
}

/** Budget/error delivery never promotes unsupported draft quotations to report evidence. */
export function salvageReport(report: ResearchReport, sources: Source[], asOf: string): ResearchReport {
  const result = structuredClone(report);
  const valid = (citation: { sourceId: string; quote: string }) => {
    const source = sources.find(s => s.id === citation.sourceId);
    return Boolean(source && (!source.publishedAt || source.publishedAt.slice(0, 10) <= asOf.slice(0, 10)) && normalize(source.content).includes(normalize(citation.quote)));
  };
  for (const key of sectionKeys) {
    const before = result[key].claims.length;
    result[key].claims = result[key].claims.filter(claim => claim.citations.every(valid));
    if (before !== result[key].claims.length) result[key].gaps.push('部分草稿结论的引用未通过核对，已从结果中移除');
  }
  const before = result.metrics.length;
  result.metrics = result.metrics.filter(metric => valid(metric.citation));
  if (before !== result.metrics.length) result.financials.gaps.push('部分财务指标的引用未通过核对，已从结果中移除');
  return result;
}
