import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  getProjectById: vi.fn(),
  installDependencies: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/services/project', () => ({ getProjectById: mocks.getProjectById }));
vi.mock('@/lib/services/preview', () => ({
  previewManager: { installDependencies: mocks.installDependencies },
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import { POST } from './route';

const context = { params: Promise.resolve({ project_id: 'project-1' }) };

describe('POST /api/projects/[project_id]/install-dependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({
      actorUserId: 'wolf-research-local-system',
    });
    mocks.getProjectById.mockResolvedValue({ id: 'project-1' });
    mocks.installDependencies.mockResolvedValue({ logs: ['installed'] });
  });

  it('authorizes the project source write and returns install logs', async () => {
    const response = await POST(
      new Request('http://localhost/api/projects/project-1/install-dependencies', {
        method: 'POST',
      }),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { logs: ['installed'] },
    });
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'project.source.write',
      projectId: 'project-1',
    });
    expect(mocks.installDependencies).toHaveBeenCalledWith('project-1');
  });

  it('returns the existing authorization error without starting an install', async () => {
    mocks.requireAction.mockRejectedValue(
      new AuthorizationError('CAPABILITY_DENIED', 403, 'Denied'),
    );

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/install-dependencies', {
        method: 'POST',
      }),
      context,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'CAPABILITY_DENIED',
    });
    expect(mocks.installDependencies).not.toHaveBeenCalled();
  });

  it('returns PROJECT_NOT_FOUND and does not invoke the process manager', async () => {
    mocks.getProjectById.mockResolvedValue(null);

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/install-dependencies', {
        method: 'POST',
      }),
      context,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'PROJECT_NOT_FOUND',
    });
    expect(mocks.installDependencies).not.toHaveBeenCalled();
  });

  it('maps an install failure to a stable non-sensitive error', async () => {
    mocks.installDependencies.mockRejectedValue(
      new Error('npm install /secret/path exited with code 1'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/install-dependencies', {
        method: 'POST',
      }),
      context,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'PREVIEW_INSTALL_FAILED',
      message: 'Project dependency installation failed.',
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
