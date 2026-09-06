export type PermissionAction = string;

export interface PermissionDecision {
  allowed: boolean;
  action: PermissionAction;
  reason: 'local-system-disabled-auth';
}

export interface ResolvedPermissionPolicy {
  profile: null;
  userOverrides: never[];
  membershipOverrides: never[];
}

export interface PermissionPolicyRepository {
  resolvePolicy(input: { userId: string; projectId?: string }): Promise<ResolvedPermissionPolicy>;
}
