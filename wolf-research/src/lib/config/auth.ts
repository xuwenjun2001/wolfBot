export interface ProjectAuthConfig {
  enabled: false;
  mode: 'disabled';
}

export function getProjectAuthConfig(): ProjectAuthConfig {
  if (process.env.WOLF_RESEARCH_AUTH_MODE !== 'disabled') {
    throw new Error('WOLF_RESEARCH_AUTH_MODE must be disabled in this release.');
  }
  return { enabled: false, mode: 'disabled' };
}
