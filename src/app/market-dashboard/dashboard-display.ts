import type { DashboardData } from '@/lib/quant/market-dashboard-types';

export function retainDashboardData(previous: DashboardData | null, incoming: DashboardData): DashboardData {
  // Only failed responses retain content. A successful empty list is meaningful.
  if (incoming.status !== 'unavailable' || !previous || previous.status === 'unavailable') return incoming;
  if (!previous.rows.length && !previous.sections?.length && !previous.metrics) return incoming;
  return { ...previous, status: 'stale', stale: true,
    fallbackReason: incoming.fallbackReason || '更新失败，保留上次有效数据。' };
}

export function dashboardEmptyMessage(data: DashboardData | null, busy: boolean, error: string) {
  if (error || data?.status === 'unavailable') return '暂时无法获取数据，可点击上方重试；页面会自动检查更新。';
  if (data?.status === 'pending') return '正在后台获取数据，完成后自动更新。';
  if (!data) return busy ? '正在获取数据…' : '等待获取数据。';
  if (data.status === 'partial') return '这部分数据尚未返回，其他可用内容仍可查看。';
  if (data.status === 'stale') return '暂未取得有效记录，正在等待数据源恢复。';
  return '数据源已响应，该查询暂无记录。';
}
