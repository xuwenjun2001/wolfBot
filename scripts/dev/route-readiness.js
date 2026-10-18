const fs = require('fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('path');
const ts = require('typescript');

const DEFAULT_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];
const ROUTE_READINESS_TIMEOUT_MS = 30_000;
const ROUTE_READINESS_INTERVAL_MS = 500;

// Next's dev router can publish a partial Watchpack snapshot on Windows.
// An ordinary, non-route file event makes it rebuild from the completed scan.
// Never manufacture routes.d.ts: the real router must discover the routes too.
async function createRouteDiscoveryRefresh(appDir) {
  const { randomUUID } = require('node:crypto');
  const marker = path.join(appDir, `.quantpilot-route-refresh-${randomUUID()}`);
  let owned = false;
  return {
    async refresh() {
      await fs.writeFile(marker, `${Date.now()}\n`, { flag: owned ? 'w' : 'wx' });
      owned = true;
    },
    async close() {
      if (owned) await fs.unlink(marker).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
}

function isLocalHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (!net.isIP(host)) return false;
  if (net.isIPv4(host) && host.startsWith('127.')) return true;
  return Object.values(os.networkInterfaces()).some((addresses) => (
    addresses?.some(({ address }) => address.toLowerCase() === host)
  ));
}

// The TLS exception is opt-in, request-local, and limited to a selected local
// listener. Do not follow redirects or reuse a TLS agent with weaker settings.
async function probeWebHealth(url, { allowSelfSigned = false, timeoutMs = 2000 } = {}) {
  try {
    const endpoint = new URL('api/health', url.endsWith('/') ? url : `${url}/`);
    if (!['http:', 'https:'].includes(endpoint.protocol)) return false;
    const secure = endpoint.protocol === 'https:';
    const transport = secure ? https : http;
    const permitSelfSigned = allowSelfSigned === true && isLocalHostname(endpoint.hostname);
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : 2000;
    return await new Promise((resolve) => {
      const request = transport.get(endpoint, {
        agent: false,
        signal: AbortSignal.timeout(effectiveTimeoutMs),
        headers: { 'Cache-Control': 'no-cache' },
        ...(secure ? { rejectUnauthorized: !permitSelfSigned } : {}),
      }, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          resolve(false);
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            response.destroy();
            resolve(false);
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', () => resolve(false));
        response.once('aborted', () => resolve(false));
        response.once('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(body?.ok === true && body?.service === 'quantpilot-web');
          } catch {
            resolve(false);
          }
        });
      });
      request.once('error', () => resolve(false));
    });
  } catch {
    return false;
  }
}

function sortStrings(values) {
  return [...new Set(values)].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function normalizePageExtensions(pageExtensions) {
  const values = Array.isArray(pageExtensions)
    ? pageExtensions
    : DEFAULT_PAGE_EXTENSIONS;

  return [...new Set(values
    .map((extension) => String(extension).trim().replace(/^\./, ''))
    .filter((extension) => extension && !/[\\/]/.test(extension)))];
}

function getConfiguredPageExtensions(nextConfig = {}) {
  return normalizePageExtensions(nextConfig?.pageExtensions);
}

function normalizeRouteSegments(segments) {
  const normalized = [];

  for (const segment of segments) {
    if (segment.startsWith('_')) {
      return null;
    }
    if (segment.startsWith('(') && segment.endsWith(')')) {
      continue;
    }
    normalized.push(segment);
  }

  return normalized;
}

function routePathFromSegments(segments) {
  const normalized = normalizeRouteSegments(segments);
  if (!normalized) {
    return null;
  }
  return normalized.length ? `/${normalized.join('/')}` : '/';
}

async function inventorySourceRoutes({
  appDir,
  pageExtensions,
  fsImpl = fs,
} = {}) {
  if (!appDir) {
    throw new TypeError('appDir is required to inventory Next.js routes.');
  }

  const routeFileNames = new Set(
    normalizePageExtensions(pageExtensions).map((extension) => `route.${extension}`)
  );
  const routes = new Set();

  async function visit(directory, segments) {
    const entries = await fsImpl.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('_')) {
          continue;
        }
        await visit(entryPath, [...segments, entry.name]);
        continue;
      }

      if (!entry.isFile() || !routeFileNames.has(entry.name)) {
        continue;
      }

      const routePath = routePathFromSegments(segments);
      if (routePath) {
        routes.add(routePath);
      }
    }
  }

  await visit(appDir, []);
  return sortStrings(routes);
}

function diagnosticText(diagnostic, sourceFile) {
  return ts.flattenDiagnosticMessageText(
    ts.formatDiagnostics([diagnostic], {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }),
    '\n'
  ) || `Unable to parse ${sourceFile.fileName}.`;
}

