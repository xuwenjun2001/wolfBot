import { z } from 'zod';

export const dashboardResources = [
  'overview', 'etfs', 'sectors', 'sector-history', 'limits', 'strong', 'watch',
  'dragon-tiger', 'seats', 'themes', 'theme-stocks', 'institutions', 'minute', 'kline',
  'index-session', 'market-turnover', 'index-breadth',
] as const;
export type DashboardResource = typeof dashboardResources[number];
export type DashboardRow = Record<string, string | number | boolean | null>;

const rowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const comparisonSchema = z.object({
  currentDate: z.string().nullable(), previousDate: z.string().nullable(), cutoff: z.string().nullable(),
  complete: z.boolean(), reason: z.string().nullable(),
  currentTotal: z.number().nullable().optional(), currentCutoff: z.string().nullable().optional(),
  rows: z.array(z.object({ time: z.string(), current: z.number(), previous: z.number(), difference: z.number(), changePct: z.number().nullable() })).max(250),
});
export type AmountComparison = z.infer<typeof comparisonSchema>;
const baselineStatusSchema = z.object({
  cutoff: z.string().nullable(), complete: z.boolean(), reason: z.string().nullable(),
  reasonCode: z.string().nullable(),
});
const metricComparisonSchema = z.object({
  currentDate: z.string(), currentCutoff: z.string().nullable(), unit: z.enum(['元', '手']),
  previousDate: z.string().nullable(), sampleDates: z.array(z.string()).max(5),
  sampleCount: z.number().int().min(0).max(5), reason: z.string().nullable(),
  fetchedAt: z.string().nullable().optional(), retained: z.boolean().optional(),
  previousStatus: baselineStatusSchema, ma5Status: baselineStatusSchema,
  rows: z.array(z.object({
    time: z.string(), current: z.number(), previous: z.number().nullable(), ma5: z.number().nullable(),
    previousDifference: z.number().nullable(), previousChangePct: z.number().nullable(),
    ma5Difference: z.number().nullable(), ma5ChangePct: z.number().nullable(),
  })).max(250),
});
export type MetricComparison = z.infer<typeof metricComparisonSchema>;
export type TurnoverMetric = 'amount' | 'volume';
export const dashboardDataSchema = z.object({
  resource: z.enum(dashboardResources),
  rows: z.array(rowSchema).max(2000),
  source: z.string(), tradeDate: z.string().nullable(), fetchedAt: z.string(),
  status: z.enum(['available', 'partial', 'empty', 'unavailable', 'stale', 'pending']),
  stale: z.boolean(), cacheHit: z.boolean(), dateStatus: z.enum(['current', 'historical', 'unknown']),
  fallbackReason: z.string().nullable(), note: z.string(),
  total: z.number().optional(), page: z.number().optional(), pageSize: z.number().optional(),
  code: z.string().optional(), period: z.string().optional(), sourceGeneratedAt: z.string().nullable().optional(),
  name: z.string().optional(), previousClose: z.number().nullable().optional(),
  comparison: comparisonSchema.optional(), complete: z.boolean().optional(), refreshing: z.boolean().optional(),
  metrics: z.object({ amount: metricComparisonSchema, volume: metricComparisonSchema }).optional(),
  sections: z.array(z.object({ date: z.string().nullable(), rows: z.array(rowSchema),
    allNet: z.number().nullable(), citicNet: z.number().nullable() })).optional(),
});
export type DashboardData = z.infer<typeof dashboardDataSchema>;

const code = z.string().regex(/^\d{6}$/).refine(value => !/^(43|83|87)/.test(value), '请使用北交所迁移后的920代码');
const board = z.string().regex(/^BK\d{4,6}$/);
const page = z.string().regex(/^(?:[1-9]|10)$/).default('1');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value <= today;
}, '无效日期');
const empty = z.object({}).strict();
const querySchemas = {
  'index-session': z.object({ index: z.enum(['sh', 'sz', 'cy', 'kc']) }).strict(),
  'index-breadth': z.object({ index: z.enum(['sh', 'sz', 'cy', 'kc']) }).strict(),
  'market-turnover': empty,
  overview: empty, etfs: empty, watch: empty, institutions: empty, strong: empty,
  sectors: z.object({ kind: z.enum(['industry', 'concept']).default('industry'), page }).strict(),
  themes: z.object({ page }).strict(), 'theme-stocks': z.object({ code: board, page }).strict(),
  'sector-history': z.object({ code: board, period: z.enum(['intraday', '3d']).default('intraday') }).strict(),
  limits: z.object({ pool: z.enum(['up', 'down', 'blow', 'yesterday']).default('up'), date }).strict(),
  'dragon-tiger': z.object({ date }).strict(), seats: z.object({ code, date }).strict(),
  minute: z.object({ code }).strict(), kline: z.object({ code }).strict(),
};

export function parseDashboardQuery(resource: string, searchParams: URLSearchParams) {
  const parsedResource = z.enum(dashboardResources).parse(resource);
  const entries = [...searchParams.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('查询参数重复');
  const params = querySchemas[parsedResource].parse(Object.fromEntries(entries));
  return { resource: parsedResource, params };
}
