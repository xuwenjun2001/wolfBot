import { afterEach, describe, expect, it } from 'vitest';

import { requireAction } from './action';

describe('requireAction', () => {
  const originalAuthMode = process.env.WOLF_RESEARCH_AUTH_MODE;

  afterEach(() => {
    if (originalAuthMode === undefined) delete process.env.WOLF_RESEARCH_AUTH_MODE;
    else process.env.WOLF_RESEARCH_AUTH_MODE = originalAuthMode;
  });

  it('allows collection-level project reads for the research workbench', async () => {
    process.env.WOLF_RESEARCH_AUTH_MODE = 'disabled';

    await expect(requireAction({
      headers: new Headers(),
      action: 'project.read',
    })).resolves.toMatchObject({
      authMode: 'disabled',
      projectRole: null,
      localSystemAdmin: true,
    });
  });

  it('keeps resource-scoped project actions bound to a project', async () => {
    process.env.WOLF_RESEARCH_AUTH_MODE = 'disabled';

    await expect(requireAction({
      headers: new Headers(),
      action: 'project.update',
    })).rejects.toMatchObject({
      code: 'PROJECT_CONTEXT_REQUIRED',
      status: 403,
    });
  });
});
