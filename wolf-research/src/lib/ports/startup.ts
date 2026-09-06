import type { OperationContext } from './context';

export interface StartupIssue {
  code: string;
  variable?: string;
  message: string;
}

export interface StartupReport {
  ok: boolean;
  authMode: 'disabled';
  quotaMode: 'disabled';
  memoryMode: 'disabled';
  knowledgeMode: 'disabled';
  previewEnabled: boolean;
  loopbackMutationsEnabled: boolean;
  sandboxMode: 'windows-unsandboxed';
  issues: StartupIssue[];
}

export interface StartupCoordinator {
  preflight(ctx: OperationContext): Promise<StartupReport>;
  migrateDatabase(ctx: OperationContext): Promise<unknown>;
  startManagedServices(ctx: OperationContext): Promise<StartupReport>;
  shutdown(ctx: OperationContext): Promise<unknown>;
}
