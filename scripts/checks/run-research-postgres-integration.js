#!/usr/bin/env node
// Own container, migrate old schema, create with old code, migrate forward,
// read with both code versions, then exercise new repositories. Never db push.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const net = require('node:net');
const { reserveEvaluationPhase } = require('./research-evaluation-phase');
const root = process.cwd(), id = randomUUID(), name = `wolfbot-research-check-${id}`;
const evidence = path.join(root, 'data/research-agent-upgrade/evidence/S05', `rehearsal-${id}`);
const migration = '20261018140000_research_version_foundation';
const schemaDirectory = path.join(evidence, 'schema');
const gitHead = spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
const allPaths = spawnSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).stdout.split('\n').filter(Boolean);
const relevant = allPaths.filter(p => /^(?:src\/lib\/company-research\/|src\/app\/api\/company-research\/tasks\/|src\/app\/company-research\/financial\/|scripts\/research\/|prisma\/migrations\/202610(?:18140000_research_version_foundation|19020000_research_evidence_indexes|19130000_research_execution|20150000_research_update_budgets)\/)/.test(p) || ['prisma/schema.prisma','scripts/checks/run-research-postgres-integration.js'].includes(p));
const sourceHashes = Object.fromEntries(relevant.filter(p=>fs.statSync(p).isFile()).map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const nativeArgument = process.argv.slice(2).find(a => a.startsWith('--native-postgres='));
const financialE2e = process.argv.includes('--financial-e2e');
const reliability = process.argv.includes('--reliability');
const delivery = process.argv.includes('--delivery');
const evaluationArgument = process.argv.slice(2).find(a => a.startsWith('--evaluation='));
if (evaluationArgument && !['baseline','candidate','holdout'].includes(evaluationArgument.slice('--evaluation='.length))) throw new Error('Unknown evaluation phase');
if (process.argv.slice(2).some(a => a !== nativeArgument && a !== evaluationArgument && !['--financial-e2e', '--reliability', '--delivery'].includes(a))) throw new Error('Unknown runner argument');
if (evaluationArgument) reserveEvaluationPhase(root, process.env.RESEARCH_EVALUATION_CAMPAIGN, evaluationArgument.slice('--evaluation='.length));
fs.mkdirSync(path.join(schemaDirectory, 'migrations'), { recursive: true });
const nativeBin = nativeArgument ? path.resolve(nativeArgument.slice('--native-postgres='.length)) : null;
const nativeData = path.join(evidence, 'postgres-data');
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), head: gitHead, sourceHashes, oldCodeRef: 'd17ac893b9605971f5ec47be7d1577aa32d8bd0e', postgresRuntime: nativeBin ? 'isolated-native' : 'docker', steps: [] };
let created = false, nativeCreated = false;
function run(label, executable, args, env = {}, quiet = false) {
  // Native pg_ctl's background child inherits handles on Windows. Files avoid waiting for pipe EOF.
  const logPath = path.join(evidence, `${label}.log`), fd = fs.openSync(logPath, 'w');
  let r;
  try { r = spawnSync(executable, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  const output = fs.readFileSync(logPath, 'utf8');
  report.steps.push({ label, exitCode: r.status, sha256: createHash('sha256').update(output).digest('hex') });
  if (!quiet) process.stdout.write(output);
  if (r.error || r.status !== 0) throw new Error(`${label} failed (${r.status ?? r.error?.code}); see evidence`);
  return output.trim();
}
async function main() {
  try {
    const prismaBin = path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js');
    let port;
    if (nativeBin) {
      // A new cluster under this run's unique evidence directory. Never reuse an application cluster.
      const suffix = process.platform === 'win32' ? '.exe' : '';
      for (const binary of ['initdb', 'pg_ctl', 'postgres']) if (!fs.statSync(path.join(nativeBin, binary + suffix)).isFile()) throw new Error('Native PostgreSQL binaries missing');
      if (fs.existsSync(nativeData)) throw new Error('Native data directory must not exist');
      port = await new Promise((resolve, reject) => {
        const socket = net.createServer(); socket.on('error', reject);
        socket.listen(0, '127.0.0.1', () => { const p = socket.address().port; socket.close(() => resolve(p)); });
      });
      const passwordFile = path.join(evidence, 'test-password'); fs.writeFileSync(passwordFile, 'research-test-only\n');
      run('native-init', path.join(nativeBin, 'initdb' + suffix), ['-D', nativeData, '-U', 'research_test', '--auth-host=scram-sha-256', '--auth-local=trust', '--encoding=UTF8', '--locale=C', '--pwfile=' + passwordFile], {}, true);
      fs.unlinkSync(passwordFile);
      // Mark before start so a partially successful start is still stopped in finally.
      nativeCreated = true;
      run('native-start', path.join(nativeBin, 'pg_ctl' + suffix), ['-D', nativeData, '-l', path.join(evidence, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -F`, '-w', '-t', '30', 'start'], {}, true);
      const createSql = path.join(evidence, 'create-test-database.sql'); fs.writeFileSync(createSql, 'CREATE DATABASE research_test;\n');
      run('native-createdb', process.execPath, [prismaBin, 'db', 'execute', '--url', `postgresql://research_test:research-test-only@127.0.0.1:${port}/postgres`, '--file', createSql], {}, true);
      report.nativePort = port;
    } else {
      run('container-create', 'docker', ['run','--detach','--rm','--name',name,'-e','POSTGRES_USER=research_test','-e','POSTGRES_PASSWORD=research-test-only','-e','POSTGRES_DB=research_test','-p','127.0.0.1::5432','postgres:16'], {}, true); created = true;
      const address = run('container-port', 'docker', ['port',name,'5432/tcp'], {}, true);
      port = Number(address.split(':').at(-1)); if (!Number.isInteger(port)) throw new Error('Unknown disposable port');
    }
    const databaseUrl = `postgresql://research_test:research-test-only@127.0.0.1:${port}/research_test`;
    let ready = false;
    for (let i=0; !nativeBin && i<60; i++) {
      const p = spawnSync('docker',['exec',name,'pg_isready','-U','research_test','-d','research_test'],{encoding:'utf8'});
      if (p.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve,500));
    }
    if (!nativeBin && !ready) throw new Error('Disposable PostgreSQL not ready');
    const schema = path.join(schemaDirectory, 'schema.prisma');
    const sourceSchema = fs.readFileSync('prisma/schema.prisma','utf8').replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  output = "./generated-client"');
    fs.writeFileSync(schema, sourceSchema);
    const files = fs.readdirSync('prisma/migrations').sort();
    for (const file of files) if (file < migration || file === 'migration_lock.toml') fs.cpSync(path.join('prisma/migrations', file),path.join(schemaDirectory,'migrations',file),{recursive:true});
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
    for (const file of files) if (file >= migration && file !== 'migration_lock.toml') fs.cpSync(path.join('prisma/migrations',file),path.join(schemaDirectory,'migrations',file),{recursive:true});
    run('migrate-upgrade',process.execPath,[prismaBin,'migrate','deploy','--schema',schema],env);
    run('migrate-repeat',process.execPath,[prismaBin,'migrate','deploy','--schema',schema],env);
    // Generate separately: never replace the DLL loaded by an existing dev server.
    run('generate-isolated-client',process.execPath,[prismaBin,'generate','--schema',schema],env);
    run('new-client-smoke',process.execPath,['-e', 'const {PrismaClient}=require(process.env.RESEARCH_GENERATED_CLIENT);const db=new PrismaClient();db.companyResearchTask.count().then(n=>console.log("new task model count="+n)).finally(()=>db.$disconnect());'],{...env,RESEARCH_GENERATED_CLIENT:path.join(schemaDirectory,'generated-client')});
    run('legacy-after',process.execPath,['--import','tsx','scripts/research/legacy-compatibility.ts','after'],env);
    const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')),'vitest.mjs');
    run('database-tests',process.execPath,[vitestBin,'run','--no-file-parallelism','src/lib/company-research/store.integration.test.ts','src/lib/company-research/version-store.integration.test.ts','src/lib/company-research/evidence-retrieval.integration.test.ts','src/lib/company-research/review-regressions.integration.test.ts','src/lib/company-research/financial-runtime.integration.test.ts','src/lib/company-research/execution-review.integration.test.ts','src/lib/company-research/reliability.integration.test.ts'],env);
    if (financialE2e) run('financial-model-e2e',process.execPath,['--import','tsx','scripts/research/run-financial-e2e.ts'],env);
    if (delivery) run('delivery-journey',process.execPath,['--import','tsx','scripts/checks/run-research-delivery.ts'],{...env,RESEARCH_DELIVERY_EVIDENCE:path.join(root,'data/research-agent-upgrade/evidence/S20',`journey-${id}`)});
    if (reliability) run('real-worker-interruption',process.execPath,['--import','tsx','scripts/research/interrupt-financial-worker.ts'], { ...env, RESEARCH_RELIABILITY_ROOT: path.join(root, 'data/research-agent-upgrade/evidence/S18', id) });
    if (evaluationArgument) run('financial-evaluation',process.execPath,['--import','tsx','scripts/research/run-financial-evaluation.ts','--phase='+evaluationArgument.slice('--evaluation='.length)],env);
    run('migration-status',process.execPath,[prismaBin,'migrate','status','--schema',schema],env);
    report.outcome = 'passed';
  } catch(error) { report.outcome = 'failed'; report.error = error.message; process.exitCode = 1; console.error(error.message); }
  finally {
    if (nativeCreated) {
      const stopped = spawnSync(path.join(nativeBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'), ['-D', nativeData, '-w', '-t', '30', '-m', 'fast', 'stop'], { encoding: 'utf8' });
      report.nativeClusterStopped = stopped.status === 0;
      fs.writeFileSync(path.join(evidence, 'native-stop.log'), (stopped.stdout || '') + (stopped.stderr || ''));
      if (stopped.status !== 0) { process.exitCode = 1; console.error('Could not stop the owned test cluster; see native-stop.log'); }
    }
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
