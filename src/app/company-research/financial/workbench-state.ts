import type { getResearchTask } from '@/lib/company-research/version-store';
import type { ResearchVersionEvent } from '@/lib/company-research/revision-contracts';
export type FinancialTask = NonNullable<Awaited<ReturnType<typeof getResearchTask>>>;
export type StreamState = { taskId: string | null; snapshot: FinancialTask | null; eventSequence: number; needsSnapshot: boolean };
export const emptyStreamState: StreamState = { taskId: null, snapshot: null, eventSequence: 0, needsSnapshot: false };
export function acceptSnapshot(state: StreamState, selectedId: string, snapshot: FinancialTask): StreamState {
  if (snapshot.id !== selectedId || state.taskId !== selectedId) return state;
  if (state.snapshot && (snapshot.sequence < state.snapshot.sequence || snapshot.generation < state.snapshot.generation)) return state;
  return { ...state, snapshot, eventSequence: Math.max(state.eventSequence, snapshot.sequence), needsSnapshot: snapshot.sequence < state.eventSequence };
}
export function acceptResearchEvent(state: StreamState, event: ResearchVersionEvent): StreamState {
  if (event.taskId !== state.taskId || event.sequence <= state.eventSequence || event.generation < (state.snapshot?.generation || 0)) return state;
  // Events are invalidations. A snapshot is the sole authority for plan/claim/report data.
  return { ...state, eventSequence: event.sequence, needsSnapshot: true };
}
export const isFinancialTerminal = (status: string) => ['completed', 'partial', 'failed', 'cancelled'].includes(status);
export const financialStatusLabels: Record<string, string> = { draft: '草稿', queued: '等待执行', running: '研究中', partial: '部分完成', completed: '核验完成', failed: '执行失败', cancelled: '已取消' };