function collectStringLiteralTypes(typeNode, routes) {
  if (ts.isUnionTypeNode(typeNode)) {
    for (const member of typeNode.types) {
      collectStringLiteralTypes(member, routes);
    }
    return;
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    collectStringLiteralTypes(typeNode.type, routes);
    return;
  }

  if (!ts.isLiteralTypeNode(typeNode)) {
    return;
  }

  const literal = typeNode.literal;
  if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) {
    routes.add(literal.text);
  }
}

function parseAppRouteHandlerRoutes(sourceText, fileName = 'routes.d.ts') {
  if (typeof sourceText !== 'string') {
    throw new TypeError('sourceText must be a string.');
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sourceFile.parseDiagnostics?.length) {
    throw new Error(diagnosticText(sourceFile.parseDiagnostics[0], sourceFile));
  }

  let routeTypeAlias;
  function findRouteTypeAlias(node) {
    if (
      !routeTypeAlias &&
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === 'AppRouteHandlerRoutes'
    ) {
      routeTypeAlias = node;
      return;
    }
    ts.forEachChild(node, findRouteTypeAlias);
  }
  findRouteTypeAlias(sourceFile);

  if (!routeTypeAlias) {
    throw new Error(
      `Generated route types do not declare AppRouteHandlerRoutes (${fileName}).`
    );
  }

  const routes = new Set();
  collectStringLiteralTypes(routeTypeAlias.type, routes);
  return sortStrings(routes);
}

async function readAppRouteHandlerRoutes(routeTypesPath, fsImpl = fs) {
  const sourceText = await fsImpl.readFile(routeTypesPath, 'utf8');
  return parseAppRouteHandlerRoutes(sourceText, routeTypesPath);
}

function compareRouteSets(sourceRoutes, generatedRoutes) {
  const expected = sortStrings(sourceRoutes || []);
  const actual = sortStrings(generatedRoutes || []);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);

  return {
    sourceRoutes: expected,
    generatedRoutes: actual,
    missingRoutes: expected.filter((route) => !actualSet.has(route)),
    extraRoutes: actual.filter((route) => !expectedSet.has(route)),
  };
}

