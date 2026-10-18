'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardDataSchema, type DashboardData, type DashboardResource } from '@/lib/quant/market-dashboard-types';
import { dashboardEmptyMessage, retainDashboardData } from './dashboard-display';

export function useDashboard(resource: DashboardResource | null, params: Record<string, string> = {}, refreshKey = 0) {
  const query = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString();
  const key = `${resource}?${query}`;
  const [snapshot, setSnapshot] = useState<{ key: string; data: DashboardData } | null>(null);
  const data = snapshot?.key === key ? snapshot.data : null;
  const [busy, setBusy] = useState(false);
  const [failureState, setFailureState] = useState({ key: '', message: '' });
  const error = failureState.key === key ? failureState.message : '';
  const active = useRef<AbortController | null>(null);
  const retry = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const [retryState, setRetryState] = useState({ key: '', at: 0 });
  const load = useCallback(async () => {
    if (!resource || document.visibilityState === 'hidden' || active.current || (retry.current.key === key && Date.now() < retry.current.at)) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setFailureState({ key, message: '' });
    const timer = setTimeout(() => controller.abort('timeout'), 30_000);
    try {
      const response = await fetch(`/api/quant/market-dashboard/${resource}?${query}`, {
        signal: controller.signal, cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || `请求失败（${response.status}）`);
      const parsed = dashboardDataSchema.parse(payload.data);
      if (active.current === controller) {
        setSnapshot(previous => ({ key, data: retainDashboardData(previous?.key === key ? previous.data : null, parsed) }));
        const at = parsed.status === 'unavailable' || parsed.status === 'stale' ? Date.now() + 20_000 : 0;
        retry.current = { key, at }; setRetryState({ key, at });
      }
    } catch (failure) {
      if (active.current === controller) {
        setFailureState({ key, message: controller.signal.aborted ? '行情请求超时，稍后自动重试。' : failure instanceof TypeError ? '网络连接失败，恢复后可重试。' : '行情更新失败，请稍后重试。' });
        const at = Date.now() + 20_000; retry.current = { key, at }; setRetryState({ key, at });
      }
    } finally {
      clearTimeout(timer);
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }, [resource, query, key]);
  useEffect(() => {
    // A new query must never present the prior symbol/date as the selected data.
    const kickoff = setTimeout(() => { void load(); }, 0);
    const interval = setInterval(() => void load(), 60_000);
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearTimeout(kickoff); clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
      const controller = active.current; active.current = null; controller?.abort();
    };
  }, [load, refreshKey]);
  return { data, busy, error, reload: load, retryAt: retryState.key === key ? retryState.at : 0,
    emptyMessage: dashboardEmptyMessage(data, busy, error) };
}
