import '../workers/worker-environment';
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/db/client';
import { ResearchArtifactStore, artifactDigest } from '../../src/lib/company-research/artifact-store';
import { researchTaskSpecSchema } from '../../src/lib/company-research/task-contracts';
import { researchDocumentSchema } from '../../src/lib/company-research/document-contracts';
import { parsedDocumentV2Schema } from '../../src/lib/company-research/parsed-document';
import { registerResearchDocument } from '../../src/lib/company-research/document-store';
import { createResearchTask, getResearchTask } from '../../src/lib/company-research/version-store';
import { queueFinancialResearch, claimFinancialResearch } from '../../src/lib/company-research/execution-store';
import { executeFinancialResearch } from '../../src/lib/company-research/financial-runtime';
import { cninfoDisclosure } from '../../src/lib/company-research/filing-acquisition';
import { researchConfig, safeError } from '../../src/lib/company-research/config';
import { readResearchSource } from '../../src/lib/company-research/source-reader';
import { reviewerCalibration } from '../../src/lib/company-research/claim-reviewer';
import { verifyRetainedScanReader } from './verify-source-reader';

type Meta = {id: string; path: string; period: {start: string; end: string; kind: 'annual'}; title: string; url: string; bytesSha256: string; retrievedAt: string};
async function main() {
  const u = new URL(process.env.DATABASE_URL!);
  if (process.env.DATABASE_URL !== process.env.RESEARCH_TEST_DATABASE_URL || !['localhost', '127.0.0.1'].includes(u.hostname) || u.pathname !== '/research_test') throw new Error('Disposable database required');
  const root = path.resolve('data/research-agent-upgrade/evidence/S13', new Date().toISOString().replace(/[:.]/g, '-')); await mkdir(root, { recursive: true });
  console.log(`Financial evidence root: ${root}`);
  if (!process.env.COMPANY_RESEARCH_REVIEW_CALIBRATION) {
    const versions = (await readdir('data/research-agent-upgrade/evidence/S12')).sort().reverse();
    process.env.COMPANY_RESEARCH_REVIEW_CALIBRATION = path.resolve('data/research-agent-upgrade/evidence/S12', versions[0], 'calibration.json');
  }
  const calibrationHash = await reviewerCalibration(); if (!calibrationHash) throw new Error('Calibrated reviewer required');
  const manifest = JSON.parse(await readFile('fixtures/company-research/documents.json', 'utf8')) as {documents: Meta[]};
  const dataset = JSON.parse(await readFile('fixtures/company-research/development.json', 'utf8'));
  const sample = dataset.cases.find((c: {id: string}) => c.id === 'dev-600519');
  const config = researchConfig(), ctx = { db: prisma, artifacts: new ResearchArtifactStore(path.join(root, 'artifacts')) }, actor = `financial-e2e-${randomUUID()}`;
  const results = [];
  const parsedRoot = 'data/research-agent-upgrade/evidence/S07/2026-10-18T17-44-58-299Z';
  for (const mode of ['complete-corpus', 'missing-second-period'] as const) {
    const started = Date.now();
    const spec = researchTaskSpecSchema.parse({ schemaVersion: 1, kind: 'financial_change', requestRevision: 1, company: { ...sample.company, exchange: 'SH' },
      periods: [2023, 2024].map(y => ({ id: `FY${y}`, start: `${y}-01-01`, end: `${y}-12-31`, kind: 'annual', basis: 'cumulative' })),
      asOf: sample.asOf, scope: 'consolidated', currency: 'CNY', comparison: { status: 'comparable' },
      questions: sample.questions.map((q: {id: string; text: string}, i: number) => ({ id: ['income_profit', 'cash_flow', 'risks'][i], text: q.text })), budget: { maxToolCalls: 40, timeoutMs: 1200000 } });
    const task = (await createResearchTask(actor, spec, randomUUID(), ctx))!;
    for (const meta of manifest.documents.filter(d => sample.documentIds.includes(d.id) && (mode === 'complete-corpus' || d.period.end.startsWith('2023')))) {
      const original = await readFile(meta.path), parsed = await readFile(path.join(parsedRoot, `${meta.id}.json`)), receipt = parsedDocumentV2Schema.parse(JSON.parse(parsed.toString()));
      assert.equal(artifactDigest(original), meta.bytesSha256);
      const announcement = await readFile(meta.path.replace(/\.pdf$/, '.announcement.json'));
      const doc = researchDocumentSchema.parse({ schemaVersion: 1, id: meta.id, taskId: task.id, version: 1, company: spec.company, period: spec.periods.find(p => p.end === meta.period.end), title: meta.title, url: meta.url, mediaType: 'application/pdf', bytesSha256: meta.bytesSha256, fetchedAt: meta.retrievedAt,
        original: { store: 'local', key: meta.bytesSha256, sha256: meta.bytesSha256, byteLength: original.length }, parsed: { store: 'local', key: artifactDigest(parsed), sha256: artifactDigest(parsed), byteLength: parsed.length },
        state: receipt.status, pageCount: receipt.pageCount, parser: { ...receipt.parser, failedPages: receipt.failedPages, warnings: receipt.warnings }, disclosure: cninfoDisclosure(JSON.parse(announcement.toString()), announcement, 'https://www.cninfo.com.cn/new/hisAnnouncement/query').disclosure });
      await registerResearchDocument(actor, doc, original, parsed, ctx);
    }
    await queueFinancialResearch(actor, task.id, 0, ctx);
    const claim = await claimFinancialResearch('financial-e2e', ctx); assert.equal(claim?.attempt.taskId, task.id);
    console.log(`${mode}: model ${config.model}, task ${task.id}`);
    try { await executeFinancialResearch(actor, claim!.attempt, undefined, ctx, undefined, true, record => appendFile(path.join(root, `${mode}-tools.jsonl`), JSON.stringify(record) + '\n')); }
    catch (error) { await writeFile(path.join(root, `${mode}-error.json`), JSON.stringify({ error: safeError(error) })); }
    const snapshot = (await getResearchTask(actor, task.id, ctx))!;
    await writeFile(path.join(root, `${mode}.json`), JSON.stringify(snapshot, null, 2));
    const sources = [];
    for (const c of snapshot.report?.claims || []) for (let i = 0; i < c.citations.length; i++) sources.push(await readResearchSource(actor, task.id, { reportRevision: snapshot.reportRevision, claimId: c.id, citationIndex: i }, ctx));
    for (const f of snapshot.report?.facts || []) for (let i = 0; i < f.citations.length; i++) sources.push(await readResearchSource(actor, task.id, { reportRevision: snapshot.reportRevision, factId: f.id, citationIndex: i }, ctx));
    await writeFile(path.join(root, `${mode}-sources.json`), JSON.stringify(sources, null, 2));
    const numeric = sample.reference.facts.map((f: {metric: string; period: {end: string}; normalizedYuan: string}) => ({ metric: f.metric, period: f.period.end,
      expected: f.normalizedYuan, actual: snapshot.report?.facts.find(v => v.metric === f.metric && v.period.end === f.period.end)?.normalization?.normalizedYuan || null }));
    results.push({ mode, taskId: task.id, status: snapshot.status, elapsedMs: Date.now() - started, usage: snapshot.usage, numeric, humanReview: 'pending-new-generated-report', reportSha256: artifactDigest(JSON.stringify(snapshot.report)) });
    console.log(`${mode}: ${snapshot.status}, tools ${snapshot.usage.toolCalls}, numbers ${numeric.filter((n: {actual: string; expected: string}) => n.actual === n.expected).length}/6`);
    await writeFile(path.join(root, 'report.json'), JSON.stringify({ baseline: 'G0-financial-change-v1', mode: 'real PI/model and repositories over fixed full public PDFs; no live acquisition; not a comparison to S03 legacy', model: config.model, reasoning: config.reasoning, calibrationHash,
      humanReferenceAcceptanceSha256: artifactDigest(await readFile('data/research-agent-upgrade/annotations/2026-10-19-ai-assisted-01/acceptance.json')), rubricSha256: artifactDigest(await readFile('fixtures/company-research/rubric.json')), results, cost: 'unknown' }, null, 2));
  }
  const complete = results.find(r => r.mode === 'complete-corpus')!, partial = results.find(r => r.mode === 'missing-second-period')!;
  await writeFile(path.join(root, 'scan-reader-verification.json'), JSON.stringify(await verifyRetainedScanReader(root, actor, ctx), null, 2));
  assert.equal(complete.status, 'completed'); assert(complete.numeric.every((n: {actual: string; expected: string}) => n.actual === n.expected));
  assert.equal(partial.status, 'partial');
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
