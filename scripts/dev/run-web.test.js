const assert = require('node:assert/strict');
const test = require('node:test');

const { buildNextChildEnv, stopChild, resolveDevListener, createDevProcessLifecycle } = require('./run-web');

test('health probes follow the actual hostname and HTTPS listener', () => {
  for (const args of [['--hostname', '192.0.2.10'], ['-H', '192.0.2.10'], ['--hostname=192.0.2.10'], ['-H=192.0.2.10']]) {
    assert.equal(resolveDevListener({ port: 3001, args }).probeUrl, 'http://192.0.2.10:3001');
  }
  assert.equal(resolveDevListener({ port: 3001, defaultHost: '0.0.0.0' }).probeUrl, 'http://127.0.0.1:3001');
  assert.equal(resolveDevListener({ port: 3001, args: ['-H', '::'] }).probeUrl, 'http://[::1]:3001');
  assert.equal(resolveDevListener({ port: 3001, args: ['-H', '[::1]'] }).probeUrl, 'http://[::1]:3001');
  assert.deepEqual(resolveDevListener({ port: 3001, args: ['--experimental-https'] }), {
    probeUrl: 'https://127.0.0.1:3001', url: 'https://localhost:3001', allowSelfSigned: true,
  });
});

test('startup signals clean all owned services even before readiness resolves', () => {
  const { EventEmitter } = require('node:events');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const processRef = new EventEmitter();
    const stopped = [];
    const exits = [];
    processRef.exit = (code) => { exits.push(code); processRef.emit('exit', code); };
    const lifecycle = createDevProcessLifecycle({ processRef, terminateChild: (child) => stopped.push(child) });
    const market = new EventEmitter();
    const webStillStarting = new EventEmitter();
    const finishedMigration = new EventEmitter();
    lifecycle.track(finishedMigration);
    finishedMigration.emit('exit', 0);
    lifecycle.track(market);
    lifecycle.track(webStillStarting);
    processRef.emit(signal);
    lifecycle.shutdown(1);
    assert.deepEqual(stopped, [market, webStillStarting]);
    assert.deepEqual(exits, [0]);
  }
});

test('launcher failure cleans children through the process exit hook', () => {
  const { EventEmitter } = require('node:events');
  const processRef = new EventEmitter();
  const stopped = [];
  const lifecycle = createDevProcessLifecycle({ processRef, terminateChild: (child) => stopped.push(child) });
  const market = new EventEmitter();
  lifecycle.track(market);
  processRef.emit('exit', 1);
  assert.deepEqual(stopped, [market]);
});

test('sets Windows Watchpack polling default without overwriting explicit values', () => {
  const baseEnv = {
    PATH: 'test-path',
    BROWSER: '',
  };
  const defaultEnv = buildNextChildEnv({
    port: 3000,
    url: 'http://localhost:3000',
    baseEnv,
    windows: true,
  });
  const explicitEnv = buildNextChildEnv({
    port: 3000,
    url: 'http://localhost:3000',
    baseEnv: { ...baseEnv, WATCHPACK_POLLING: '250' },
    windows: true,
  });
  const nonWindowsEnv = buildNextChildEnv({
    port: 3000,
    url: 'http://localhost:3000',
    baseEnv,
    windows: false,
  });

  assert.equal(defaultEnv.WATCHPACK_POLLING, '1000');
  assert.equal(explicitEnv.WATCHPACK_POLLING, '250');
  assert.equal(nonWindowsEnv.WATCHPACK_POLLING, undefined);
});

test('terminates an owned Windows child when startup readiness fails', () => {
  const calls = [];
  const child = {
    pid: 12345,
    kill() { assert.fail('tree termination succeeded'); },
  };

  stopChild(child, true, (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });

  assert.deepEqual(calls, [{ command: 'taskkill', args: ['/PID', '12345', '/T', '/F'], options: { windowsHide: true, stdio: 'ignore' } }]);
});

test('Windows launcher signal cleanup terminates a real descendant listening socket', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const leaf = `const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const parent = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:['ignore','inherit','inherit']});`], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture did not listen')), 10000);
      parent.once('error', (error) => { clearTimeout(timer); reject(error); });
      parent.stdout.once('data', (chunk) => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
    });
    const { EventEmitter } = require('node:events');
    const processRef = new EventEmitter();
    processRef.exit = (code) => processRef.emit('exit', code);
    const lifecycle = createDevProcessLifecycle({ processRef });
    lifecycle.track(parent);
    processRef.emit('SIGINT');
    const reachable = () => new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    let listening = true;
    for (let i = 0; i < 20 && listening; i++) {
      listening = await reachable();
      if (listening) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(listening, false, 'descendant must not retain its TCP listener');
  } finally { stopChild(parent); }
});
