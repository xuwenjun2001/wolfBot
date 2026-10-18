#!/usr/bin/env node
// Own container, migrate old schema, create with old code, migrate forward,
// read with both code versions, then exercise new repositories. Never db push.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const root = process.cwd(), id = randomUUID(), name = `wolfbot-research-check-${id}`;
const evidence = path.join(root, 'data/research-agent-upgrade/evidence/S05', `rehearsal-${id}`);
const migration = '20261018140000_research_version_foundation';
const schemaDirectory = path.join(evidence, 'schema');
fs.mkdirSync(path.join(schemaDirectory, 'migrations'), { recursive: true });
const gitHead = spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
const allPaths = spawnSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).stdout.split('\n').filter(Boolean);
const relevant = allPaths.filter(p => /^(?:src\/lib\/company-research\/|src\/app\/api\/company-research\/tasks\/|scripts\/research\/|prisma\/migrations\/20261018140000_research_version_foundation\/)/.test(p) || ['prisma/schema.prisma','scripts/checks/run-research-postgres-integration.js'].includes(p));
const sourceHashes = Object.fromEntries(relevant.filter(p=>fs.statSync(p).isFile()).map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), head: gitHead, sourceHashes, oldCodeRef: 'd17ac893b9605971f5ec47be7d1577aa32d8bd0e', steps: [] };
let created = false;
function run(label, executable, args, env = {}, quiet = false) {
  const r = spawnSync(executable, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 15_000_000 });
  const output = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(evidence, `${label}.log`), output);
  report.steps.push({ label, exitCode: r.status, sha256: createHash('sha256').update(output).digest('hex') });
  if (!quiet) process.stdout.write(output);
  if (r.error || r.status !== 0) throw new Error(`${label} failed (${r.status ?? r.error?.code}); see evidence`);
  return (r.stdout || '').trim();
}
async function main() {
  try {
    run('container-create', 'docker', ['run','--detach','--rm','--name',name,'-e','POSTGRES_USER=research_test','-e','POSTGRES_PASSWORD=research-test-only','-e','POSTGRES_DB=research_test','-p','127.0.0.1::5432','postgres:16'], {}, true); created = true;
    const address = run('container-port', 'docker', ['port',name,'5432/tcp'], {}, true);
    const port = Number(address.split(':').at(-1)); if (!Number.isInteger(port)) throw new Error('Unknown disposable port');
    const databaseUrl = `postgresql://research_test:research-test-only@127.0.0.1:${port}/research_test`;
    let ready = false;
    for (let i=0; i<60; i++) {
      const p = spawnSync('docker',['exec',name,'pg_isready','-U','research_test','-d','research_test'],{encoding:'utf8'});
      if (p.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve,500));
    }
    if (!ready) throw new Error('Disposable PostgreSQL not ready');
    const prismaBin = path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js');
    const schema = path.join(schemaDirectory, 'schema.prisma');
    const sourceSchema = fs.readFileSync('prisma/schema.prisma','utf8').replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  output = "./generated-client"');
    fs.writeFileSync(schema, sourceSchema);
    const files = fs.readdirSync('prisma/migrations').sort();
    for (const file of files) if (file !== migration) fs.cpSync(path.join('prisma/migrations', file),path.join(schemaDirectory,'migrations',file),{recursive:true});
    const legacy = path.join(evidence,'legacy'); fs.mkdirSync(legacy);
    const paths = run('old-source-list','git',['ls-tree','-r','--name-only',report.oldCodeRef,'src/lib/company-research'],{},true).split('\n').filter(p=>p.endsWith('.ts')&&!p.endsWith('.test.ts'));
    for (const source of paths) {
      const data = spawnSync('git',['show',`${report.oldCodeRef}:${source}`],{cwd:root,encoding:'utf8'});
      if (data.status !== 0) throw new Error('Cannot restore old research source');
      fs.writeFileSync(path.join(legacy,path.basename(source)),data.stdout);
    }
    const env = { DATABASE_URL: databaseUrl, RESEARCH_TEST_DATABASE_URL: databaseUrl, COMPANY_RESEARCH_TEST_POSTGRES: '1', RESEARCH_LEGACY_STORE: path.join(legacy,'store.ts'), RESEARCH_COMPAT_FIXTURE: path.join(evidence,'legacy-fixture.json') };
    run('migrate-old',process.execPath,[prismaBin,'migrate','deploy','--schema',schema],env);
    run('legacy-before',process.execPath,['--import','tsx','scripts/research/legacy-compatibility.ts','before'],env);
    fs.cpSync(path.join('prisma/migrations',migration),path.join(schemaDirectory,'migrations',migration),{recursive:true});
    run('migrate-upgrade',process.execPath,[prismaBin,'migrate','deploy','--schema',schema],env);
    run('migrate-repeat',process.execPath,[prismaBin,'migrate','deploy','--schema',schema],env);
    // Generate separately: never replace the DLL loaded by an existing dev server.
    run('generate-isolated-client',process.execPath,[prismaBin,'generate','--schema',schema],env);
    run('new-client-smoke',process.execPath,['-e', 'const {PrismaClient}=require(process.env.RESEARCH_GENERATED_CLIENT);const db=new PrismaClient();db.companyResearchTask.count().then(n=>console.log("new task model count="+n)).finally(()=>db.$disconnect());'],{...env,RESEARCH_GENERATED_CLIENT:path.join(schemaDirectory,'generated-client')});
    run('legacy-after',process.execPath,['--import','tsx','scripts/research/legacy-compatibility.ts','after'],env);
    const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')),'vitest.mjs');
    run('database-tests',process.execPath,[vitestBin,'run','src/lib/company-research/store.integration.test.ts','src/lib/company-research/version-store.integration.test.ts'],env);
    run('migration-status',process.execPath,[prismaBin,'migrate','status','--schema',schema],env);
    report.outcome = 'passed';
  } catch(error) { report.outcome = 'failed'; report.error = error.message; process.exitCode = 1; console.error(error.message); }
  finally {
    if (created) {
      const removed = spawnSync('docker',['rm','--force',name],{encoding:'utf8'});
      report.containerRemoved = removed.status === 0;
      if (removed.status !== 0) { process.exitCode = 1; console.error(`Could not remove owned disposable container ${name}`); }
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence,'manifest.json'),JSON.stringify(report,null,2)+'\n');
    console.log(`Evidence: ${path.relative(root,evidence).replaceAll('\\','/')}/manifest.json`);
  }
}
void main();
