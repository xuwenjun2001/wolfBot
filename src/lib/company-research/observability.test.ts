import { describe, expect, it } from 'vitest';
import { researchObserver, researchToolStage, type ResearchObservation } from './observability';

describe('research operational telemetry', () => {
  it('correlates attempts with immutable versions without logging source or user content', () => {
    const records: ResearchObservation[] = [];
    const observer = researchObserver({ id: 'attempt', taskId: 'task', requestRevision: 2, planRevision: 3, generation: 4, worker: 'worker' }, 1, r => records.push(r));
    observer.emit('model.finished', { stage: 'model', usageKnown: false }); observer.finish('partial', 2);
    expect(records[0]).toMatchObject({ taskId: 'task', attemptId: 'attempt', requestRevision: 2, planRevision: 3, generation: 4, reportRevision: 1, usageKnown: false, cost: 'unknown' });
    expect(records[1]).toMatchObject({ reportRevision: 2, outcome: 'partial', rssBytes: expect.any(Number), cpuUserMicros: expect.any(Number) });
    expect(Object.keys(records[0]).sort()).not.toEqual(expect.arrayContaining(['actor', 'prompt', 'data', 'error', 'arguments']));
    expect(researchToolStage('parse_document')).toBe('parsing'); expect(researchToolStage('search_evidence')).toBe('retrieval');
  });
  it('keeps logging failures from changing the research result', () => {
    const observer = researchObserver({ id: 'a', taskId: 't', requestRevision: 1, planRevision: 1, generation: 1, worker: 'w' }, 0, () => { throw new Error('sink down'); });
    expect(() => observer.finish('partial')).not.toThrow();
  });
});
