import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { getProjectById } from '@/lib/services/project';
import {
  ensureHeartbeat,
  stopHeartbeat,
  websocketManager,
  type ManagedSocket,
  type WebSocketManager,
} from './websocket-manager';

const WEBSOCKET_PATH_PREFIX = '/api/ws/';
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const UPGRADE_STATE = Symbol.for('wolf-research.websocket-upgrade-state');

type UpgradeSocket = Pick<Duplex, 'destroy' | 'end' | 'on' | 'write'> & {
  destroyed?: boolean;
  writableEnded?: boolean;
};

type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

interface WebSocketUpgradeState {
  listener: UpgradeListener;
  dispatchListener: UpgradeListener;
  webSocketServer: WebSocketServer;
  cleanup: () => void;
}

type ServerWithUpgradeState = Server & {
  [UPGRADE_STATE]?: WebSocketUpgradeState;
};

export class WebSocketUpgradeError extends Error {
  constructor(
    public readonly status: 400 | 404,
    public readonly code: 'INVALID_REQUEST' | 'PROJECT_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'WebSocketUpgradeError';
  }
}

function firstHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function effectiveRequestOrigin(request: IncomingMessage): string | null {
  const forwardedHost = firstHeader(request.headers['x-forwarded-host'])
    .split(',')[0]
    .trim();
  const host = forwardedHost || firstHeader(request.headers.host);
  const forwardedProtocol = firstHeader(request.headers['x-forwarded-proto'])
    .split(',')[0]
    .trim()
    .toLowerCase();
  const protocol = forwardedProtocol || ('encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http');

  if (!host || !['http', 'https'].includes(protocol)) {
    return null;
  }

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

export function isAllowedWebSocketOrigin(request: IncomingMessage): boolean {
  const origin = firstHeader(request.headers.origin);
  if (!origin || origin.toLowerCase() === 'null') {
    return false;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  return originUrl.origin === effectiveRequestOrigin(request);
}

export function toWebHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

export async function authorizeWebSocketProject(
  projectId: string,
  headers: Headers,
): Promise<void> {
  await requireAction({
    headers,
    action: projectRouteAction('chat-data', 'GET'),
    projectId,
  });

  if (!(await getProjectById(projectId))) {
    throw new WebSocketUpgradeError(
      404,
      'PROJECT_NOT_FOUND',
      'Project not found',
    );
  }
}

function parseRequestPath(requestUrl: string | undefined, host: string): {
  projectId: string | null;
  targeted: boolean;
} {
  if (!requestUrl) {
    return { projectId: null, targeted: false };
  }

  let pathname: string;
  try {
    pathname = new URL(requestUrl, `http://${host || 'localhost'}`).pathname;
  } catch {
    return { projectId: null, targeted: requestUrl.startsWith(WEBSOCKET_PATH_PREFIX) };
  }

  if (!pathname.startsWith(WEBSOCKET_PATH_PREFIX)) {
    return { projectId: null, targeted: false };
  }

  const encodedProjectId = pathname.slice(WEBSOCKET_PATH_PREFIX.length);
  if (!encodedProjectId || encodedProjectId.includes('/')) {
    return { projectId: null, targeted: true };
  }

  try {
    const projectId = decodeURIComponent(encodedProjectId);
    return {
      projectId: PROJECT_ID_PATTERN.test(projectId) ? projectId : null,
      targeted: true,
    };
  } catch {
    return { projectId: null, targeted: true };
  }
}

function writeUpgradeError(
  socket: UpgradeSocket,
  status: number,
  code: string,
  message: string,
): void {
  if (socket.destroyed || socket.writableEnded) {
    return;
  }

  const body = Buffer.from(JSON.stringify({ success: false, error: code, message }));
  try {
    socket.write(
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${body.byteLength}\r\n` +
        '\r\n',
    );
    socket.end(body);
  } catch {
    socket.destroy();
  }
}

function classifyUpgradeError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof AuthorizationError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof WebSocketUpgradeError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: 'WEBSOCKET_UPGRADE_FAILED',
    message: 'WebSocket upgrade failed.',
  };
}

export interface WebSocketUpgradeDependencies {
  authorize?: (projectId: string, headers: Headers) => Promise<void>;
  manager?: Pick<WebSocketManager, 'addConnection'>;
}

function isTargetedUpgradeRequest(request: IncomingMessage): boolean {
  const parsed = parseRequestPath(
    request.url,
    firstHeader(request.headers['x-forwarded-host']) || firstHeader(request.headers.host),
  );
  return parsed.targeted;
}

function installUpgradeDispatcher(
  server: Server,
  listener: UpgradeListener,
): { dispatchListener: UpgradeListener; existingListeners: UpgradeListener[] } {
  const existingListeners = server.rawListeners('upgrade') as UpgradeListener[];

  // Next installs its upgrade listener before this page route is first invoked. Own the
  // event while auth is pending so it cannot close a targeted API socket first.
  server.removeAllListeners('upgrade');
  const dispatchListener: UpgradeListener = (request, socket, head) => {
    if (isTargetedUpgradeRequest(request)) {
      listener(request, socket, head);
      return;
    }

    for (const existingListener of existingListeners) {
      Reflect.apply(existingListener, server, [request, socket, head]);
    }
  };
  server.on('upgrade', dispatchListener);

  return { dispatchListener, existingListeners };
}

export function createWebSocketUpgradeListener(
  webSocketServer: WebSocketServer,
  dependencies: WebSocketUpgradeDependencies = {},
): UpgradeListener {
  const authorize = dependencies.authorize ?? authorizeWebSocketProject;
  const manager = dependencies.manager ?? websocketManager;

  return (request, socket, head) => {
    const parsed = parseRequestPath(
      request.url,
      firstHeader(request.headers['x-forwarded-host']) || firstHeader(request.headers.host),
    );
    if (!parsed.targeted) {
      return;
    }

    socket.on('error', () => undefined);
    if (!parsed.projectId) {
      writeUpgradeError(socket, 400, 'INVALID_REQUEST', 'Invalid WebSocket project path.');
      return;
    }
    if (!isAllowedWebSocketOrigin(request)) {
      writeUpgradeError(socket, 403, 'CAPABILITY_DENIED', 'WebSocket Origin is not allowed.');
      return;
    }

    void authorize(parsed.projectId, toWebHeaders(request))
      .then(() => {
        if (socket.destroyed || socket.writableEnded) {
          return;
        }
        webSocketServer.handleUpgrade(request, socket, head, (client) => {
          manager.addConnection(parsed.projectId!, client as ManagedSocket);
        });
      })
      .catch((error: unknown) => {
        const classified = classifyUpgradeError(error);
        writeUpgradeError(
          socket,
          classified.status,
          classified.code,
          classified.message,
        );
      });
  };
}

export function attachWebSocketUpgrade(
  server: Server,
  dependencies: WebSocketUpgradeDependencies = {},
): WebSocketUpgradeState {
  const serverWithState = server as ServerWithUpgradeState;
  const existing = serverWithState[UPGRADE_STATE];
  if (existing) {
    ensureHeartbeat();
    return existing;
  }

  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
  });
  const listener = createWebSocketUpgradeListener(webSocketServer, dependencies);
  const { dispatchListener, existingListeners } = installUpgradeDispatcher(server, listener);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    server.off('upgrade', dispatchListener);
    for (const existingListener of existingListeners) {
      server.on('upgrade', existingListener);
    }
    websocketManager.closeAllConnections();
    stopHeartbeat();
    try {
      webSocketServer.close();
    } catch {
      // The noServer WebSocketServer has no independent listener to close.
    }
  };

  const state: WebSocketUpgradeState = {
    listener,
    dispatchListener,
    webSocketServer,
    cleanup,
  };
  serverWithState[UPGRADE_STATE] = state;
  server.once('close', cleanup);
  ensureHeartbeat();
  return state;
}