async function inspectRouteReadiness({
  sourceRoutes,
  routeTypesPath,
  startedAt,
  fsImpl = fs,
} = {}) {
  const expected = sortStrings(sourceRoutes || []);
  let stat;
  try {
    stat = await fsImpl.stat(routeTypesPath);
  } catch {
    return {
      ...compareRouteSets(expected, []),
      complete: false,
      reason: 'generated route types output does not exist yet',
    };
  }

  if (!stat.isFile()) {
    return {
      ...compareRouteSets(expected, []),
      complete: false,
      reason: 'generated route types output is not a file',
    };
  }

  if (Number.isFinite(startedAt) && stat.mtimeMs < startedAt) {
    return {
      ...compareRouteSets(expected, []),
      complete: false,
      reason: 'generated route types output predates this Next.js child',
    };
  }

  let generatedRoutes;
  let sourceText;
  try {
    sourceText = await fsImpl.readFile(routeTypesPath, 'utf8');
    generatedRoutes = parseAppRouteHandlerRoutes(sourceText, routeTypesPath);
  } catch (error) {
    return {
      ...compareRouteSets(expected, []),
      complete: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const comparison = compareRouteSets(expected, generatedRoutes);
  const complete = comparison.missingRoutes.length === 0;
  return {
    ...comparison,
    complete,
    ...(complete ? { validatedRouteTypesContent: sourceText } : {}),
    reason: null,
  };
}

function createTimeoutError({ routeTypesPath, missingRoutes, timeoutMs, reason }) {
  const missing = missingRoutes.length
    ? missingRoutes.map((route) => `  - ${route}`).join('\n')
    : '  - (route type declaration could not be read)';
  const detail = reason ? `\nLast check: ${reason}` : '';
  const error = new Error(
    `Next.js API route readiness timed out after ${timeoutMs} ms. ` +
      `Missing routes from AppRouteHandlerRoutes in ${routeTypesPath}:\n${missing}${detail}`
  );
  error.code = 'ERR_NEXT_ROUTE_READINESS_TIMEOUT';
  error.missingRoutes = [...missingRoutes];
  return error;
}

function createChildExitError(code, signal) {
  const suffix = signal ? ` (signal ${signal})` : '';
  const error = new Error(
    `Next.js dev server exited before API route readiness (code ${code ?? 'unknown'}${suffix}).`
  );
  error.code = 'ERR_NEXT_DEV_SERVER_EXITED';
  return error;
}

async function waitForRouteReadiness({
  appDir,
  pageExtensions,
  sourceRoutes,
  routeTypesPath,
  startedAt,
  child,
  timeoutMs = ROUTE_READINESS_TIMEOUT_MS,
  intervalMs = ROUTE_READINESS_INTERVAL_MS,
  fsImpl = fs,
  refreshRoutes,
  refreshIntervalMs = 5000,
  maxRefreshAttempts = 3,
  probeReady,
  stableChecks = 2,
  onProgress = () => {},
} = {}) {
  if (!routeTypesPath) {
    throw new TypeError('routeTypesPath is required for Next.js route readiness.');
  }

  const expected = sourceRoutes
    ? sortStrings(sourceRoutes)
    : await inventorySourceRoutes({ appDir, pageExtensions, fsImpl });
  const effectiveTimeoutMs = Math.min(
    ROUTE_READINESS_TIMEOUT_MS,
    Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : ROUTE_READINESS_TIMEOUT_MS)
  );
  const effectiveIntervalMs = Math.max(
    1,
    Number.isFinite(intervalMs) ? intervalMs : ROUTE_READINESS_INTERVAL_MS
  );
  const deadline = Date.now() + effectiveTimeoutMs;
  let nextRefreshAt = Date.now() + refreshIntervalMs;
  let refreshAttempts = 0;
  let consecutiveComplete = 0;
  let stableContent;
  let childFailure;
  let wakeResolve;
  const childWake = new Promise((resolve) => {
    wakeResolve = resolve;
  });

  const onExit = (code, signal) => {
    childFailure = createChildExitError(code, signal);
    wakeResolve();
  };
  const onError = (error) => {
    childFailure = error instanceof Error ? error : new Error(String(error));
    wakeResolve();
  };

  if (child && (child.exitCode != null || child.signalCode != null)) {
    throw createChildExitError(child.exitCode, child.signalCode);
  }
  if (child?.once) {
    child.once('exit', onExit);
    child.once('error', onError);
  }

  let lastStatus;
  try {
    while (true) {
      if (childFailure) {
        throw childFailure;
      }

      lastStatus = await inspectRouteReadiness({
        sourceRoutes: expected,
        routeTypesPath,
        startedAt,
        fsImpl,
      });
      if (childFailure) {
        throw childFailure;
      }
      if (lastStatus.complete) {
        const beforeProbeContent = lastStatus.validatedRouteTypesContent;
        const healthy = !probeReady || await probeReady();
        if (childFailure) throw childFailure;

        // Watchpack can rewrite route types while the HTTP request is pending.
        // Revalidate and retain the actual parsed bytes for the caller to copy.
        lastStatus = await inspectRouteReadiness({
          sourceRoutes: expected,
          routeTypesPath,
          startedAt,
          fsImpl,
        });
        if (childFailure) throw childFailure;
        const content = lastStatus.validatedRouteTypesContent;
        if (healthy && lastStatus.complete && content === beforeProbeContent) {
          consecutiveComplete = content === stableContent ? consecutiveComplete + 1 : 1;
          stableContent = content;
          if (consecutiveComplete >= stableChecks) {
            return { ...lastStatus, refreshAttempts };
          }
        } else {
          consecutiveComplete = 0;
          stableContent = undefined;
          if (healthy && lastStatus.complete) {
            lastStatus.reason = 'generated route types changed during the HTTP health check';
          }
        }
        if (!healthy) lastStatus.reason = 'wolfbot HTTP health check is not ready';
      } else {
        consecutiveComplete = 0;
        stableContent = undefined;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw createTimeoutError({
          routeTypesPath,
          missingRoutes: lastStatus.missingRoutes,
          timeoutMs: effectiveTimeoutMs,
          reason: lastStatus.reason,
        });
      }

      if (!lastStatus.complete && refreshRoutes && refreshAttempts < maxRefreshAttempts && Date.now() >= nextRefreshAt) {
        refreshAttempts += 1;
        onProgress({ ...lastStatus, refreshAttempts });
        await refreshRoutes();
        nextRefreshAt = Date.now() + refreshIntervalMs;
      }

      let timer;
      try {
        await Promise.race([
          new Promise((resolve) => { timer = setTimeout(resolve, Math.min(effectiveIntervalMs, remainingMs)); }),
          childWake,
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (child?.removeListener) {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    }
  }
}

module.exports = {
  createRouteDiscoveryRefresh,
  probeWebHealth,
  DEFAULT_PAGE_EXTENSIONS,
  ROUTE_READINESS_TIMEOUT_MS,
  ROUTE_READINESS_INTERVAL_MS,
  compareRouteSets,
  getConfiguredPageExtensions,
  inspectRouteReadiness,
  inventorySourceRoutes,
  normalizePageExtensions,
  normalizeRouteSegments,
  parseAppRouteHandlerRoutes,
  readAppRouteHandlerRoutes,
  routePathFromSegments,
  waitForRouteReadiness,
};
