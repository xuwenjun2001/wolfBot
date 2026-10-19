import { it, expect } from 'vitest';
import { acceptSnapshot, acceptResearchEvent, emptyStreamState, type FinancialTask } from './workbench-state';
const snapshot = (id = 'a', sequence = 10, generation = 2) => ({ id, sequence, generation } as FinancialTask);
it('merges authoritative reconnect snapshots and ignores duplicate, late and switched-task data', () => {
  const initial = { ...emptyStreamState, taskId: 'a' };
  const state = acceptSnapshot(initial, 'a', snapshot());
  expect(acceptSnapshot(state, 'a', snapshot('b'))).toBe(state);
  expect(acceptSnapshot(state, 'a', snapshot('a', 9))).toBe(state);
  expect(acceptSnapshot(state, 'a', snapshot('a', 11, 1))).toBe(state);
  const event = { taskId: 'a', sequence: 12, generation: 2 } as Parameters<typeof acceptResearchEvent>[1];
  const gap = acceptResearchEvent(state, event); expect(gap.needsSnapshot).toBe(true);
  expect(gap.snapshot).toBe(state.snapshot);
  expect(acceptResearchEvent(gap, event)).toBe(gap);
  expect(acceptResearchEvent(gap, { ...event, sequence: 11 })).toBe(gap);
  expect(acceptSnapshot(gap, 'a', snapshot('a', 12)).needsSnapshot).toBe(false);
  const switched = { ...emptyStreamState, taskId: 'b' };
  expect(acceptResearchEvent(switched, event)).toBe(switched);
  expect(acceptSnapshot(switched, 'b', snapshot())).toBe(switched);
});
