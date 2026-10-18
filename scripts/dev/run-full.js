#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');
const { parseCliArgs, startWebDevServer, stopChild, createDevProcessLifecycle } = require('./run-web');
const { createServiceLogger, superviseService } = require('./service-supervisor');

const rootDir = path.join(__dirname, '..', '..');
const marketDataDir = path.join(rootDir, 'services', 'market-data');
const isWindows = os.platform() === 'win32';

dotenv.config({
  path: [path.join(rootDir, '.env.local'), path.join(rootDir, '.env')],
});

function envFlag(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(value)) return true;
  return fallback;
}

function shouldRunMarketApi() {
  return (
    process.env.QUANTPILOT_DEGRADATION_MODE?.trim().toLowerCase() !== 'offline' &&
    envFlag('QUANTPILOT_MARKET_API_ENABLED', true)
  );
}

function shouldRunGenerationWorker() {
  return (
    process.env.PI_AGENT_DISPATCH_MODE?.trim().toLowerCase() === 'worker' &&
    envFlag('QUANTPILOT_DEV_MANAGE_GENERATION_WORKER', true)
  );
}

function marketApiUrl() {
  return (
    process.env.QUANTPILOT_MARKET_API_URL ||
    process.env.QUANTPILOT_MARKET_API_BASE_URL ||
    `http://127.0.0.1:${process.env.QUANTPILOT_MARKET_PORT || '8000'}`
  ).replace(/\/$/, '');
}

async function probeHealth(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/health`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startMarketApiIfNeeded({ onChild } = {}) {
  if (!shouldRunMarketApi()) {
    console.log('↪️  Market API disabled by degradation configuration.');
    return { child: null, managed: false };
  }

  const url = marketApiUrl();
  if (await probeHealth(url)) {
    process.env.QUANTPILOT_MARKET_API_ENABLED = '1';
    console.log(`✅ Market API already healthy at ${url}`);
    return { child: null, managed: false };
  }

  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname || '127.0.0.1';
  const port = parsedUrl.port || '8000';
  const noProxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost']
    .filter(Boolean)
    .join(',');

  console.log(`🚀 Starting market-data service on ${url}`);
  const child = spawn(
    'uv',
    ['run', '--extra', 'baostock', '--extra', 'akshare', 'quantpilot-market-api'],
    {
      cwd: marketDataDir,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      detached: !isWindows,
      env: {
        ...process.env,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
        QUANTPILOT_MARKET_HOST: host,
        QUANTPILOT_MARKET_PORT: port,
      },
    }
  );

  onChild?.(child);
  child.once('error', (error) => {
    console.error(`❌ Failed to start market-data: ${error.message}`);
  });

  for (let attempt = 1; attempt <= 40; attempt += 1) {
    if (await probeHealth(url)) {
      process.env.QUANTPILOT_MARKET_API_ENABLED = '1';
      console.log(`✅ Market API ready at ${url}`);
      return { child, managed: true };
    }
    if (child.exitCode != null || child.signalCode != null || !child.pid) {
      stopChild(child);
      throw new Error(`market-data exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    await delay(500);
  }

  stopChild(child);
  throw new Error(`market-data did not become healthy within 20 seconds: ${url}/health`);
}

function startGenerationWorkerIfNeeded({ onChild } = {}) {
  if (!shouldRunGenerationWorker()) {
    console.log('↪️  Generation dispatch uses inline mode or an externally managed Worker.');
    return { child: null, managed: false };
  }
  console.log('🚀 Starting durable Data Agent generation Worker');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/workers/generation-worker.ts'],
    {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      detached: !isWindows,
      env: process.env,
    }
  );
  onChild?.(child);
  child.once('error', (error) => {
    console.error(`❌ Failed to start generation Worker: ${error.message}`);
  });
  return { child, managed: true };
}

function startTacticsWorkerIfNeeded({ onChild } = {}) {
  if (!shouldRunMarketApi() || !envFlag('QUANTPILOT_DEV_MANAGE_TACTICS_WORKER', true)) {
    return { child: null, managed: false };
  }
  const child = spawn('uv', ['run', '--extra', 'baostock', '--project', 'services/market-data', 'python', '-m', 'quantpilot_market_data.tactics_worker'], {
    cwd: rootDir, stdio: 'inherit', shell: false, windowsHide: true, detached: !isWindows, env: process.env,
  });
  onChild?.(child);
  child.once('error', error => console.error(`❌ Failed to start tactics Worker: ${error.message}`));
  return { child, managed: true };
}

function startCompanyResearchWorkerIfNeeded({ onChild } = {}) {
  if (!envFlag('QUANTPILOT_DEV_MANAGE_RESEARCH_WORKER', true) || !process.env.COMPANY_RESEARCH_API_KEY || !(process.env.COMPANY_RESEARCH_SEARCH_API_KEY || process.env.DEEPSEEK_API_KEY)) {
    return { child: null, managed: false };
  }
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/workers/company-research-worker.ts'], {
    cwd: rootDir, stdio: 'inherit', shell: false, windowsHide: true, detached: !isWindows, env: process.env,
  });
  onChild?.(child);
  return { child, managed: true };
}

async function main() {
  const log = createServiceLogger(path.join(rootDir, 'data', 'logs', 'dev-stack'));
  const lifecycle = createDevProcessLifecycle({ onEvent: log });
  const { preferredPort, passthrough } = parseCliArgs(process.argv.slice(2));
  const services = {};
  const manage = (name, start) => {
    services[name] = superviseService({ name, start, lifecycle, log });
    return services[name];
  };
  log({ event: 'start', pid: process.pid });
  // A background controller owns only this launcher, never unrelated listeners.
  if (process.env.QUANTPILOT_DEV_BACKGROUND_TOKEN) {
    require('./background-control').attachBackgroundControl({ lifecycle, services, log });
  }
  await manage('market-data', startMarketApiIfNeeded).ready;
  await manage('web', ({ onChild }) => startWebDevServer({
    preferredPort, passthrough, stdio: 'inherit', onChild,
  })).ready;
  manage('generation-worker', startGenerationWorkerIfNeeded);
  manage('tactics-worker', startTacticsWorkerIfNeeded);
  manage('company-research-worker', startCompanyResearchWorkerIfNeeded);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\n❌ Failed to launch wolfbot development stack');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  envFlag,
  marketApiUrl,
  probeHealth,
  shouldRunMarketApi,
  shouldRunGenerationWorker,
  startGenerationWorkerIfNeeded,
  startTacticsWorkerIfNeeded,
  startMarketApiIfNeeded,
};
