/** Disposable authenticated UI lab. Archives are replayed, never new model runs. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, open, access } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { prisma } from '../../src/lib/db/client';
import { hashAuthPassword } from '../../src/lib/auth/password';
import { ResearchArtifactStore, artifactDigest } from '../../src/lib/company-research/artifact-store';
import { researchRequestHash, canonicalResearchJson } from '../../src/lib/company-research/task-contracts';
import { getResearchTask } from '../../src/lib/company-research/version-store';
import { deterministicReportErrors } from '../../src/lib/company-research/verification-service';
import { semanticPublicationErrors } from '../../src/lib/company-research/claim-verification';
import type { ResearchReportRevision } from '../../src/lib/company-research/revision-contracts';
import { specFixture } from '../../src/lib/company-research/version-test-fixtures';

const exists = (file: string) => access(file).then(() => true, () => false);
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
async function main() {
  assert.equal(process.env.DATABASE_URL, process.env.RESEARCH_TEST_DATABASE_URL);
  const database = new URL(process.env.DATABASE_URL!);
  assert(['127.0.0.1', 'localhost'].includes(database.hostname) && database.pathname === '/research_test');
  const checkout = path.resolve(process.env.RESEARCH_DELIVERY_CHECKOUT || '');
  assert(checkout.startsWith(path.resolve('tmp/research-s16-s20') + path.sep), 'Disposable checkout required');
  assert(await exists(path.join(checkout, '.git')));
  const evidence = path.resolve(process.env.RESEARCH_DELIVERY_EVIDENCE!);
  assert(evidence.startsWith(path.resolve('data/research-agent-upgrade/evidence/S20') + path.sep));
  const archive = path.resolve(process.env.RESEARCH_DELIVERY_ARCHIVE!);
  assert(archive.startsWith(path.resolve('data/research-agent-upgrade/evidence/S19') + path.sep));
  const snapshot = await json(archive);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.report.revision, 1);
  const artifactRoot = path.resolve(path.dirname(archive), '..', 'artifacts');
  const artifactScopes = await readdir(artifactRoot);
  const targetStore = new ResearchArtifactStore(path.join(checkout, 'data/company-research/artifacts'));
  const actor = randomUUID(), email = 'admin@quantpilot.local';
  await prisma.authUser.create({ data: { id: actor, email, name: '本地交付验收', role: 'admin', emailVerified: true } });
  await prisma.authAccount.create({ data: { id: randomUUID(), providerId: 'credential', accountId: actor, userId: actor,
    password: await hashAuthPassword('admin', { allowDevelopmentDefault: true }) } });
  const id = snapshot.id, spec = snapshot.spec, plan = snapshot.plan;
  // Preserve report/task identities, reviewer hashes and original bytes. Only the
  // actor changes in this new database. The original evaluation stays untouched.
  await prisma.$executeRaw`INSERT INTO company_research_tasks(id,actor_id,request_key,payload_hash,status,request_revision,plan_revision,report_revision,generation,tool_calls,input_tokens,output_tokens,unknown_model_requests,created_at,started_at,deadline,checkpoint)
    VALUES (${id},${actor},${randomUUID()},${researchRequestHash(spec)},${snapshot.status},1,1,1,1,${snapshot.usage.toolCalls},${snapshot.usage.inputTokens},${snapshot.usage.outputTokens},${snapshot.usage.unknownModelRequests},${new Date(snapshot.createdAt)},${new Date(snapshot.usage.startedAt)},${new Date(snapshot.usage.deadline)},${JSON.stringify(snapshot.checkpoint)}::jsonb)`;
  await prisma.$executeRaw`INSERT INTO company_research_requests(task_id,revision,payload_hash,spec) VALUES (${id},1,${researchRequestHash(spec)},${JSON.stringify(spec)}::jsonb)`;
  await prisma.$executeRaw`INSERT INTO company_research_plans(task_id,revision,request_revision,request_key,payload_hash,plan) VALUES (${id},1,1,${randomUUID()},${artifactDigest(canonicalResearchJson(plan))},${JSON.stringify(plan)}::jsonb)`;
  for (const doc of snapshot.documents) {
    for (const ref of [doc.original, doc.parsed, doc.provenance?.evidence].filter(Boolean)) {
      const owner = (await Promise.all(artifactScopes.map(async scope => await exists(path.join(artifactRoot, scope, ref.key)) ? scope : null))).find(Boolean);
      assert(owner, 'Retained archive artifact missing');
      const bytes = await readFile(path.join(artifactRoot, owner!, ref.key));
      assert.equal(artifactDigest(bytes), ref.sha256); await targetStore.put(actor, bytes);
    }
    await prisma.$executeRaw`INSERT INTO company_research_documents(task_id,id,version,bytes_sha256,original_key,parsed_key,state,metadata) VALUES (${id},${doc.id},${doc.version},${doc.bytesSha256},${doc.original.key},${doc.parsed?.key || null},${doc.state},${JSON.stringify(doc)}::jsonb)`;
  }
  for (const review of snapshot.reviews) await prisma.$executeRaw`INSERT INTO company_research_claim_reviews(task_id,claim_hash,review) VALUES (${id},${review.claimHash},${JSON.stringify(review)}::jsonb)`;
  async function seedReport(report: ResearchReportRevision, generation: number) {
    const attempt = randomUUID(), now = new Date();
    await prisma.$executeRaw`INSERT INTO company_research_attempts(id,task_id,request_revision,plan_revision,generation,worker,status,lease_until,started_at,finished_at) VALUES (${attempt},${id},1,1,${generation},'delivery-archive-replay',${report.status},${now},${now},${now})`;
    await prisma.$executeRaw`INSERT INTO company_research_report_versions(task_id,revision,request_revision,plan_revision,attempt_id,generation,report) VALUES (${id},${report.revision},1,1,${attempt},${generation},${JSON.stringify(report)}::jsonb)`;
  }
  await seedReport(snapshot.report, 1);
  const restored = (await getResearchTask(actor, id, { db: prisma, artifacts: targetStore }))!;
  assert.equal(restored.reportHash, snapshot.reportHash);
  const hardErrors = (await deterministicReportErrors(actor, spec, restored.report!, { db: prisma, artifacts: targetStore })).errors;
  assert.deepEqual(hardErrors, []); assert.deepEqual(semanticPublicationErrors(restored.report!, restored.reviews), []);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'replay.json'), JSON.stringify({ sourceArchive: archive, sourceArchiveSha256: artifactDigest(await readFile(archive)), reportHash: restored.reportHash,
    scope: 'auth/Next/API/PG UI journey over an unchanged real-model archive; no new generation, publication or human acceptance', hardErrors }, null, 2));
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const p = (server.address() as net.AddressInfo).port; server.close(() => resolve(p)); });
  });
  const baseUrl = `http://127.0.0.1:${port}`, stopFile = path.join(evidence, 'stop');
  const log = await open(path.join(evidence, 'next.log'), 'w');
  const child = spawn(process.execPath, [path.join(checkout, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: checkout, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, QUANTPILOT_AUTH_MODE: 'local', QUANTPILOT_AUTH_SECRET: randomBytes(40).toString('hex'),
      BETTER_AUTH_URL: baseUrl, QUANTPILOT_AUTH_TRUSTED_ORIGINS: baseUrl, QUANTPILOT_AUTH_SECURE_COOKIES: '0', NEXT_PUBLIC_APP_URL: baseUrl, NEXT_TELEMETRY_DISABLED: '1' },
  });
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; }); process.on('SIGINT', () => { stopping = true; });
  try {
    for (let i = 0; i < 90; i++) {
      assert(child.exitCode === null, 'Next server exited; inspect next.log');
      try { const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) break; } catch { /* booting */ }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const anonymous = await fetch(`${baseUrl}/api/company-research/tasks`, { signal: AbortSignal.timeout(60000) });
    assert.equal(anonymous.status, 401);
    // Exercise the public identity -> create -> start boundary before replaying archives.
    // The market resolver is live; the worker stays stopped, so this journey costs no model calls.
    const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email, password: 'admin' }), signal: AbortSignal.timeout(60000) });
    assert.equal(login.status, 200, 'Disposable delivery login failed');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert(cookie, 'Missing delivery session cookie');
    const entryResults = [];
    for (const query of ['安迪苏', '601919']) {
      const resolved = await fetch(`${baseUrl}/api/company-research/resolve?query=${encodeURIComponent(query)}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(60000) });
      assert.equal(resolved.status, 200);
      const { companies } = await resolved.json() as { companies: { symbol: string; name: string }[] };
      assert.equal(companies.length, 1, 'Expected an unambiguous live security identity');
      const company = companies[0], code = company.symbol.split('.')[0];
      const exchange = code.startsWith('6') ? 'SH' : /^[03]/.test(code) ? 'SZ' : 'BJ';
      const spec = { ...specFixture(), company: { symbol: `${code}.${exchange}`, exchange, name: company.name } };
      const created = await fetch(`${baseUrl}/api/company-research/tasks`, { method: 'POST',
        headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(spec), signal: AbortSignal.timeout(60000) });
      assert.equal(created.status, 201, `Entry create failed for ${query}`);
      const { task: createdTask } = await created.json() as { task: { id: string; planRevision: number } };
      const started = await fetch(`${baseUrl}/api/company-research/tasks/${createdTask.id}/start`, { method: 'POST',
        headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedPlanRevision: createdTask.planRevision }), signal: AbortSignal.timeout(60000) });
      assert.equal(started.status, 202);
      const queued = (await getResearchTask(actor, createdTask.id))!;
      assert.equal(queued.status, 'queued'); assert.equal(queued.spec.company.symbol, spec.company.symbol);
      assert.equal(queued.usage.toolCalls, 0); assert.equal(queued.usage.unknownModelRequests, 0);
      const cancelled = await fetch(`${baseUrl}/api/company-research/tasks/${createdTask.id}/cancel`, { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl }, signal: AbortSignal.timeout(60000) });
      assert.equal(cancelled.status, 200);
      entryResults.push({ query, company: spec.company, taskId: createdTask.id, resolveStatus: resolved.status, createStatus: created.status, startStatus: started.status, status: queued.status, modelRequests: 0 });
    }
    await writeFile(path.join(evidence, 'entry-journey.json'), JSON.stringify({ source: 'live market resolver + authenticated Next HTTP + disposable PostgreSQL', entries: entryResults, workerStarted: false }, null, 2));
    await writeFile(path.join(evidence, 'runtime.json'), JSON.stringify({ baseUrl, taskId: id, actor, nextPid: child.pid, anonymousStatus: anonymous.status, archiveHash: restored.reportHash,
      scenario: 'read archive, source, revise plan, refresh, cancel; no model worker started', stopFile }, null, 2));
    console.log(`Authenticated delivery lab ready at ${baseUrl}/company-research; stop via ${stopFile}`);
    if (process.env.RESEARCH_DELIVERY_AUTOMATED_ONLY === '1') return;
    while (!stopping && !(await exists(stopFile))) await new Promise(resolve => setTimeout(resolve, 1000));
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000).unref(); });
    await log.close();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
