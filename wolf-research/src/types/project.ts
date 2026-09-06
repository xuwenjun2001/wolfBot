import type { CLIType } from './cli';

export type ProjectStatus =
  | 'idle'
  | 'preview_running'
  | 'building'
  | 'initializing'
  | 'active'
  | 'failed'
  | 'running'
  | 'stopped'
  | 'error';

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  previewUrl?: string | null;
  previewPort?: number | null;
  createdAt: string;
  updatedAt?: string;
  lastActiveAt?: string | null;
  lastMessageAt?: string | null;
  initialPrompt?: string | null;
  preferredCli?: CLIType | null;
  selectedModel?: string | null;
  agentProfileId: string;
  agentProfileVersion: string;
  dataAgentCompositionSha256: string;
  capabilityId?: string | null;
}

export interface ProjectSettings {
  preferredCli: CLIType;
  selectedModel?: string | null;
  capabilityId?: string | null;
}
