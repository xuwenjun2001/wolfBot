import type {
  PermissionAction,
  PermissionDecision,
  PermissionPolicyRepository,
  ResolvedPermissionPolicy,
} from './permissions';
import { AuthorizationError } from './authorization';

const LOCAL_SYSTEM_ACTOR_ID = 'wolf-research-local-system' as const;

export class PrismaPermissionPolicyRepository implements PermissionPolicyRepository {
  async resolvePolicy(): Promise<ResolvedPermissionPolicy> {
    return { profile: null, userOverrides: [], membershipOverrides: [] };
  }
}

export interface RequireActionInput {
  headers: Headers;
  action: PermissionAction;
  projectId?: string;
}

export interface RequiredActionContext {
  actorUserId: typeof LOCAL_SYSTEM_ACTOR_ID;
  session: null;
  projectRole: 'owner' | null;
  decision: PermissionDecision;
  localSystemAdmin: true;
  authMode: 'disabled';
  quotaMode: 'disabled';
}

export async function requireAction(input: RequireActionInput): Promise<RequiredActionContext> {
  if (process.env.WOLF_RESEARCH_AUTH_MODE !== 'disabled') {
    throw new Error('WOLF_RESEARCH_AUTH_MODE must be disabled in this release.');
  }
  const collectionProjectAction = input.action === 'project.create' || input.action === 'project.read';
  if (input.action.startsWith('project.') && !input.projectId && !collectionProjectAction) {
    throw new AuthorizationError(
      'PROJECT_CONTEXT_REQUIRED',
      403,
      `Project context is required for action ${input.action}.`,
    );
  }
  return {
    actorUserId: LOCAL_SYSTEM_ACTOR_ID,
    session: null,
    projectRole: input.projectId ? 'owner' : null,
    decision: { allowed: true, action: input.action, reason: 'local-system-disabled-auth' },
    localSystemAdmin: true,
    authMode: 'disabled',
    quotaMode: 'disabled',
  };
}
