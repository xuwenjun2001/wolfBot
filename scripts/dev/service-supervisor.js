const fs = require('node:fs');
const path = require('node:path');

function createServiceLogger(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return (event) => {
    const entry = { at: new Date().toISOString(), ...event };
    console.log(`[supervisor] ${JSON.stringify(entry)}`);
    try {
      const file = path.join(directory, 'lifecycle.jsonl');
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      console.error(`Cannot persist service event: ${error.message}`);
    }
  };
}

// A failed worker must not tear down the web/API. Retry each owned service
// separately, with bounded exponential backoff, including failed initial starts.
function superviseService({ name, start, lifecycle, log, retryMs = 1000,
  maxRetryMs = 30000, stableMs = 60000, schedule = setTimeout, cancel = clearTimeout,
  now = Date.now }) {
  let timer;
  let stopped = false;
  let failures = 0;
  let state = { status: 'starting', pid: null };
  const snapshot = () => ({ ...state });
  const stop = () => { stopped = true; if (timer) cancel(timer); };
  lifecycle.onShutdown(stop);

  async function launch() {
    if (stopped || lifecycle.shuttingDown) return;
    let child;
    let failed = false;
    let readyAt = null;
    state = { status: 'starting', pid: null };
    const fail = (reason) => {
      if (failed || stopped || lifecycle.shuttingDown) return;
      failed = true;
      if (readyAt !== null && now() - readyAt >= stableMs) failures = 0;
      failures += 1;
      const wait = Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures - 1, 10));
      state = { status: 'retrying', pid: null, reason, retryAt: now() + wait };
      log({ service: name, event: 'retry', ...reason, delayMs: wait });
      if (reason.error && child) lifecycle.terminate(child);
      // The start promise may still be unwinding readiness cleanup. Schedule
      // only after it settles, so retries cannot overlap an earlier start.
    };
    const track = (value, { transient = false } = {}) => {
      lifecycle.track(value);
      if (transient) return;
      child = value;
      state.pid = child.pid ?? null;
      child.once('error', (error) => fail({ error: error.message }));
      child.once('exit', (code, signal) => fail({ code, signal, pid: child.pid }));
    };
    let starting = true;
    const queueRetry = () => {
      if (!stopped && !lifecycle.shuttingDown && !timer) {
        timer = schedule(() => { timer = null; void launch(); }, Math.max(0, state.retryAt - now()));
      }
    };
    // Runtime exits schedule immediately; startup exits await cleanup below.
    const onChild = (value, options) => {
      track(value, options);
      if (!options?.transient) {
        value.once('error', () => { if (!starting && failed) queueRetry(); });
        value.once('exit', () => { if (!starting && failed) queueRetry(); });
      }
    };
    try {
      const result = await start({ onChild });
      if (stopped || lifecycle.shuttingDown) return;
      if (child && (child.exitCode != null || child.signalCode != null)) {
        fail({ code: child.exitCode, signal: child.signalCode, pid: child.pid });
      }
      if (!failed) {
        readyAt = now();
        state = { status: result?.managed === false ? 'external_or_disabled' : 'ready',
          pid: child?.pid ?? null, ...(result?.url ? { url: result.url } : {}) };
        log({ service: name, event: state.status, pid: state.pid, url: result?.url });
      }
    } catch (error) {
      // Also clean failures after spawn but outside a helper's readiness gate.
      fail({ error: error.message });
    } finally {
      starting = false;
      if (failed) queueRetry();
    }
  }
  const ready = launch();
  return { ready, stop, snapshot };
}

module.exports = { createServiceLogger, superviseService };
