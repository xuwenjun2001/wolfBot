import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { authErrorResponse } from '@/lib/auth/http';
import { getMarketDashboard } from '@/lib/quant/market-dashboard';
import { dashboardResources, parseDashboardQuery } from '@/lib/quant/market-dashboard-types';

export async function GET(request: NextRequest, context: { params: Promise<{ resource: string }> }) {
  try {
    await requireAction({ headers: request.headers, action: 'quant.data.read' });
  } catch (error) { return authErrorResponse(error); }
  const { resource } = await context.params;
  if (!dashboardResources.some(value => value === resource)) {
    return NextResponse.json({ message: '行情资源不存在。' }, { status: 404 });
  }
  let query;
  try { query = parseDashboardQuery(resource, request.nextUrl.searchParams); }
  catch { return NextResponse.json({ message: '查询参数无效，请检查日期、代码或页码。' }, { status: 400 }); }
  try {
    const data = await getMarketDashboard(query.resource, query.params);
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json({ message: '行情服务暂不可用，请稍后重试。' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
