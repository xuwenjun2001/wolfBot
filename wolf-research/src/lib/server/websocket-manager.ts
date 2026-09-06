import { WebSocket as NodeWebSocket, type WebSocket } from 'ws';
import type { RealtimeEvent } from '@/types';

type ProjectId = string;

export interface ManagedSocket extends WebSocket {
  /**
   * Flag used for heartbeat to drop dead connections.
   */
  isAlive?: boolean;
}

const OPEN_STATE = NodeWebSocket.OPEN;

export class WebSocketManager {
  private connections = new Map<ProjectId, Set<ManagedSocket>>();

  public addConnection(projectId: ProjectId, socket: ManagedSocket): void {
    const projectConnections = this.connections.get(projectId) ?? new Set<ManagedSocket>();
    projectConnections.add(socket);
    this.connections.set(projectId, projectConnections);

    socket.isAlive = true;

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (data) => {
      socket.isAlive = true;
      if (data.toString() === 'ping') {
        this.safeSendText(socket, 'pong');
      }
    });

    socket.on('close', () => {
      this.removeConnection(projectId, socket);
    });

    socket.on('error', () => {
      this.removeConnection(projectId, socket);
    });

    // Send initial acknowledgement so clients know the connection succeeded.
    this.safeSend(socket, {
      type: 'connected',
      data: {
        projectId,
        timestamp: new Date().toISOString(),
        transport: 'websocket',
        connectionStage: 'handshake',
      },
    });
  }

  public removeConnection(projectId: ProjectId, socket: ManagedSocket): void {
    const projectConnections = this.connections.get(projectId);
    if (!projectConnections) {
      return;
    }

    projectConnections.delete(socket);

    if (projectConnections.size === 0) {
      this.connections.delete(projectId);
    }
  }

  public getConnectionCount(projectId: ProjectId): number {
    return this.connections.get(projectId)?.size ?? 0;
  }

  public closeAllConnections(code = 1001, reason = 'Server shutting down'): void {
    for (const [projectId, sockets] of this.connections.entries()) {
      for (const socket of sockets) {
        try {
          socket.close(code, reason);
        } catch {
          socket.terminate();
        }
        this.removeConnection(projectId, socket);
      }
    }
  }

  public broadcast(projectId: ProjectId, data: RealtimeEvent | string): void {
    const projectConnections = this.connections.get(projectId);
    if (!projectConnections || projectConnections.size === 0) {
      return;
    }

    const payload = typeof data === 'string' ? data : JSON.stringify(data);

    for (const socket of [...projectConnections]) {
      if (socket.readyState !== OPEN_STATE) {
        projectConnections.delete(socket);
        continue;
      }

      try {
        socket.send(payload);
      } catch (error) {
        console.error('[WebSocketManager] Failed to send:', error);
        projectConnections.delete(socket);
      }
    }

    if (projectConnections.size === 0) {
      this.connections.delete(projectId);
    }
  }

  /**
   * Iterate through all active sockets and terminate dead connections.
   */
  public pruneDeadConnections(): void {
    for (const [projectId, sockets] of this.connections.entries()) {
      for (const socket of sockets) {
        if (socket.isAlive === false) {
          socket.terminate();
          sockets.delete(socket);
          continue;
        }

        socket.isAlive = false;
        socket.ping();
      }

      if (sockets.size === 0) {
        this.connections.delete(projectId);
      }
    }
  }

  private safeSend(socket: ManagedSocket, data: RealtimeEvent): void {
    if (socket.readyState !== OPEN_STATE) {
      return;
    }
    try {
      socket.send(JSON.stringify(data));
    } catch {
      // Ignore send failures; cleanup happens via close/error.
    }
  }

  private safeSendText(socket: ManagedSocket, data: string): void {
    if (socket.readyState !== OPEN_STATE) {
      return;
    }
    try {
      socket.send(data);
    } catch {
      socket.terminate();
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __claudable_ws_manager__: WebSocketManager | undefined;
  // eslint-disable-next-line no-var
  var __claudable_ws_heartbeat__: NodeJS.Timeout | undefined;
}

export const websocketManager: WebSocketManager =
  globalThis.__claudable_ws_manager__ ?? (globalThis.__claudable_ws_manager__ = new WebSocketManager());

export function ensureHeartbeat(): void {
  if (globalThis.__claudable_ws_heartbeat__) {
    return;
  }

  globalThis.__claudable_ws_heartbeat__ = setInterval(() => {
    websocketManager.pruneDeadConnections();
  }, 30_000);
  globalThis.__claudable_ws_heartbeat__.unref?.();
}

export function stopHeartbeat(): void {
  const heartbeat = globalThis.__claudable_ws_heartbeat__;
  if (!heartbeat) {
    return;
  }
  clearInterval(heartbeat);
  globalThis.__claudable_ws_heartbeat__ = undefined;
}
