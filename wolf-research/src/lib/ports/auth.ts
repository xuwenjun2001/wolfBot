import type { OperationContext } from './context';

export interface AuthSession {
  actorId: string;
  mode: 'disabled';
}

export interface AuthPort {
  getSession(headers: Headers, ctx: OperationContext): Promise<AuthSession>;
}

export interface AuthorizedActor {
  actorId: string;
  authMode: 'disabled';
  quotaMode: 'disabled';
}

export interface AuthorizationPort {
  requireAction(
    input: { action: string; projectId?: string },
    ctx: OperationContext,
  ): Promise<AuthorizedActor>;
}
