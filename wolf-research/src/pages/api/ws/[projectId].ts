import type { NextApiRequest, NextApiResponse } from 'next';
import type { Server } from 'node:http';

import { AuthorizationError } from '@/lib/auth/authorization';
import {
  attachWebSocketUpgrade,
  authorizeWebSocketProject,
  toWebHeaders,
  WebSocketUpgradeError,
} from '@/lib/server/websocket-upgrade';

type WarmupResponse = {
  success: boolean;
  data?: {
    projectId: string;
    transport: 'websocket';
    upgradeReady: true;
  };
  error?: string;
  message?: string;
};

function projectIdFromQuery(request: NextApiRequest): string | null {
  const value = request.query.projectId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse<WarmupResponse>,
): Promise<void> {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.status(405).json({
      success: false,
      error: 'METHOD_NOT_ALLOWED',
      message: 'Only GET is supported for WebSocket warm-up.',
    });
    return;
  }

  const projectId = projectIdFromQuery(request);
  if (!projectId) {
    response.status(400).json({
      success: false,
      error: 'INVALID_REQUEST',
      message: 'A project ID is required for WebSocket warm-up.',
    });
    return;
  }

  try {
    const server = (request.socket as typeof request.socket & { server?: Server }).server;
    if (!server) {
      throw new Error('The HTTP server is unavailable for WebSocket upgrade.');
    }
    attachWebSocketUpgrade(server);
    await authorizeWebSocketProject(projectId, toWebHeaders(request));
    response.status(200).json({
      success: true,
      data: {
        projectId,
        transport: 'websocket',
        upgradeReady: true,
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof WebSocketUpgradeError) {
      response.status(error.status).json({
        success: false,
        error: error.code,
        message: error.message,
      });
      return;
    }

    console.error('[API] Failed to prepare WebSocket upgrade:', error);
    response.status(500).json({
      success: false,
      error: 'WEBSOCKET_UPGRADE_UNAVAILABLE',
      message: 'WebSocket upgrade is unavailable.',
    });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};
