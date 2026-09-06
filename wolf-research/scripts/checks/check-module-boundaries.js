#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const failures = [];

function normalize(value) {
  return value.replaceAll('\\', '/');
}

function walk(directory, result = []) {
  const absolute = path.join(ROOT, directory);
  if (!fs.existsSync(absolute)) return result;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = normalize(path.join(directory, entry.name));
    if (entry.isDirectory()) {
      if (![
        '.git',
        '.next',
        'node_modules',
        'data',
        'tmp',
        'coverage',
        'dist',
        '.venv',
        '__pycache__',
        '.ruff_cache',
      ].includes(entry.name)) {
        walk(relative, result);
      }
    } else if (entry.isFile()) {
      result.push(relative);
    }
  }
  return result;
}

function sourceFiles() {
  return walk('src').filter((file) => /\.(?:ts|tsx|js|jsx)$/u.test(file));
}

function importedSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /import\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /require\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

function resolveInternal(sourceFile, specifier) {
  let unresolved;
  if (specifier.startsWith('@/')) {
    unresolved = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith('.')) {
    unresolved = normalize(path.posix.join(path.posix.dirname(sourceFile), specifier));
  } else {
    return null;
  }
  const candidates = [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    `${unresolved}.js`,
    `${unresolved}.jsx`,
    `${unresolved}.json`,
    `${unresolved}/index.ts`,
    `${unresolved}/index.tsx`,
    `${unresolved}/index.js`,
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(ROOT, candidate))) || null;
}

const forbiddenEdges = [
  ['src/lib/', 'src/app/', '服务层不能反向依赖 Next 页面层'],
  ['src/components/ui/', 'src/app/', '通用 UI 不能依赖页面层'],
  ['src/components/ui/', 'src/lib/quant/', '通用 UI 不能携带量化领域知识'],
  ['src/components/ui/', 'src/lib/services/', '通用 UI 不能直接依赖服务运行时'],
  ['src/lib/agent/', 'src/lib/quant/', 'PI Agent 内核不能反向依赖量化应用层'],
  ['src/lib/agent/', 'src/lib/domains/', 'PI Agent 内核不能反向依赖 Domain Pack'],
  ['src/lib/agent/', 'src/lib/data-agent/', 'PI Agent 内核不能反向依赖 Data Agent 应用层'],
  ['src/lib/data-agent/', 'src/lib/quant/', '通用 Data Agent 不能依赖量化应用实现'],
  ['src/lib/data-agent/', 'src/lib/domains/', '通用 Data Agent 不能依赖具体 Domain Pack'],
  ['src/lib/domains/finance/', 'src/lib/quant/', 'Finance Domain Pack 不能依赖产品编排层'],
];

function isPrefix(value, prefix) {
  return value === prefix.slice(0, -1) || value.startsWith(prefix);
}

for (const file of sourceFiles()) {
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const specifier of importedSpecifiers(content)) {
    const target = resolveInternal(file, specifier);
    if (!target) continue;
    for (const [from, to, reason] of forbiddenEdges) {
      if (isPrefix(file, from) && isPrefix(target, to)) {
        failures.push(`${file} imports ${specifier} -> ${target}; ${reason}`);
      }
    }
  }
}

const scanFiles = walk('.').filter((file) =>
  !file.startsWith('docs/') &&
  !file.startsWith('scripts/checks/') &&
  !file.startsWith('node_modules/') &&
  !file.startsWith('.next/') &&
  /\.(?:ts|tsx|js|jsx|json|py|toml|yaml|yml|prisma|md)$/u.test(file),
);
for (const file of scanFiles) {
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (
    content.includes('D:/QuantPilot') ||
    content.includes('D:\\QuantPilot') ||
    content.includes('file:///D:/QuantPilot')
  ) {
    failures.push(`${file} contains a forbidden source-project absolute path`);
  }
  if (content.includes('wolf-dashboard')) {
    failures.push(`${file} contains a runtime wolf-dashboard reference`);
  }
}

const packageText = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
if (
  packageText.includes('wolf-dashboard') ||
  packageText.includes('file:..') ||
  packageText.includes('workspace:*')
) {
  failures.push('package.json contains a cross-project or workspace dependency');
}
if (fs.existsSync(path.join(ROOT, '.git'))) failures.push('wolf-research must not contain a nested .git directory');

for (const required of [
  'src/app/page.tsx',
  'src/app/eval-platform/page.tsx',
  'src/app/eval-platform/runs/[runId]/page.tsx',
  'src/app/api/projects/route.ts',
  'src/app/api/chat/[project_id]/act/route.ts',
  'src/app/api/evals/route.ts',
]) {
  if (!fs.existsSync(path.join(ROOT, required))) failures.push(`required target entry is missing: ${required}`);
}

for (const file of walk('src/app/api')) {
  if (/(?:^|\/)(?:github|vercel)(?:\/|\.)/iu.test(file)) {
    failures.push(`removed publishing route exists: ${file}`);
  }
}
if (fs.existsSync(path.join(ROOT, 'src/lib/eval/shadow-replay.ts'))) {
  failures.push('Shadow Replay runtime must not be migrated');
}
if (walk('services/market-data').some((file) => file.toLowerCase().includes('clickhouse'))) {
  failures.push('ClickHouse runtime files must not be migrated');
}

if (failures.length > 0) {
  console.error('[module-boundaries] failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('[module-boundaries] ok: internal static/dynamic import and cross-project boundaries passed');
}
