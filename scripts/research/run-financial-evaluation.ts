import '../workers/worker-environment';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { prisma } from '../../src/lib/db/client';
import { ResearchArtifactStore, artifactDigest } from '../../src/lib/company-research/artifact-store';
import { researchTaskSpecSchema, canonicalResearchJson } from '../../src/lib/company-research/task-contracts';
import { researchDocumentSchema } from '../../src/lib/company-research/document-contracts';
import { parsedDocumentV2Schema } from '../../src/lib/company-research/parsed-document';
import { NativePdfParser } from '../../src/lib/company-research/text-parser';
import { cninfoDisclosure } from '../../src/lib/company-research/filing-acquisition';
import { registerResearchDocument } from '../../src/lib/company-research/document-store';
import { createResearchTask, getResearchTask } from '../../src/lib/company-research/version-store';
import { queueFinancialResearch } from '../../src/lib/company-research/execution-store';
import { startResearchAttempt } from '../../src/lib/company-research/attempt-store';
import { executeFinancialResearch } from '../../src/lib/company-research/financial-runtime';
import { researchConfig, safeError } from '../../src/lib/company-research/config';
import { reviewerCalibration, reviewerPrompt } from '../../src/lib/company-research/claim-reviewer';
import { financialResearchPrompt, researchSkillVersion, type FinancialResearchSkill } from '../../src/lib/company-research/execution-contracts';
import { deterministicReportErrors, readClaimReviews } from '../../src/lib/company-research/verification-service';
import { semanticPublicationErrors } from '../../src/lib/company-research/claim-verification';
import { readResearchSource } from '../../src/lib/company-research/source-reader';
import { scoreFinancialCase, summarizeScores } from '../../src/lib/eval/financial-research-score';
import { controlledExternalRoot, normalizeHoldoutTasks, type FinancialEvaluationInput } from '../checks/financial-evaluation-inputs';

