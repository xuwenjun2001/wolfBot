const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { superviseService } = require('./service-supervisor');
const { createDevProcessLifecycle } = require('./run-web');

function fixture(start) {
  const processRef = new EventEmitter();
  const terminated = [];
  processRef.exit = code => processRef.emit('exit', code);
  const lifecycle = createDevProcessLifecycle({ processRef, terminateChild: c => terminated.push(c) });
  const timers = new Map();
  const events = [];
  const service = superviseService({ name: 'fixture', start, lifecycle, log: e => events.push(e),
    schedule: (fn, ms) => { const key = {}; timers.set(key, { fn, ms }); return key; },
    cancel: key => timers.delete(key) });
  return { processRef, lifecycle, service, timers, events, terminated };
}
function child(pid = 123) { return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }); }
const settle = () => new Promise(resolve => setImmediate(resolve));

test('worker exit retries only that worker and does not stop sibling services', async () => {
  const worker = child();
  const f = fixture(async ({ onChild }) => { onChild(worker); return { child: worker }; });
  const web = child(456);
  f.lifecycle.track(web);
  await f.service.ready;
  worker.exitCode = 1;
  worker.emit('exit', 1, null);
  assert.equal(f.service.snapshot().status, 'retrying');
  assert.equal(f.timers.size, 1);
  assert.equal(f.lifecycle.shuttingDown, false);
  assert.deepEqual(f.terminated, []);
  assert.equal(f.events.at(-1).code, 1);
});

test('spawn error followed by exit schedules one retry', async () => {
  const worker = child();
  const f = fixture(async ({ onChild }) => { onChild(worker); return {}; });
  await f.service.ready;
  worker.emit('error', new Error('ENOENT'));
  worker.emit('exit', -1, null);
  assert.equal(f.timers.size, 1);
  assert.equal(f.events.at(-1).error, 'ENOENT');
});

test('startup cleanup finishes before another launch; transient commands do not trigger restart', async () => {
  let rejectStart;
  const worker = child();
  const f = fixture(({ onChild }) => {
    const migration = child(999);
    onChild(migration, { transient: true });
    migration.emit('exit', 0, null);
    onChild(worker);
    return new Promise((_, reject) => { rejectStart = reject; });
  });
  assert.equal(f.timers.size, 0);
  worker.emit('exit', 1, null);
  assert.equal(f.timers.size, 0);
  rejectStart(new Error('readiness failed'));
  await f.service.ready;
  assert.equal(f.timers.size, 1);
});

test('repeated startup failures use capped backoff and can recover', async () => {
  let attempts = 0;
  const worker = child();
  const f = fixture(async ({ onChild }) => {
    if (++attempts < 9) throw new Error('database unavailable');
    onChild(worker);
    return {};
  });
  await f.service.ready;
  const delays = [];
  while (f.timers.size) {
    const [key, { fn, ms }] = [...f.timers][0];
    f.timers.delete(key);
    delays.push(ms);
    fn();
    await settle();
  }
  assert.equal(attempts, 9);
  assert.equal(f.service.snapshot().status, 'ready');
  assert.ok(delays.every(ms => ms <= 30000));
  assert.ok(delays.at(-1) > 29000);
});

test('intentional shutdown cancels retries and terminates owned children', async () => {
  const worker = child();
  const f = fixture(async ({ onChild }) => { onChild(worker); return {}; });
  await f.service.ready;
  worker.emit('error', new Error('test failure'));
  f.processRef.emit('SIGTERM');
  assert.equal(f.timers.size, 0);
  assert.ok(f.terminated.includes(worker));
});

test('externally managed service is not killed or restarted', async () => {
  const f = fixture(async () => ({ child: null, managed: false }));
  await f.service.ready;
  assert.equal(f.service.snapshot().status, 'external_or_disabled');
  f.processRef.emit('SIGINT');
  assert.deepEqual(f.terminated, []);
  assert.equal(f.timers.size, 0);
});

test('a real worker crash recovers while a sibling TCP service stays available', { timeout: 15000 }, async () => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const processRef = new EventEmitter();
  processRef.exit = code => processRef.emit('exit', code);
  const lifecycle = createDevProcessLifecycle({ processRef });
  const workers = [];
  let web;
  let port;
  try {
    const server = superviseService({ name: 'web-fixture', lifecycle, log: () => {},
      start: async ({ onChild }) => {
        web = spawn(process.execPath, ['-e', "const s=require('net').createServer(c=>c.end());s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"],
          { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
        onChild(web);
        port = await new Promise((resolve, reject) => {
          web.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
          web.once('error', reject);
        });
        return {};
      } });
    await server.ready;
    const originalWebPid = web.pid;
    const worker = superviseService({ name: 'worker-fixture', lifecycle, log: () => {}, retryMs: 25,
      start: async ({ onChild }) => {
        const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
          { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
        onChild(c);
        workers.push(c);
        return {};
      } });
    await worker.ready;
    workers[0].kill();
    for (let i = 0; i < 100 && workers.length < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(workers.length, 2);
    assert.notEqual(workers[0].pid, workers[1].pid);
    assert.equal(web.pid, originalWebPid);
    await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.setTimeout(1000, () => socket.destroy(new Error('fixture unavailable')));
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    });
    assert.equal(lifecycle.shuttingDown, false);
  } finally { lifecycle.shutdown(); }
});
