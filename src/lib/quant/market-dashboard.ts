import 'server-only';
import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import { dashboardDataSchema, type DashboardResource } from './market-dashboard-types';

export async function getMarketDashboard(resource: DashboardResource, params: Record<string, string>) {
  if (!getRuntimeDegradationConfig().components.marketApi.enabled) throw new Error('Market data disabled');
  const base = process.env.QUANTPILOT_MARKET_API_URL || process.env.QUANTPILOT_MARKET_API_BASE_URL || 'http://127.0.0.1:8000';
  const token = process.env.QUANTPILOT_MARKET_ADMIN_TOKEN?.trim();
  const url = `${base.replace(/\/$/, '')}/api/v1/market-dashboard/${resource}?${new URLSearchParams(params)}`;
  const response = await fetch(url, {
    headers: token ? { 'X-QuantPilot-Admin-Token': token } : {},
    cache: 'no-store', signal: AbortSignal.timeout(28_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Market dashboard backend returned ${response.status}`);
  const data = dashboardDataSchema.parse(await response.json());
  if (data.resource !== resource) throw new Error('Unexpected dashboard resource');
  return data;
}
