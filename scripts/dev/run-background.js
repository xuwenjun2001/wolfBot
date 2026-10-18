#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { request, runtimeDir, tokenFile, endpoint } = require('./background-control');

async function main() {
  const command = process.argv[2] || 'start';
  if (!['start', 'status', 'stop'].includes(command)) throw new Error('Use start, status or stop');
  const current = await request('status').catch(() => null);
  if (command === 'status') {
    console.log(current ? JSON.stringify(current, null, 2) : 'Background stack is not running.');
    return;
  }
  if (command === 'stop') {
    if (!current) { console.log('Background stack is not running.'); return; }
    console.log(await request('stop', fs.readFileSync(tokenFile, 'utf8')));
    return;
  }
  if (current) { console.log(`Background stack already running (PID ${current.pid}).`); return; }
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(runtimeDir, `${stamp}.log`);
  const output = fs.openSync(outputPath, 'a');
  const token = crypto.randomBytes(24).toString('hex');
  const child = spawn(process.execPath, [path.join(__dirname, 'run-full.js'), ...process.argv.slice(3)], {
    cwd: path.resolve(__dirname, '../..'), detached: true, windowsHide: true,
    stdio: ['ignore', output, output],
    env: { ...process.env, QUANTPILOT_DEV_BACKGROUND_TOKEN: token },
  });
  fs.closeSync(output);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  for (let i = 0; i < 40; i++) {
    const status = await request('status').catch(() => null);
    if (status) {
      console.log(`Background supervisor running (PID ${status.pid}); services are starting.`);
      console.log(`Log: ${outputPath}\nCheck readiness: npm run dev:status`);
      return;
    }
    if (child.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Background controller did not become ready. Inspect ${outputPath}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
