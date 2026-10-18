import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';
import { canonicalResearchJson } from '../../src/lib/company-research/task-contracts';

async function main() {
  if (!process.env.RESEARCH_LEGACY_STORE || !process.env.RESEARCH_COMPAT_FIXTURE || !process.env.RESEARCH_TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.RESEARCH_TEST_DATABASE_URL) throw new Error('Isolated runner environment required');
  const legacy = require(process.env.RESEARCH_LEGACY_STORE) as typeof import('../../src/lib/company-research/store');
  const { emptyReport } = require(process.env.RESEARCH_LEGACY_STORE.replace(/store\.ts$/, 'contracts.ts')) as typeof import('../../src/lib/company-research/contracts');
  const { prisma } = await import('../../src/lib/db/client');
  const stage = process.argv[2], fixturePath = process.env.RESEARCH_COMPAT_FIXTURE;
  try {
    if (stage === 'before') {
      const actor = `research-legacy-compat-${randomUUID()}`, key = randomUUID(), company = { symbol: '600519', name: '兼容性测试公司' };
      const created = await legacy.createRun(actor, company, key), run = await legacy.claimRun('legacy-before-upgrade');
      if (!run || run.id !== created.id) throw new Error('Legacy fixture claim mismatch');
      run.state.draft = emptyReport('Synthetic persistence compatibility fixture; no model or quality claim');
      await legacy.checkpoint(run, 'completed');
      const stored = await legacy.getRun(actor, created.id);
      const queued = await legacy.createRun(actor, company, randomUUID());
      await writeFile(fixturePath, JSON.stringify({ actor, key, company, id: created.id, queuedId: queued.id, snapshotSha256: artifactDigest(canonicalResearchJson(legacy.publicRun(stored!))) }, null, 2) + '\n');
      console.log('Old code created a report and queued recovery fixture before migration');
    } else if (stage === 'after') {
      const f = JSON.parse(await readFile(fixturePath, 'utf8')), stored = await legacy.getRun(f.actor, f.id);
      if (!stored || artifactDigest(canonicalResearchJson(legacy.publicRun(stored))) !== f.snapshotSha256) throw new Error('Old reader changed historical report');
      if ((await legacy.createRun(f.actor, f.company, f.key)).id !== f.id || await legacy.getRun('other-actor', f.id)) throw new Error('Legacy identity/idempotency compatibility failed');
      const current = await import('../../src/lib/company-research/store'), compatibility = await import('../../src/lib/company-research/compatibility');
      const newReader = await current.getRun(f.actor, f.id);
      if (compatibility.readResearchReport(newReader!.state.draft).format !== 'legacy') throw new Error('Current reader cannot read old report');
      const { createResearchTask, getResearchTask } = await import('../../src/lib/company-research/version-store');
      const { specFixture } = await import('../../src/lib/company-research/version-test-fixtures');
      const draft = await createResearchTask(f.actor, specFixture(), randomUUID());
      const recovered = await legacy.claimRun('legacy-code-rollback-probe');
      if (!recovered || recovered.id !== f.queuedId) throw new Error('Legacy worker consumed the wrong task');
      await legacy.checkpoint(recovered, 'partial', 'Synthetic old-worker recovery after upgrade');
      if ((await getResearchTask(f.actor, draft!.id))?.status !== 'draft') throw new Error('Old worker consumed new-schema draft');
      console.log('Old and current readers retain old report; old code can claim/checkpoint after upgrade; new draft remains isolated');
    } else throw new Error('Expected before/after stage');
  } finally { await prisma.$disconnect(); }
}
void main().catch(e => { console.error(e.message); process.exitCode = 1; });
