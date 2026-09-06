#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-eval-datasets.js'), {
  interopDefault: true,
});
const { attestEvalDatasetRegistry } = jiti('../../src/lib/eval/dataset-contract.ts');
const { attestEvalDataSnapshot, evalSnapshotPayloadSha256 } = jiti('../../src/lib/eval/snapshot-contract.ts');

const ROOT = process.cwd();
const BENCHMARK_ROOT = path.resolve(ROOT, 'benchmarks/quantpilot');
const REGISTRY_PATH = path.join(BENCHMARK_ROOT, 'datasets.json');
const QUERY_FIXTURES_PATH = path.join(BENCHMARK_ROOT, 'query-rewrite-fixtures.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeBenchmarkPath(relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error(`${label} 必须是非空相对路径`);
  }
  const resolved = path.resolve(BENCHMARK_ROOT, relativePath);
  if (resolved !== BENCHMARK_ROOT && !resolved.startsWith(`${BENCHMARK_ROOT}${path.sep}`)) {
    throw new Error(`${label} 必须位于 benchmarks/quantpilot 内`);
  }
  return resolved;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readExternalCases(definition, problems) {
  const configuredPath = definition.pathEnv ? process.env[definition.pathEnv] : '';
  if (!configuredPath) {
    if (definition.required) problems.push(`${definition.id} 缺少 ${definition.pathEnv} 配置`);
    return [];
  }

  const resolved = path.resolve(ROOT, configuredPath);
  if (!fs.existsSync(resolved)) {
    problems.push(`${definition.id} 外部数据集不存在：${configuredPath}`);
    return [];
  }

  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT })
    .toString('utf8')
    .trim();
  const relativeToRepo = path.relative(repoRoot, resolved);
  if (relativeToRepo && !relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo)) {
    const tracked = spawnSync(
      'git',
      ['ls-files', '--error-unmatch', '--', relativeToRepo],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    if (tracked.status === 0) {
      problems.push(`${definition.id} 外部数据集被 Git 跟踪，存在测试集泄漏风险`);
    }
  }

  const value = readJson(resolved);
  if (!Array.isArray(value)) {
    problems.push(`${definition.id} 必须是 case 数组`);
    return [];
  }
  return value;
}

function validateQueryRewriteFixtures(publicCases, fixtureDocument, problems) {
  if (
    fixtureDocument?.schemaVersion !== 1 ||
    fixtureDocument?.provider !== 'contract-fixture' ||
    typeof fixtureDocument?.model !== 'string' ||
    fixtureDocument.model.length === 0
  ) {
    problems.push('query rewrite fixture 必须声明 schemaVersion=1、contract-fixture provider 和 model');
  }

  const fixtures = fixtureDocument?.cases && typeof fixtureDocument.cases === 'object'
    ? fixtureDocument.cases
    : {};
  const fixtureFreeTypes = new Set(['runtime_registry', 'repair_plan', 'renderer_capability_contract']);
  const focusIds = new Set([
    'comprehensive',
    'technical',
    'fundamental',
    'events',
    'comparison',
    'strategy',
    'backtest',
    'portfolio_risk',
  ]);

  for (const testCase of publicCases) {
    if (fixtureFreeTypes.has(testCase.type)) continue;
    const phases = fixtures[testCase.id];
    const requiredPhases = testCase.type === 'clarification_continuation'
      ? ['primary', 'followup']
      : ['primary'];
    for (const phase of requiredPhases) {
      const fixture = phases?.[phase];
      if (!fixture) {
        problems.push(`${testCase.id}: 缺少 query rewrite ${phase} fixture`);
        continue;
      }
      if (
        !Array.isArray(fixture.targetCandidates) ||
        !focusIds.has(fixture.analysisFocusId) ||
        !['dashboard', 'answer'].includes(fixture.outputIntent) ||
        typeof fixture.broadUniverse !== 'boolean' ||
        typeof fixture.confidence !== 'number'
      ) {
        problems.push(`${testCase.id}/${phase}: query rewrite fixture 结构无效`);
      }
    }
  }

  const publicCaseIds = new Set(publicCases.map((testCase) => testCase.id));
  for (const fixtureCaseId of Object.keys(fixtures)) {
    if (!publicCaseIds.has(fixtureCaseId)) {
      problems.push(`query rewrite fixture 引用了未知 case：${fixtureCaseId}`);
    }
  }
}

