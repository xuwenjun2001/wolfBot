import { ledgerCoverage } from './ledger';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { hash } from './evidence';
import { type Company, type PublicRun, type ResearchState, type ResearchStatus, type TraceStep } from './contracts';

export interface StoredRun {
  id: string; actor_id: string; payload_hash: string; status: ResearchStatus;
  state: ResearchState; steps: TraceStep[]; created_at: Date; started_at: Date | null;
  finished_at: Date | null; lease_owner: string | null; generation: number; sequence: number;
  cancel_requested: boolean; error: string | null;
}
export function publicRun(run: StoredRun): PublicRun {
  return { phase: run.state.phase, deadline: run.state.deadline, stopReason: run.state.stopReason, systemEvents: run.state.systemEvents, ...(run.state.version === 2 ? { coverage: ledgerCoverage(run.state) } : {}), id: run.id, company: run.state.company, asOf: run.state.asOf, status: run.status,
    createdAt: run.created_at.toISOString(), startedAt: run.started_at?.toISOString() ?? null,
    finishedAt: run.finished_at?.toISOString() ?? null, error: run.error, steps: run.steps,
    report: run.state.draft, sources: run.state.sources.map(({ content: _content, ...source }) => source),
    usage: { inputTokens: run.state.inputTokens, outputTokens: run.state.outputTokens } };
}
export async function createRun(actor: string, company: Company, key: string) {
  const payloadHash = hash(company);
  const state: ResearchState = { version: 2, phase: 'investigating', evidence: {}, sections: {}, company, asOf: new Date().toISOString(), sources: [], draft: null,
    supplementRounds: 0, coverageChecks: 0, lastCoverageHash: null, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, submitted: false, notes: [] };
  const rows = await prisma.$queryRaw<StoredRun[]>`
    INSERT INTO company_research_runs (id,actor_id,request_key,payload_hash,state)
    VALUES (${randomUUID()},${actor},${key},${payloadHash},${JSON.stringify(state)}::jsonb)
    ON CONFLICT (actor_id,request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *`;
  if (rows[0].payload_hash !== payloadHash) throw new Error('IDEMPOTENCY_CONFLICT');
  return publicRun(rows[0]);
}
export async function listRuns(actor: string) {
  // History does not load potentially large document snapshots or report bodies.
  const rows = await prisma.$queryRaw<StoredRun[]>`SELECT id,status,created_at,started_at,finished_at,error,
    '[]'::jsonb AS steps,
    jsonb_build_object('company',state->'company','asOf',state->'asOf','sources','[]'::jsonb,
      'draft',NULL,'inputTokens',state->'inputTokens','outputTokens',state->'outputTokens') AS state
    FROM company_research_runs WHERE actor_id=${actor} ORDER BY created_at DESC LIMIT 30`;
  return rows.map(publicRun);
}
export async function getRun(actor: string, id: string) {
  const rows = await prisma.$queryRaw<StoredRun[]>`SELECT * FROM company_research_runs WHERE id=${id} AND actor_id=${actor}`;
  return rows[0] ?? null;
}
export async function cancelRun(actor: string, id: string) {
  return prisma.$executeRaw`UPDATE company_research_runs SET cancel_requested=true,
    status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
    finished_at=CASE WHEN status='queued' THEN NOW() ELSE finished_at END
    WHERE id=${id} AND actor_id=${actor} AND status IN ('queued','running')`;
}
export async function claimRun(owner: string): Promise<StoredRun | null> {
  const rows = await prisma.$queryRaw<StoredRun[]>`
    UPDATE company_research_runs SET status='running',lease_owner=${owner},lease_until=NOW()+INTERVAL '60 seconds',
      generation=generation+1,started_at=COALESCE(started_at,NOW())
    WHERE id=(SELECT id FROM company_research_runs
      WHERE status='queued' OR (status='running' AND lease_until<NOW())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
  return rows[0] ?? null;
}
export async function heartbeat(run: StoredRun): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ cancel_requested: boolean }[]>`
    UPDATE company_research_runs SET lease_until=NOW()+INTERVAL '60 seconds'
    WHERE id=${run.id} AND lease_owner=${run.lease_owner} AND generation=${run.generation}
      AND lease_until>NOW() AND status='running' RETURNING cancel_requested`;
  if (!rows.length) throw new Error('RESEARCH_LEASE_LOST');
  return rows[0].cancel_requested;
}
/** State, evidence, report and event advance atomically under the worker fencing token. */
export async function checkpoint(run: StoredRun, status: ResearchStatus = 'running', error: string | null = null) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<StoredRun[]>`
      UPDATE company_research_runs SET state=${JSON.stringify(run.state)}::jsonb,steps=${JSON.stringify(run.steps)}::jsonb,
        status=CASE WHEN cancel_requested AND ${status} <> 'running' THEN 'cancelled' ELSE ${status} END,
        error=${error},sequence=sequence+1,
        finished_at=CASE WHEN ${status}='running' THEN NULL ELSE NOW() END,
        lease_until=NOW()+INTERVAL '60 seconds'
      WHERE id=${run.id} AND lease_owner=${run.lease_owner} AND generation=${run.generation}
        AND lease_until>NOW() AND status='running' RETURNING *`;
    if (!rows.length) throw new Error('RESEARCH_LEASE_LOST');
    for (const source of run.state.sources) {
      await tx.$executeRaw`INSERT INTO company_research_sources (run_id,id,document)
        VALUES (${run.id},${source.id},${JSON.stringify(source)}::jsonb)
        ON CONFLICT (run_id,id) DO UPDATE SET document=EXCLUDED.document`;
    }
    if (run.state.draft) await tx.$executeRaw`INSERT INTO company_research_reports (run_id,report)
      VALUES (${run.id},${JSON.stringify(run.state.draft)}::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET report=EXCLUDED.report`;
    const snapshot = publicRun(rows[0]);
    await tx.$executeRaw`INSERT INTO company_research_events (run_id,sequence,payload)
      VALUES (${run.id},${rows[0].sequence},${JSON.stringify(snapshot)}::jsonb)`;
    run.sequence = rows[0].sequence;
    return snapshot;
  }, { timeout: 15000 });
}
export async function eventsAfter(actor: string, id: string, after: number) {
  return prisma.$queryRaw<{ sequence: number; payload: PublicRun }[]>(Prisma.sql`
    SELECT e.sequence,e.payload FROM company_research_events e JOIN company_research_runs r ON r.id=e.run_id
    WHERE e.run_id=${id} AND r.actor_id=${actor} AND e.sequence>${after} ORDER BY e.sequence LIMIT 100`);
}
