import type { OperationContext } from './context';

export interface PreviewInfo {
  status: 'running';
  url: string;
  port: number;
  runtimeId: string;
  ownerInstanceId: string;
  startedAt: string;
  sandboxMode: 'windows-unsandboxed';
}

export interface PreviewRuntimePort {
  start(input: unknown, ctx: OperationContext): Promise<PreviewInfo>;
  stop(projectId: string, ctx: OperationContext): Promise<unknown>;
  status(projectId: string, ctx: OperationContext): Promise<unknown>;
  reconcile(projectId: string, ctx: OperationContext): Promise<unknown>;
}