function validateSnapshots(registry, publicCases, problems) {
  const snapshotManifestPath = safeBenchmarkPath(registry.snapshotManifest, 'snapshotManifest');
  const snapshotManifest = readJson(snapshotManifestPath);
  const snapshots = Array.isArray(snapshotManifest.snapshots) ? snapshotManifest.snapshots : [];
  if (snapshotManifest.schemaVersion !== 1 || !snapshotManifest.id || !snapshotManifest.version) {
    problems.push('snapshot manifest 缺少 schemaVersion/id/version');
  }

  const snapshotCaseIds = new Set();
  for (const snapshot of snapshots) {
    if (snapshotCaseIds.has(snapshot.caseId)) problems.push(`snapshot caseId 重复：${snapshot.caseId}`);
    snapshotCaseIds.add(snapshot.caseId);
    const testCase = publicCases.find((item) => item.id === snapshot.caseId);
    if (!testCase) {
      problems.push(`snapshot 引用了未知 case：${snapshot.caseId}`);
      continue;
    }

    let payload;
    try {
      payload = readJson(safeBenchmarkPath(snapshot.fixturePath, `${snapshot.caseId} fixture`));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const attestation = attestEvalDataSnapshot(snapshot, payload, {
      expectedCaseId: snapshot.caseId,
    });
    problems.push(...attestation.problems.map((item) => `${snapshot.caseId}: ${item}`));
    if (payload.asOf !== snapshot.asOf) problems.push(`${snapshot.caseId}: fixture asOf 与 manifest 不一致`);

    const expectedSymbols = [
      ...new Set([...(testCase.expectedSymbols || []), testCase.expectedSymbol].filter(Boolean)),
    ].sort();
    const fixtureSymbols = Array.isArray(payload.expectedSymbols)
      ? [...payload.expectedSymbols].sort()
      : [];
    if (!sameStrings(expectedSymbols, fixtureSymbols)) {
      problems.push(`${snapshot.caseId}: fixture expectedSymbols 与 case 不一致`);
    }

    const expectedOracleIds = (testCase.oracleAssertions || []).map((item) => item.id).sort();
    const fixtureOracleIds = Array.isArray(payload.oracleIds) ? [...payload.oracleIds].sort() : [];
    if (!sameStrings(expectedOracleIds, fixtureOracleIds)) {
      problems.push(`${snapshot.caseId}: fixture oracleIds 与 case 不一致`);
    }
  }

  const productionCaseIds = publicCases
    .filter((testCase) => testCase.productionSupported === true)
    .map((testCase) => testCase.id);
  for (const caseId of productionCaseIds) {
    if (!snapshotCaseIds.has(caseId)) problems.push(`${caseId}: production case 缺少可重放 snapshot`);
  }
  return { snapshotManifest, snapshots, productionCaseIds };
}

function main() {
  const problems = [];
  const registry = readJson(REGISTRY_PATH);
  const publicDefinition = Array.isArray(registry.datasets)
    ? registry.datasets.find((item) => item.visibility === 'public')
    : null;
  if (!publicDefinition?.path) throw new Error('dataset registry 缺少 public dataset');

  const publicCases = readJson(safeBenchmarkPath(publicDefinition.path, publicDefinition.id));
  if (!Array.isArray(publicCases)) throw new Error('public dataset 必须是 case 数组');
  validateQueryRewriteFixtures(publicCases, readJson(QUERY_FIXTURES_PATH), problems);

  const externalDatasets = {};
  for (const definition of (registry.datasets || []).filter((item) => item.visibility !== 'public')) {
    externalDatasets[definition.visibility] = readExternalCases(definition, problems);
  }
  const datasetAttestation = attestEvalDatasetRegistry({ registry, publicCases, externalDatasets });
  problems.push(...datasetAttestation.problems);
  const { snapshotManifest, snapshots, productionCaseIds } = validateSnapshots(
    registry,
    publicCases,
    problems,
  );

  console.log(
    `[eval-datasets] public=${datasetAttestation.summary.publicCaseCount} ` +
    `hidden=${datasetAttestation.summary.hiddenCaseCount} ` +
    `replay=${datasetAttestation.summary.productionReplayCaseCount} ` +
    `snapshots=${snapshots.length}/${productionCaseIds.length}`,
  );
  console.log(`[eval-datasets] snapshotManifestSha256=${evalSnapshotPayloadSha256(snapshotManifest)}`);
  if (problems.length > 0) {
    console.error('[eval-datasets] failed:');
    problems.forEach((problem) => console.error(`- ${problem}`));
    process.exitCode = 1;
    return;
  }
  console.log('[eval-datasets] ok: public/hidden 污染防护与 production snapshot 合同通过');
}

main();
