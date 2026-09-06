import { createHash } from 'node:crypto';

const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Environment = Readonly<Record<string, string | undefined>>;

export interface ProjectIntegrationScope {
  schemaVersion: 1;
  consumerId: 'wolf-research';
  projectId: string;
  modelPort: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  };
  memory: {
    enabled: false;
    tenantId: 'disabled';
    context: { product: 'wolf-research'; project_id: string };
  };
  knowledge: {
    enabled: false;
    sharedSpaceIds: [];
    projectSpaceId: null;
    requestedSpaceIds: [];
  };
  scopeSha256: string;
}

function scopeId(value: string | undefined, fallback: string, label: string): string {
  const normalized = value?.trim() || fallback;
  if (!SCOPE_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must contain 1-128 safe scope characters.`);
  }
  return normalized;
}

export function getProjectIntegrationScope(
  projectId: string,
  environment: Environment = process.env,
): ProjectIntegrationScope {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId || normalizedProjectId.length > 160) {
    throw new Error('Project integration scope project ID is invalid.');
  }
  const unsigned = {
    schemaVersion: 1 as const,
    consumerId: 'wolf-research' as const,
    projectId: normalizedProjectId,
    modelPort: {
      organizationId: scopeId(
        environment.WOLF_RESEARCH_MODEL_ORGANIZATION_ID,
        'org_local',
        'WOLF_RESEARCH_MODEL_ORGANIZATION_ID',
      ),
      projectId: scopeId(
        environment.WOLF_RESEARCH_MODEL_PROJECT_ID,
        'prj_wolf_research',
        'WOLF_RESEARCH_MODEL_PROJECT_ID',
      ),
      environmentId: scopeId(
        environment.WOLF_RESEARCH_MODEL_ENVIRONMENT_ID,
        environment.NODE_ENV === 'production' ? 'env_production' : 'env_development',
        'WOLF_RESEARCH_MODEL_ENVIRONMENT_ID',
      ),
    },
    memory: {
      enabled: false as const,
      tenantId: 'disabled' as const,
      context: { product: 'wolf-research' as const, project_id: normalizedProjectId },
    },
    knowledge: {
      enabled: false as const,
      sharedSpaceIds: [] as [],
      projectSpaceId: null,
      requestedSpaceIds: [] as [],
    },
  };
  return {
    ...unsigned,
    scopeSha256: `sha256:${createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')}`,
  };
}

export function modelPortScopeHeaders(
  scope: Pick<ProjectIntegrationScope, 'modelPort'>,
): Readonly<Record<string, string>> {
  return {
    'X-ModelPort-Organization-Id': scope.modelPort.organizationId,
    'X-ModelPort-Project-Id': scope.modelPort.projectId,
    'X-ModelPort-Environment-Id': scope.modelPort.environmentId,
  };
}
