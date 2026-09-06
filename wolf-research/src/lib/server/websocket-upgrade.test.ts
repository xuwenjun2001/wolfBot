import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthorizationError } from '@/lib/auth/authorization';
import {
  attachWebSocketUpgrade,
  createWebSocketUpgradeListener,
  isAllowedWebSocketOrigin,
  WebSocketUpgradeError,
} from './websocket-upgrade';
import { WebSocketManager } from './websocket-manager';

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function nextMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, 2_000);
    const onMessage = (data: WebSocket.RawData) => {
      clearTimeout(timer);
      client.off('message', onMessage);
      resolve(data.toString());
    };
    client.once('error', reject);
    client.on('message', onMessage);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nextUpgradeError(client: WebSocket): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('error', onError);
      reject(new Error('Timed out waiting for WebSocket upgrade error'));
    }, 2_000);
    const onError = (error: Error) => {
      clearTimeout(timer);
      resolve(error);
    };
    client.once('open', () => {
      clearTimeout(timer);
      client.off('error', onError);
      reject(new Error('WebSocket upgrade unexpectedly succeeded'));
    });
    client.once('error', onError);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe('WebSocket upgrade boundary', () => {
  it('requires a same-origin Origin and honors forwarded browser authority', () => {
    type TestRequest = {
      headers: Record<string, string>;
      socket: { encrypted: boolean };
    };
    const baseRequest: TestRequest = {
      headers: {
        host: '127.0.0.1:3010',
        origin: 'http://127.0.0.1:3010',
      },
      socket: { encrypted: false },
    };

    expect(isAllowedWebSocketOrigin(baseRequest as unknown as IncomingMessage)).toBe(true);
    expect(isAllowedWebSocketOrigin({
      ...baseRequest,
      headers: { ...baseRequest.headers, origin: 'http://evil.example' },
    } as unknown as IncomingMessage)).toBe(false);
    expect(isAllowedWebSocketOrigin({
      ...baseRequest,
      headers: { host: '127.0.0.1:3010' },
    } as unknown as IncomingMessage)).toBe(false);
    expect(isAllowedWebSocketOrigin({
      ...baseRequest,
      headers: {
        host: 'internal:3010',
        origin: 'https://research.example',
        'x-forwarded-host': 'research.example',
        'x-forwarded-proto': 'https',
      },
      socket: { encrypted: false },
    } as unknown as IncomingMessage)).toBe(true);
  });

  it('performs a real HTTP upgrade and cleans the managed socket on close', async () => {
    const httpServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const webSocketServer = new WebSocketServer({ noServer: true, clientTracking: false });
    const manager = new WebSocketManager();
    const authorize = vi.fn(async () => undefined);
    httpServer.on(
      'upgrade',
      createWebSocketUpgradeListener(webSocketServer, { authorize, manager }),
    );

    const port = await listen(httpServer);
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/ws/project-1`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    const connectedMessage = nextMessage(client);

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    expect(JSON.parse(await connectedMessage)).toMatchObject({
      type: 'connected',
      data: { projectId: 'project-1', transport: 'websocket' },
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(manager.getConnectionCount('project-1')).toBe(1);

    const pongMessage = nextMessage(client);
    client.send('ping');
    await expect(pongMessage).resolves.toBe('pong');

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.close();
    await closed;
    await vi.waitFor(() => expect(manager.getConnectionCount('project-1')).toBe(0));
    webSocketServer.close();
  });

  it('claims a targeted upgrade before a pre-existing listener can close it', async () => {
    const httpServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const webSocketServer = new WebSocketServer({ noServer: true, clientTracking: false });
    const manager = new WebSocketManager();
    const competingUpgrade = vi.fn((_request: IncomingMessage, socket: { destroy: () => void }) => {
      socket.destroy();
    });
    httpServer.on('upgrade', competingUpgrade);
    const authorize = vi.fn(async () => {
      await delay(30);
    });
    attachWebSocketUpgrade(httpServer, { authorize, manager });

    const port = await listen(httpServer);
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/ws/project-2`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    const connectedMessage = nextMessage(client);

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    expect(JSON.parse(await connectedMessage)).toMatchObject({
      type: 'connected',
      data: { projectId: 'project-2', transport: 'websocket' },
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(competingUpgrade).not.toHaveBeenCalled();

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.close();
    await closed;
    await vi.waitFor(() => expect(manager.getConnectionCount('project-2')).toBe(0));
    webSocketServer.close();
  });

  it('returns a delayed authorization rejection as an HTTP 403 response', async () => {
    const httpServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const webSocketServer = new WebSocketServer({ noServer: true, clientTracking: false });
    const authorize = vi.fn(async () => {
      await delay(30);
      throw new AuthorizationError('CAPABILITY_DENIED', 403, 'WebSocket access denied.');
    });
    httpServer.on(
      'upgrade',
      createWebSocketUpgradeListener(webSocketServer, { authorize }),
    );

    const port = await listen(httpServer);
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/ws/denied-project`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    const error = await nextUpgradeError(client);

    expect(error.message).toContain('Unexpected server response: 403');
    expect(authorize).toHaveBeenCalledOnce();
    client.terminate();
    webSocketServer.close();
  });

  it('returns a missing project as an HTTP 404 response after async authorization', async () => {
    const httpServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const webSocketServer = new WebSocketServer({ noServer: true, clientTracking: false });
    const authorize = vi.fn(async () => {
      await delay(30);
      throw new WebSocketUpgradeError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    });
    httpServer.on(
      'upgrade',
      createWebSocketUpgradeListener(webSocketServer, { authorize }),
    );

    const port = await listen(httpServer);
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/ws/missing-project`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    const error = await nextUpgradeError(client);

    expect(error.message).toContain('Unexpected server response: 404');
    expect(authorize).toHaveBeenCalledOnce();
    client.terminate();
    webSocketServer.close();
  });

  it('rejects a targeted upgrade before authorization when Origin is invalid', async () => {
    const webSocketServer = new WebSocketServer({ noServer: true, clientTracking: false });
    const authorize = vi.fn(async () => undefined);
    const listener = createWebSocketUpgradeListener(webSocketServer, { authorize });
    const writes: Array<Buffer | string> = [];
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: (value: Buffer | string) => {
        writes.push(value);
        return true;
      },
      end: (value?: Buffer | string) => {
        if (value !== undefined) {
          writes.push(value);
        }
        return true;
      },
      destroy: () => undefined,
    });

    listener(
      {
        url: '/api/ws/project-1',
        headers: { host: '127.0.0.1:3010' },
        socket: { encrypted: false },
      } as never,
      socket as never,
      Buffer.alloc(0),
    );
    await Promise.resolve();

    expect(authorize).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('HTTP/1.1 403 Forbidden');
    expect(writes.join('')).toContain('"CAPABILITY_DENIED"');
    webSocketServer.close();
  });
});
