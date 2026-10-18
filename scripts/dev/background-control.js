const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const rootDir = path.resolve(__dirname, '../..');
const runtimeDir = path.join(rootDir, 'data', 'logs', 'dev-stack');
// A named pipe / Unix socket is an OS-owned singleton. A stale PID file cannot
// cause this controller to kill an unrelated process after PID reuse.
const key = crypto.createHash('sha256').update(rootDir.toLowerCase()).digest('hex').slice(0, 16);
const endpoint = process.platform === 'win32'
  ? `\\\\.\\pipe\\quantpilot-dev-${key}` : path.join(runtimeDir, 'control.sock');
const tokenFile = path.join(runtimeDir, 'control.token');

function request(command, token = '', timeout = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let data = '';
    socket.setTimeout(timeout, () => socket.destroy(new Error('Service control timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ command, token })}\n`));
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        socket.end();
        try { resolve(JSON.parse(data.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
    socket.on('error', reject);
    socket.on('end', () => { if (!data.includes('\n')) reject(new Error('Control connection closed')); });
  });
}

function attachBackgroundControl({ lifecycle, services, log }) {
  const token = process.env.QUANTPILOT_DEV_BACKGROUND_TOKEN;
  delete process.env.QUANTPILOT_DEV_BACKGROUND_TOKEN;
  const server = net.createServer((socket) => {
    let input = '';
    socket.setTimeout(1500, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      let message;
      try { message = JSON.parse(input.split('\n')[0]); } catch { socket.destroy(); return; }
      if (message.command === 'status') {
        socket.end(`${JSON.stringify({ pid: process.pid, services: Object.fromEntries(
          Object.entries(services).map(([name, service]) => [name, service.snapshot()])
        ) })}\n`);
      } else if (message.command === 'stop' && message.token === token) {
        socket.end('{"stopping":true}\n', () => lifecycle.shutdown(0, 'background-stop'));
      } else socket.end('{"error":"Invalid control request"}\n');
    });
  });
  server.on('error', (error) => {
    log({ event: 'control-error', error: error.message });
    lifecycle.shutdown(1, 'background-control-error');
  });
  server.listen(endpoint, () => {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  });
  lifecycle.onShutdown(() => {
    server.close();
    try { if (fs.readFileSync(tokenFile, 'utf8') === token) fs.rmSync(tokenFile); } catch {}
  });
}

module.exports = { request, attachBackgroundControl, runtimeDir, tokenFile, endpoint };
