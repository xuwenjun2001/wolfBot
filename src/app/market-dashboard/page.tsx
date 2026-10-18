import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { requireAction } from '@/lib/auth/action';
import { PageHeader } from '@/components/layout/PageHeader';
import MarketDashboardClient from './MarketDashboardClient';

export const metadata: Metadata = { title: '行情看板 · wolfbot', description: '板块资金、涨跌停、龙虎榜与机构持仓观察。' };
export const dynamic = 'force-dynamic';

export default async function MarketDashboardPage() {
  try { await requireAction({ headers: await headers(), action: 'quant.data.read' }); }
  catch {
    return <><PageHeader title="行情看板" /><main className="p-8" role="alert">当前无法访问行情数据，请登录并确认账号拥有行情读取权限。</main></>;
  }
  return <MarketDashboardClient />;
}
