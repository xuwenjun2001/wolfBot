'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { acceptResearchEvent, acceptSnapshot, emptyStreamState, isFinancialTerminal, type FinancialTask, type StreamState } from './workbench-state';

export async function researchApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/company-research/${path}`, { cache: 'no-store', ...init });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '研究请求失败'); return data;
}
export function useFinancialResearch() {
  const [selectedId, setSelectedId] = useState<string | null>(null), [state, setState] = useState<StreamState>(emptyStreamState);
  const [tasks, setTasks] = useState<{id: string; status: string; spec: FinancialTask['spec']; createdAt: string}[]>([]);
  const [error, setError] = useState(''), [connected, setConnected] = useState(false), epoch = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const refreshList = useCallback(async () => { setTasks((await researchApi<{tasks: typeof tasks}>('tasks')).tasks); }, []);
  const selectTask = useCallback((id: string) => {
    if (selectedRef.current === id) return;
    selectedRef.current = id;
    ++epoch.current; setState({ ...emptyStreamState, taskId: id }); setError(''); setSelectedId(id);
    const url = new URL(window.location.href); url.searchParams.set('task', id); window.history.replaceState(null, '', url);
  }, []);
  useEffect(() => {
    void refreshList().catch(e => setError(e.message));
    const id = new URL(window.location.href).searchParams.get('task'); if (id) selectTask(id);
  }, [refreshList, selectTask]);
  useEffect(() => {
    if (!selectedId) return;
    const currentEpoch = ++epoch.current, controller = new AbortController(); let stream: EventSource | null = null, timer: ReturnType<typeof setTimeout> | null = null;
    const current = () => epoch.current === currentEpoch && !controller.signal.aborted;
    const apply = (task: FinancialTask) => { if (current()) setState(s => acceptSnapshot(s, selectedId, task)); };
    const load = async () => { const { task } = await researchApi<{task: FinancialTask}>(`tasks/${selectedId}`, { signal: controller.signal }); apply(task); return task; };
    const connect = () => {
      if (!current()) return;
      stream?.close(); stream = new EventSource(`/api/company-research/tasks/${selectedId}/events`);
      stream.addEventListener('snapshot', e => {
        if (!current()) return;
        try { const task = JSON.parse((e as MessageEvent).data) as FinancialTask; apply(task); setConnected(true);
          if (task.id === selectedId && isFinancialTerminal(task.status)) { stream?.close(); void refreshList().catch(() => {}); }
        } catch { setError('事件数据无效，正在恢复服务端状态'); reconnect(); }
      });
      stream.addEventListener('research', e => {
        if (!current()) return;
        try { const event = JSON.parse((e as MessageEvent).data); setState(s => acceptResearchEvent(s, event)); }
        catch { reconnect(); }
      });
      stream.addEventListener('unavailable', reconnect); stream.onerror = reconnect;
    };
    const reconnect = () => {
      if (!current()) return;
      stream?.close(); setConnected(false); if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void load().then(task => { if (current() && !isFinancialTerminal(task.status)) connect(); }).catch(e => { if (current()) { setError(e.message); reconnect(); } }); }, 2000);
    };
    setConnected(false);
    void load().then(task => { if (current()) { if (!isFinancialTerminal(task.status)) connect(); else setConnected(true); } }).catch(e => { if (current()) { setError(e.message); reconnect(); } });
    return () => { controller.abort(); stream?.close(); if (timer) clearTimeout(timer); };
  }, [selectedId, refreshList]);
  const refreshTask = useCallback(async () => {
    const id = selectedRef.current, currentEpoch = epoch.current; if (!id) return;
    const { task } = await researchApi<{task: FinancialTask}>(`tasks/${id}`);
    if (selectedRef.current === id && epoch.current === currentEpoch) setState(s => acceptSnapshot(s, id, task));
  }, []);
  return { task: state.snapshot, tasks, selectTask, refreshList, refreshTask, connected, error, setError, selectedId };
}
