// Component QA server: uses the actual workbench and retained repository responses.
// It has no credentials, writable endpoints, auth bypass in product code, or live model calls.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const esbuild = require('esbuild');
const postcss = require('postcss');
const tailwind = require('tailwindcss');
async function main() {
  const evidenceRoot = path.resolve(process.argv[2] || '');
  if (!process.argv[2] || !evidenceRoot.startsWith(path.resolve('data/research-agent-upgrade/evidence/S13') + path.sep)) throw new Error('Explicit retained S13 evidence directory required');
  const output = path.join(evidenceRoot, 'workbench-qa'); await fs.mkdir(output, { recursive: true });
  const qaArguments = process.argv.slice(3), streamReplay = qaArguments.includes('--stream-replay');
  const fixtureArgument = qaArguments.find(value => !value.startsWith('--'));
  if (qaArguments.some(value => value !== fixtureArgument && value !== '--stream-replay')) throw new Error('Unknown QA argument');
  const fixturePath = fixtureArgument ? path.resolve(fixtureArgument) : null;
  if (fixturePath && (!fixturePath.startsWith(path.resolve('data/research-agent-upgrade/evidence/S15') + path.sep) || path.basename(fixturePath) !== 'reader-fixture.json')) throw new Error('Optional reader fixture must be a retained S15 fixture');
  const entry = `import React from 'react'; import { createRoot } from 'react-dom/client'; import FinancialWorkbench from './src/app/company-research/financial/FinancialWorkbench'; createRoot(document.getElementById('root')).render(<React.StrictMode><FinancialWorkbench /></React.StrictMode>);`;
  const bundle = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, jsx: 'automatic', platform: 'browser', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'framework-link-only', setup(build) {
    build.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'next-link-shim', namespace: 'qa' }));
    build.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: `import React from 'react'; export default function Link({href,children,...props}){return React.createElement('a',{...props,href},children)}`, loader: 'js', resolveDir: process.cwd() }));
  } }] });
  const files = (await fs.readdir('src/app/company-research/financial')).filter(f => f.endsWith('.tsx')).map(f => `./src/app/company-research/financial/${f}`);
  const config = require('tailwindcss/loadConfig')(path.resolve('tailwind.config.ts')); config.content = files;
  const css = await postcss([tailwind(config)]).process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined });
  await fs.writeFile(path.join(output, 'app.js'), bundle.outputFiles[0].contents); await fs.writeFile(path.join(output, 'app.css'), css.css);
  // Synthetic transport scenarios never enter a database or contribute financial evidence.
  const replays = new Map(streamReplay ? [
    ['00000000-0000-4000-8000-000000000014', { name: '事件断线恢复演练（合成）', stage: 0, connections: 0 }],
    ['00000000-0000-4000-8000-000000000015', { name: '事件切换隔离演练（合成）', stage: 0, connections: 0 }],
  ] : []);
  function replayTask(template, id, replay) {
    const task = structuredClone(template);
    task.id = id; task.spec.company.name = replay.name; task.status = replay.stage === 2 ? 'cancelled' : 'running';
    task.generation = 1; task.sequence = 100 + replay.stage * 2; task.report = null; task.reportHash = null; task.reportRevision = 0; task.acceptance = null;
    task.usage = { ...task.usage, toolCalls: replay.stage, inputTokens: null, outputTokens: null, unknownModelRequests: 0 };
    task.checkpoint = { ...task.checkpoint, facts: [], claims: [], observations: [], steps: { 'income_profit-retrieve': replay.stage ? 'completed' : 'running' }, phase: 'researching', submitted: false, checkedHash: null, stopReason: null };
    task.documents = []; task.reviews = []; task.changes = [];
    return task;
  }
  function replayStream(response, template, id, replay) {
    const connection = ++replay.connections;
    const log = event => void fs.appendFile(path.join(output, 'stream-replay-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), id, connection, ...event }) + '\n');
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    log({ event: 'opened' }); send('snapshot', replayTask(template, id, replay));
    const timer = setTimeout(() => {
      if (connection === 1) {
        replay.stage = 1;
        const event = { schemaVersion: 1, id: randomUUID(), at: new Date().toISOString(), taskId: id, sequence: 102, generation: 1,
          requestRevision: 1, planRevision: 1, reportRevision: null, attemptId: null, event: { type: 'research.progress', phase: 'researching', tool: null, message: '合成事件回放' } };
        send('research', event); send('research', event); send('research', { ...event, sequence: 101 });
        log({ event: 'gap_duplicate_late_then_disconnect' }); response.end();
      } else {
        replay.stage = 2; send('snapshot', replayTask(template, id, replay));
        log({ event: 'terminal_snapshot', sequence: 104 }); response.end();
      }
    }, 800);
    response.on('close', () => { clearTimeout(timer); log({ event: 'closed' }); });
  }
  async function retained() {
    const tasks = [], sources = [];
    for (const stem of ['complete-corpus', 'missing-second-period', 'scan-case']) {
      try { const task = JSON.parse(await fs.readFile(path.join(evidenceRoot, `${stem}.json`), 'utf8')); tasks.push(task); sources.push(...JSON.parse(await fs.readFile(path.join(evidenceRoot, `${stem}-sources.json`), 'utf8')).map(s => ({ ...s, _taskId: task.id }))); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (fixturePath) {
      const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
      tasks.push(fixture.task); sources.push(...fixture.sources.map(s => ({ ...s, _taskId: fixture.task.id })));
    }
    if (tasks[0]) for (const [id, replay] of replays) tasks.push(replayTask(tasks[0], id, replay));
    return { tasks, sources };
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1'), { tasks, sources } = await retained();
      const send = (status, body, type = 'application/json') => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(type === 'application/json' ? JSON.stringify(body) : body); };
      if (request.method !== 'GET') return send(405, { error: 'QA server is read only' });
      if (url.pathname === '/app.js') return send(200, bundle.outputFiles[0].contents, 'application/javascript');
      if (url.pathname === '/app.css') return send(200, css.css, 'text/css');
      if (url.pathname === '/api/company-research/tasks') return send(200, { tasks });
      const match = url.pathname.match(/^\/api\/company-research\/tasks\/([^/]+)(?:\/(source|events))?$/);
      if (match) {
        const task = tasks.find(t => t.id === match[1]); if (!task) return send(404, { error: 'Retained task not found' });
        if (match[2] === 'events') {
          const replay = replays.get(task.id);
          if (replay) return replayStream(response, task, task.id, replay);
          return send(200, `event: snapshot\ndata: ${JSON.stringify(task)}\n\n`, 'text/event-stream');
        }
        if (match[2] === 'source') {
          const source = sources.find(s => s._taskId === task.id && Object.entries(s.selection).every(([k,v]) => String(v) === url.searchParams.get(k)));
          return send(source ? 200 : 404, source ? { source } : { error: 'Source not found' });
        }
        return send(200, { task });
      }
      return send(200, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>财报变化研究 · 组件验收</title><link rel="stylesheet" href="/app.css"><style>:root{--radius:.75rem}body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #047857;outline-offset:3px}</style><div id="root"></div><script src="/app.js"></script></html>', 'text/html; charset=utf-8');
    } catch (e) { response.writeHead(500); response.end(e.message); }
  });
  server.listen(0, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${server.address().port}/company-research`;
    await fs.writeFile(path.join(output, 'server.json'), JSON.stringify({ url, evidenceRoot, fixturePath, streamReplay, scope: 'actual React components + retained repository JSON; optional synthetic hostile-source and EventSource replay fixtures; framework Link shim; not full Next.js/auth/live worker E2E', startedAt: new Date().toISOString() }, null, 2));
    console.log(url);
  });
  process.on('SIGINT', () => server.close()); process.on('SIGTERM', () => server.close());
}
main().catch(e => { console.error(e); process.exitCode = 1; });
