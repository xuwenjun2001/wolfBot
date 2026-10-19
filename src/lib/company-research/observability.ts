import type { ResearchAttemptToken } from './attempt-store';

export type ResearchObservation = {
  schemaVersion: 1; service: 'company-research'; at: string; event: string;
  taskId: string; attemptId: string; requestRevision: number; planRevision: number;
  reportRevision: number; generation: number;
  stage?: 'model' | 'acquisition' | 'parsing' | 'retrieval' | 'verification' | 'delivery' | 'worker';
  tool?: string; outcome?: string; durationMs?: number; inputTokens?: number; outputTokens?: number;
  usageKnown?: boolean; toolCalls?: number; unknownModelRequests?: number;
  rssBytes?: number; cpuUserMicros?: number; cpuSystemMicros?: number; pid?: number; cost: 'unknown';
};
export type ResearchObservationSink = (record: ResearchObservation) => void;
const stdout: ResearchObservationSink = record => console.log(JSON.stringify(record));
export function researchToolStage(tool: string): ResearchObservation['stage'] {
  if (tool === 'parse_document') return 'parsing';
  if (['search_evidence', 'read_evidence'].includes(tool)) return 'retrieval';
  if (['record_fact', 'record_claim', 'verify_claim', 'check_coverage'].includes(tool)) return 'verification';
  if (tool === 'submit_report') return 'delivery';
  return 'acquisition';
}

/** Allowlisted metadata only: no actor, prompts, arguments, documents or error text. */
export function researchObserver(token: ResearchAttemptToken, reportRevision: number, sink: ResearchObservationSink = stdout) {
  const start = performance.now(), cpu = process.cpuUsage();
  function emit(event: string, fields: Omit<Partial<ResearchObservation>, 'taskId' | 'attemptId' | 'requestRevision' | 'planRevision' | 'reportRevision' | 'generation'> = {}) {
    const record: ResearchObservation = { ...fields, schemaVersion: 1, service: 'company-research', at: new Date().toISOString(), event,
      taskId: token.taskId, attemptId: token.id, requestRevision: token.requestRevision, planRevision: token.planRevision,
      reportRevision, generation: token.generation, cost: 'unknown' };
    try { sink(record); } catch { /* A broken logging sink cannot change persistence or execution rights. */ }
  }
  return { emit, reportCommitted(revision: number, outcome: string) { reportRevision = revision; emit('report.committed', { stage: 'delivery', outcome }); }, finish(outcome: string, revision = reportRevision) {
    const elapsedCpu = process.cpuUsage(cpu); reportRevision = revision;
    emit('attempt.finished', { stage: 'worker', outcome, durationMs: Math.round(performance.now() - start), pid: process.pid,
      rssBytes: process.memoryUsage().rss, cpuUserMicros: elapsedCpu.user, cpuSystemMicros: elapsedCpu.system });
  } };
}
