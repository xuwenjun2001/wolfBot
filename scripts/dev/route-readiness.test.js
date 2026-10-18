const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  compareRouteSets,
  inventorySourceRoutes,
  parseAppRouteHandlerRoutes,
  waitForRouteReadiness,
  createRouteDiscoveryRefresh,
  probeWebHealth,
} = require('./route-readiness');

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-route-readiness-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function writeRoute(appDir, segments, extension = 'ts') {
  const directory = path.join(appDir, ...segments);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `route.${extension}`), 'export function GET() { return Response.json({}); }');
}

function routeTypes(routes) {
  return `type AppRouteHandlerRoutes = ${routes.length ? routes.map((route) => JSON.stringify(route)).join(' | ') : 'never'};\n`;
}

async function withTestServer(server, callback) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await callback(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('inventories deep routes while applying groups, private segments, and configured extensions', async () => {
  await withTempDirectory(async (directory) => {
    const appDir = path.join(directory, 'src', 'app');
    await fs.mkdir(appDir, { recursive: true });
    await writeRoute(appDir, ['api', '[project_id]', 'agent', 'approvals']);
    await writeRoute(appDir, ['api', '[project_id]', 'agent', 'approvals', '[approval_id]']);
    await writeRoute(appDir, ['api', '(v1)', 'projects'], 'mdx');
    await writeRoute(appDir, [], 'js');
    await writeRoute(appDir, ['api', '_private', 'hidden']);
    await writeRoute(appDir, ['api', 'public', '_private', 'hidden']);
    await writeRoute(appDir, ['api', 'ignored'], 'tsx');

    const routes = await inventorySourceRoutes({
      appDir,
      pageExtensions: ['.ts', 'mdx', 'js'],
    });

    assert.deepEqual(routes, [
      '/',
      '/api/[project_id]/agent/approvals',
      '/api/[project_id]/agent/approvals/[approval_id]',
      '/api/projects',
    ]);
  });
});

test('recovers a partial or corrupted router snapshot through bounded discovery refresh', async () => {
  await withTempDirectory(async (directory) => {
    const routeTypesPath = path.join(directory, 'routes.d.ts');
    await fs.writeFile(routeTypesPath, 'type AppRouteHandlerRoutes = "unterminated');
    let refreshes = 0;
    const readiness = await waitForRouteReadiness({
      sourceRoutes: ['/api/a', '/api/deep/[id]/action'], routeTypesPath,
      timeoutMs: 1000, intervalMs: 10, refreshIntervalMs: 20,
      refreshRoutes: async () => {
        refreshes += 1;
        await fs.writeFile(routeTypesPath, routeTypes(['/api/a', '/api/deep/[id]/action']));
      },
    });
    assert.equal(readiness.complete, true);
    assert.equal(refreshes, 1);
  });
});

test('never accepts an incomplete router or refreshes indefinitely', async () => {
  await withTempDirectory(async (directory) => {
    const routeTypesPath = path.join(directory, 'routes.d.ts');
    await fs.writeFile(routeTypesPath, routeTypes(['/api/a']));
    let refreshes = 0;
    await assert.rejects(waitForRouteReadiness({
      sourceRoutes: ['/api/a', '/api/deep'], routeTypesPath,
      timeoutMs: 120, intervalMs: 10, refreshIntervalMs: 10, maxRefreshAttempts: 2,
      refreshRoutes: async () => { refreshes += 1; },
    }), (error) => error.code === 'ERR_NEXT_ROUTE_READINESS_TIMEOUT' && error.missingRoutes[0] === '/api/deep');
    assert.equal(refreshes, 2);
  });
});

test('requires stable route registration and healthy HTTP, not only generated types', async () => {
  await withTempDirectory(async (directory) => {
    const routeTypesPath = path.join(directory, 'routes.d.ts');
    await fs.writeFile(routeTypesPath, routeTypes(['/api/a']));
    let checks = 0;
    await waitForRouteReadiness({
      sourceRoutes: ['/api/a'], routeTypesPath, timeoutMs: 1000, intervalMs: 10,
      probeReady: async () => ++checks > 2,
    });
    assert.equal(checks, 4);
  });
});

for (const [label, replacement] of [
  ['partial', routeTypes(['/api/health'])],
  ['corrupted', 'type AppRouteHandlerRoutes = "unterminated'],
]) {
  test(`revalidates ${label} types written during the final health probe before returning a captured snapshot`, async () => {
    const sourceRoutes = ['/api/health', '/api/deep/[id]'];
    let contents = routeTypes(sourceRoutes);
    const recovered = `// Recovered generation\n${contents}`;
    let probes = 0;
    let refreshes = 0;
    const readiness = await waitForRouteReadiness({
      sourceRoutes, routeTypesPath: 'in-memory', timeoutMs: 1000,
      intervalMs: 1, refreshIntervalMs: 0,
      fsImpl: {
        stat: async () => ({ isFile: () => true, mtimeMs: Date.now() }),
        readFile: async () => contents,
      },
      probeReady: async () => {
        // The first complete check passed; this was previously accepted as the second.
        if (++probes === 2) contents = replacement;
        return true;
      },
      refreshRoutes: async () => { refreshes += 1; contents = recovered; },
    });
    assert.equal(refreshes, 1);
    assert.equal(probes, 4, 'the changed snapshot must reset consecutive stable checks');
    assert.equal(readiness.complete, true);
    assert.deepEqual(readiness.generatedRoutes, [...sourceRoutes].sort());
    contents = replacement;
    assert.equal(readiness.validatedRouteTypesContent, recovered, 'copying must not require another live file read');
  });
}

test('requires unchanged content across probes even when both generations have complete route unions', async () => {
  const sourceRoutes = ['/api/health'];
  let contents = routeTypes(sourceRoutes);
  const replacement = `// New generation\n${contents}`;
  let probes = 0;
  const readiness = await waitForRouteReadiness({
    sourceRoutes, routeTypesPath: 'in-memory', timeoutMs: 1000, intervalMs: 1,
    fsImpl: {
      stat: async () => ({ isFile: () => true, mtimeMs: Date.now() }),
      readFile: async () => contents,
    },
    probeReady: async () => {
      if (++probes === 2) contents = replacement;
      return true;
    },
  });
  assert.equal(probes, 4);
  assert.equal(readiness.validatedRouteTypesContent, replacement);
});

test('rejects child exit during post-probe revalidation', async () => {
  const child = new EventEmitter();
  let reads = 0;
  await assert.rejects(waitForRouteReadiness({
    sourceRoutes: ['/api/health'], routeTypesPath: 'in-memory', child,
    timeoutMs: 1000, intervalMs: 1, stableChecks: 1,
    fsImpl: {
      stat: async () => ({ isFile: () => true, mtimeMs: Date.now() }),
      readFile: async () => {
        if (++reads === 2) child.emit('exit', 17, null);
        return routeTypes(['/api/health']);
      },
    },
    probeReady: async () => true,
  }), (error) => error.code === 'ERR_NEXT_DEV_SERVER_EXITED');
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('refresh marker does not change source routes and is removed on cleanup', async () => {
  await withTempDirectory(async (appDir) => {
    await writeRoute(appDir, ['api', 'a']);
    const original = await inventorySourceRoutes({ appDir });
    const discovery = await createRouteDiscoveryRefresh(appDir);
    try {
      await discovery.refresh();
      await discovery.refresh();
      assert.deepEqual(await inventorySourceRoutes({ appDir }), original);
      assert.equal((await fs.readdir(appDir)).filter((name) => name.startsWith('.quantpilot-route-refresh-')).length, 1);
    } finally { await discovery.close(); }
    assert.deepEqual(await fs.readdir(appDir), ['api']);
  });
});

test('health probe rejects generic HTML and accepts the wolfbot service identity', async () => {
  const http = require('node:http');
  let mode = 'html';
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/health');
    res.end(mode === 'html' ? '<html>not ready</html>' : JSON.stringify({ ok: true, service: 'quantpilot-web' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal(await probeWebHealth(url), false);
    mode = 'healthy';
    assert.equal(await probeWebHealth(url), true);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

// Public test-only key and self-signed certificate, valid 2020–2040.
// Embedded so the HTTPS regression needs no npm dependency or openssl binary.
const LOCAL_TLS_FIXTURE = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGNcTmyschyCglo/i
L9Y0/bV+SJlU3HV1WRelN7K3qOWhRANCAARvDTRPam6eYeLVCiU9OPvODzaVzY4q
8Ckfor0rQg70tC7PtLOgokB+wzb0tt7HiDKdBbfVOXwae7pGleb0bSXC
-----END PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBTDCB9KADAgECAggGVjGXISy1BzAKBggqhkjOPQQDAjAUMRIwEAYDVQQDEwls
b2NhbGhvc3QwHhcNMjAwMTAxMDAwMDAwWhcNNDAwMTAxMDAwMDAwWjAUMRIwEAYD
VQQDEwlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARvDTRPam6e
YeLVCiU9OPvODzaVzY4q8Ckfor0rQg70tC7PtLOgokB+wzb0tt7HiDKdBbfVOXwa
e7pGleb0bSXCozAwLjAsBgNVHREEJTAjgglsb2NhbGhvc3SHBH8AAAGHEAAAAAAA
AAAAAAAAAAAAAAEwCgYIKoZIzj0EAwIDRwAwRAIfYw+x3YXkbLQA4j8JbZXx2yA4
1XpudGmQ+2Oj/PEtjAIhAJ7mFGKcFyBxWaIQaZS6CjGFojToiW3UVxu+iFGcb5R8
-----END CERTIFICATE-----`,
};

test('self-signed HTTPS requires an explicit local opt-in and does not weaken later probes', async () => {
  const https = require('node:https');
  let requests = 0;
  const server = https.createServer(LOCAL_TLS_FIXTURE, (req, res) => {
    requests += 1;
    assert.equal(req.url, '/api/health');
    res.end(JSON.stringify({ ok: true, service: 'quantpilot-web' }));
  });
  await withTestServer(server, async (port) => {
    const url = `https://127.0.0.1:${port}`;
    assert.equal(await probeWebHealth(url), false);
    assert.equal(await probeWebHealth(url, { allowSelfSigned: true }), true);
    assert.equal(await probeWebHealth(url), false);
    assert.equal(requests, 1, 'only the opted-in request may reach the self-signed listener');
  });
});

test('self-signed HTTPS opt-in never follows a redirect to another local endpoint', async () => {
  const https = require('node:https');
  let redirectedRequests = 0;
  const target = https.createServer(LOCAL_TLS_FIXTURE, (req, res) => {
    redirectedRequests += 1;
    res.end(JSON.stringify({ ok: true, service: 'quantpilot-web' }));
  });
  await withTestServer(target, async (targetPort) => {
    const redirect = https.createServer(LOCAL_TLS_FIXTURE, (req, res) => {
      res.writeHead(302, { Location: `https://127.0.0.1:${targetPort}/api/health` });
      res.end();
    });
    await withTestServer(redirect, async (port) => {
      assert.equal(await probeWebHealth(`https://127.0.0.1:${port}`, { allowSelfSigned: true }), false);
      assert.equal(redirectedRequests, 0);
    });
  });
});

test('self-signed local opt-in preserves certificate verification for remote hosts', async (t) => {
  const https = require('node:https');
  let capturedOptions;
  t.mock.method(https, 'get', (url, options) => {
    capturedOptions = options;
    const request = new EventEmitter();
    process.nextTick(() => request.emit('error', new Error('no network in this test')));
    return request;
  });
  assert.equal(await probeWebHealth('https://example.invalid:3443', { allowSelfSigned: true }), false);
  assert.equal(capturedOptions.rejectUnauthorized, true);
  assert.equal(capturedOptions.agent, false);
});

test('health probe timeout covers a response body that never finishes', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"ok":');
  });
  await withTestServer(server, async (port) => {
    assert.equal(await probeWebHealth(`http://127.0.0.1:${port}`, { timeoutMs: 50 }), false);
  });
});

test('parses AppRouteHandlerRoutes through the TypeScript AST', () => {
  const routes = parseAppRouteHandlerRoutes(`
    // Generated route declaration.
    type OtherRoutes = "/not-used";
    type AppRouteHandlerRoutes = ("/api/projects/[project_id]" | "/api/a")
      | never
      | \`/api/static\`
      | "/api/a";
  `);

  assert.deepEqual(routes, [
    '/api/a',
    '/api/projects/[project_id]',
    '/api/static',
  ]);
});

test('compares source and generated route sets with concrete missing routes', () => {
  assert.deepEqual(
    compareRouteSets(['/api/b', '/api/a'], ['/api/a', '/api/old']),
    {
      sourceRoutes: ['/api/a', '/api/b'],
      generatedRoutes: ['/api/a', '/api/old'],
      missingRoutes: ['/api/b'],
      extraRoutes: ['/api/old'],
    }
  );
});

test('waits for an incomplete generated union to become complete', async () => {
  await withTempDirectory(async (directory) => {
    const routeTypesPath = path.join(directory, 'routes.d.ts');
    const startedAt = Date.now();
    await fs.writeFile(routeTypesPath, routeTypes(['/api/a']));
    const child = new EventEmitter();
    child.exitCode = null;

    const update = new Promise((resolve) => {
      setTimeout(async () => {
        await fs.writeFile(routeTypesPath, routeTypes(['/api/a', '/api/b']));
        resolve();
      }, 40);
    });

    const readiness = await waitForRouteReadiness({
      sourceRoutes: ['/api/a', '/api/b'],
      routeTypesPath,
      startedAt,
      child,
      timeoutMs: 500,
      intervalMs: 10,
    });
    await update;

    assert.equal(readiness.complete, true);
    assert.deepEqual(readiness.missingRoutes, []);
  });
});

test('times out on stale or incomplete route output and reports missing routes', async () => {
  await withTempDirectory(async (directory) => {
    const routeTypesPath = path.join(directory, 'routes.d.ts');
    await fs.writeFile(routeTypesPath, routeTypes(['/api/a']));
    const child = new EventEmitter();
    child.exitCode = null;

    await assert.rejects(
      waitForRouteReadiness({
        sourceRoutes: ['/api/a', '/api/b'],
        routeTypesPath,
        startedAt: Date.now() + 1_000,
        child,
        timeoutMs: 60,
        intervalMs: 10,
      }),
      (error) => {
        assert.equal(error.code, 'ERR_NEXT_ROUTE_READINESS_TIMEOUT');
        assert.deepEqual(error.missingRoutes, ['/api/a', '/api/b']);
        assert.match(error.message, /\/api\/a/);
        assert.match(error.message, /\/api\/b/);
        return true;
      }
    );
  });
});

test('stops waiting and removes child listeners when Next exits early', async () => {
  await withTempDirectory(async (directory) => {
    const routeTypesPath = path.join(directory, 'routes.d.ts');
    const child = new EventEmitter();
    child.exitCode = null;
    const readiness = waitForRouteReadiness({
      sourceRoutes: ['/api/a'],
      routeTypesPath,
      child,
      timeoutMs: 500,
      intervalMs: 500,
    });

    setTimeout(() => child.emit('exit', 17, null), 20);
    await assert.rejects(readiness, (error) => {
      assert.equal(error.code, 'ERR_NEXT_DEV_SERVER_EXITED');
      assert.match(error.message, /code 17/);
      return true;
    });
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
  });
});