type Meta = { id: string; symbol: string; companyName?: string; title: string; url: string; path: string; bytesSha256: string; retrievedAt: string; period: {start: string; end: string; kind: 'annual'} };
const parsedRoot = 'data/research-agent-upgrade/evidence/S07/2026-10-18T17-44-58-299Z';
const args = process.argv.slice(2);
const option = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const phase = option('phase'), campaign = path.resolve(option('campaign') || process.env.RESEARCH_EVALUATION_CAMPAIGN || '');
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const hashFile = async (file: string) => artifactDigest(await readFile(file));
async function codeHashes() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {encoding: 'utf8'}).trim().split(/\r?\n/)
    .filter(f => /^(?:src\/lib\/(?:company-research|agent)\/|src\/lib\/eval\/(?:financial-research-score|statistics)\.ts$|scripts\/research\/|scripts\/checks\/financial-evaluation-inputs\.ts$)/.test(f) && /\.(ts|js)$/.test(f) && !f.endsWith('.test.ts'));
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await hashFile(file)])));
}
async function main() {
  const db = new URL(process.env.DATABASE_URL!);
  assert.equal(process.env.DATABASE_URL, process.env.RESEARCH_TEST_DATABASE_URL);
  assert(['localhost','127.0.0.1'].includes(db.hostname) && db.pathname === '/research_test', 'Disposable database required');
  assert(['baseline','candidate','holdout'].includes(phase || ''), 'Explicit evaluation phase required');
  assert(campaign.startsWith(path.resolve('data/research-agent-upgrade/evidence/S19') + path.sep), 'Explicit S19 campaign directory required');
  await mkdir(campaign, {recursive: true});
  process.env.COMPANY_RESEARCH_REVIEW_CALIBRATION ||= path.resolve('data/research-agent-upgrade/evidence/S12/2026-10-19T05-12-55-698Z/calibration.json');
  const config = researchConfig(), calibrationHash = await reviewerCalibration(); assert(calibrationHash, 'Calibrated reviewer required');
  assert.equal((await json(process.env.COMPANY_RESEARCH_REVIEW_CALIBRATION)).reasoning, config.reasoning);
  const developmentManifest = await json('fixtures/company-research/documents.json') as {documents: Meta[]};
  const protocol = { version: 'financial-skill-paired-v1', model: config.model, reasoning: config.reasoning, calibrationHash,
    reviewerPromptHash: artifactDigest(reviewerPrompt), dataHash: await hashFile('fixtures/company-research/documents.json'),
    datasetHash: await hashFile('fixtures/company-research/development.json'), rubricHash: await hashFile('fixtures/company-research/rubric.json'),
    annotationHash: await hashFile('data/research-agent-upgrade/annotations/2026-10-19-ai-assisted-01/acceptance.json'),
    parsedHashes: Object.fromEntries(await Promise.all(developmentManifest.documents.map(async meta => [meta.id, await hashFile(path.join(parsedRoot, `${meta.id}.json`))]))),
    budget: {maxToolCalls: 40, timeoutMs: 1200000}, attemptsPerCompany: 1, repair: 'in-task repair within the same 40 calls; no fresh-task retries',
    codeHashes: await codeHashes(), cost: 'unknown', referencePolicy: 'human-confirmed development numbers; same-model separate-call calibrated semantic reviewer; no new human sign-off',
    plannedRuns: {baselineDevelopment: 4, candidateDevelopment: 4, finalHoldout: 2}, scope: 'real PI/model/PG over fixed public PDFs, fixed parser receipts and real retrieval; no live acquisition; paired only within this campaign' };
  const protocolFile = path.join(campaign, 'protocol.json');
  if (phase === 'baseline') await writeFile(protocolFile, JSON.stringify(protocol, null, 2), {flag: 'wx'});
  else assert.equal(canonicalResearchJson(await json(protocolFile)), canonicalResearchJson(protocol), 'Comparison protocol/code changed; create a new baseline campaign');
  const defaultSkill: FinancialResearchSkill = {version: researchSkillVersion, prompt: financialResearchPrompt};
  let skill = defaultSkill;
  if (phase === 'candidate') { assert((await json(path.join(campaign,'baseline','results.json'))).complete); skill = await json(path.join(campaign,'candidate.json')); }
  if (phase === 'holdout') {
    const freeze = await json(path.join(campaign, 'freeze.json'));
    assert.equal(freeze.protocolHash, await hashFile(protocolFile));
    assert.equal(freeze.candidateHash, await hashFile(path.join(campaign, 'candidate.json')));
    assert.equal(freeze.baselineResultsHash, await hashFile(path.join(campaign, 'baseline', 'results.json')));
    assert.equal(freeze.candidateResultsHash, await hashFile(path.join(campaign, 'candidate', 'results.json')));
    assert(['baseline','candidate'].includes(freeze.selected));
    skill = freeze.selected === 'candidate' ? await json(path.join(campaign, 'candidate.json')) : defaultSkill;
    await writeFile(path.join(campaign,'holdout-opened.json'), JSON.stringify({at: new Date().toISOString(), freezeHash: await hashFile(path.join(campaign,'freeze.json')), purpose: 'one final evaluation; no further tuning on these companies'}), {flag:'wx'});
  }
  assert(typeof skill.prompt === 'string' && skill.prompt.length <= 30000 && typeof skill.version === 'string' && skill.version.length <= 100);
  let manifest: {documents: Meta[]}, dataset: {cases: FinancialEvaluationInput[]};
  if (phase === 'holdout') {
    const hidden = controlledExternalRoot(process.cwd(), process.env.RESEARCH_HOLDOUT_ROOT || '');
    const registration = await json('fixtures/company-research/holdout-registration.json');
    assert.equal(await hashFile(path.join(hidden,'holdout','manifest.json')), registration.manifestSha256);
    assert.equal(await hashFile(path.join(hidden,'holdout','tasks.json')), registration.tasksSha256);
    manifest = await json(path.join(hidden,'holdout','manifest.json')); const tasks = await json(path.join(hidden,'holdout','tasks.json'));
    dataset = {cases: normalizeHoldoutTasks(tasks, manifest.documents)};
    // Hidden task/report details never reach stdout or tracked documentation.
    await mkdir(path.join(campaign, phase), {recursive:true});
  } else { manifest = await json('fixtures/company-research/documents.json'); dataset = await json('fixtures/company-research/development.json'); }
  assert.equal(dataset.cases.length, phase === 'holdout' ? 2 : 4);
  const output = path.join(campaign, phase!); await mkdir(output, {recursive: true});
  const actor = `financial-eval-${phase}-${randomUUID()}`, ctx = {db: prisma, artifacts: new ResearchArtifactStore(path.join(output, 'artifacts'))};
  const results = [];
  try {
    for (const [index, sample] of dataset.cases.entries()) {
      const label = phase === 'holdout' ? `holdout-${index + 1}` : sample.id;
      const directory = path.join(output, label); await mkdir(directory, {recursive: true});
      const spec = researchTaskSpecSchema.parse({schemaVersion: 1, kind:'financial_change', requestRevision:1,
        company:{...sample.company, exchange:sample.company.symbol.split('.')[1]}, periods:[2023,2024].map(year => ({id:`FY${year}`,start:`${year}-01-01`,end:`${year}-12-31`,kind:'annual',basis:'cumulative'})),
        asOf:sample.asOf,scope:'consolidated',currency:'CNY',comparison:{status:'comparable'}, questions: sample.questions.map((q,i) => ({id:['income_profit','cash_flow','risks'][i],text:q.text})),budget:protocol.budget});
      const started = Date.now(), task = (await createResearchTask(actor,spec,randomUUID(),ctx))!;
      for (const meta of manifest.documents.filter(d => sample.documentIds.includes(d.id))) {
        const original = await readFile(meta.path); assert.equal(artifactDigest(original),meta.bytesSha256);
        let receipt;
        if (phase !== 'holdout') receipt = parsedDocumentV2Schema.parse(await json(path.join(parsedRoot,`${meta.id}.json`)));
        else receipt = await new NativePdfParser().parse(original,'application/pdf',{maxPages:500,maxCharacters:2000000,signal:AbortSignal.timeout(240000)});
        const parsed = Buffer.from(JSON.stringify(receipt)), announcement = await readFile(meta.path.replace(/\.pdf$/,'.announcement.json'));
        const ref = (bytes: Buffer) => ({store:'local' as const,key:artifactDigest(bytes),sha256:artifactDigest(bytes),byteLength:bytes.length});
        const document = researchDocumentSchema.parse({schemaVersion:1,id:meta.id,taskId:task.id,version:1,company:spec.company,period:spec.periods.find(p => p.end===meta.period.end),title:meta.title,url:meta.url,mediaType:'application/pdf',bytesSha256:meta.bytesSha256,fetchedAt:meta.retrievedAt,
          original:ref(original),parsed:ref(parsed),state:receipt.status,pageCount:receipt.pageCount,parser:{...receipt.parser,failedPages:receipt.failedPages,warnings:receipt.warnings},disclosure:cninfoDisclosure(JSON.parse(announcement.toString()),announcement,'https://www.cninfo.com.cn/new/hisAnnouncement/query').disclosure});
        await registerResearchDocument(actor,document,original,parsed,ctx);
      }
      await queueFinancialResearch(actor,task.id,0,ctx); const token = await startResearchAttempt(actor,task.id,1,`evaluation-${phase}`,ctx);
      let runError: string | null = null;
      const attempts: {tool: string; verdict: string | null; ok: boolean; status: string | null}[] = [], pendingWrites: Promise<unknown>[] = [];
      console.log(`${label}: real model run started`);
      try { await executeFinancialResearch(actor,token,undefined,ctx,undefined,true,async record => {
        await appendFile(path.join(directory,'tools.jsonl'),JSON.stringify(record)+'\n');
        if (record.type === 'tool_result') {
          const data = record.data as {toolCall:{name:string};result:{ok:boolean;data?:{verdict?:string;status?:string}}};
          attempts.push({tool:data.toolCall.name,verdict:data.result.data?.verdict || null,status:data.result.data?.status || null,ok:data.result.ok});
        }
      }, record => { pendingWrites.push(appendFile(path.join(directory,'observations.jsonl'),JSON.stringify(record)+'\n')); }, skill); }
      catch (error) { runError = safeError(error); }
      await Promise.all(pendingWrites);
      const snapshot = (await getResearchTask(actor,task.id,ctx))!; await writeFile(path.join(directory,'task.json'),JSON.stringify(snapshot,null,2));
      const hardErrors = snapshot.report ? (await deterministicReportErrors(actor,spec,snapshot.report,ctx)).errors : ['NO_REPORT'];
      if (snapshot.report) hardErrors.push(...semanticPublicationErrors(snapshot.report,await readClaimReviews(actor,task.id,ctx)));
      const sources = [];
      if (snapshot.report) {
        for (const claim of snapshot.report.claims) for (let citationIndex=0;citationIndex<claim.citations.length;citationIndex++) sources.push(await readResearchSource(actor,task.id,{reportRevision:snapshot.reportRevision,claimId:claim.id,citationIndex},ctx));
        for (const fact of snapshot.report.facts) for (let citationIndex=0;citationIndex<fact.citations.length;citationIndex++) sources.push(await readResearchSource(actor,task.id,{reportRevision:snapshot.reportRevision,factId:fact.id,citationIndex},ctx));
      }
      await writeFile(path.join(directory,'sources.json'),JSON.stringify(sources,null,2));
      const score = sample.reference ? scoreFinancialCase({...sample,reference:sample.reference},snapshot.report,hardErrors) : null;
      const result = {label,taskId:task.id,status:snapshot.status,elapsedMs:Date.now()-started,usage:snapshot.usage,runError,score,hardErrors,
        firstCoverageStatus:attempts.find(a=>a.tool==='check_coverage')?.status || null,
        reviewCalls:attempts.filter(a=>a.tool==='verify_claim').length,failedToolCalls:attempts.filter(a=>!a.ok).length,
        reportHash:snapshot.report ? artifactDigest(canonicalResearchJson(snapshot.report)) : null,skillVersion:skill.version,skillSha256:artifactDigest(skill.prompt),humanReview:'not-newly-human-reviewed'};
      results.push(result); await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));
      console.log(`${label}: ${snapshot.status}, numbers ${score?.numericPassed ?? 'unscored'}/${score?.numericTotal ?? 'unscored'}, questions ${score?.completedQuestions ?? 'unscored'}/3, tools ${snapshot.usage.toolCalls}`);
    }
    const scores = results.flatMap(r=>r.score ? [r.score] : []);
    await writeFile(path.join(output,'results.json'),JSON.stringify({phase,complete:true,protocolHash:await hashFile(protocolFile),skillVersion:skill.version,skillSha256:artifactDigest(skill.prompt),
      results,summary:scores.length===results.length ? summarizeScores(scores) : null,actualModelRuns:results.length,referenceMissing:results.some(r=>!r.score),cost:'unknown',finishedAt:new Date().toISOString()},null,2));
    console.log(`${phase}: saved ${results.length} real runs; aggregate: ${output}/results.json`);
  } finally { await prisma.$executeRaw`DELETE FROM company_research_tasks WHERE actor_id=${actor}`; }
}
main().catch(error => { console.error(safeError(error)); process.exitCode=1; }).finally(()=>prisma.$disconnect());
