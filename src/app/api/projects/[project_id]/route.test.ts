import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  deleteProject: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/services/project', () => ({
  getProjectById: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: mocks.deleteProject,
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import { readProjectDeletionError } from '@/lib/services/project-deletion-response';
import { DELETE } from './route';

function deleteRequest() {
  return DELETE(
    new NextRequest('http://localhost/api/projects/project-delete', { method: 'DELETE' }),
    { params: Promise.resolve({ project_id: 'project-delete' }) },
  );
}

describe('DELETE /api/projects/[project_id]', () => {
  beforeEach(() => {
    mocks.requireAction.mockReset().mockResolvedValue({ session: { user: { id: 'owner-1' } } });
    mocks.deleteProject.mockReset().mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('authorizes project.delete and passes the deleting user to the transaction', async () => {
    const response = await deleteRequest();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers), action: 'project.delete', projectId: 'project-delete',
    });
    expect(mocks.deleteProject).toHaveBeenCalledWith('project-delete', { deletedByUserId: 'owner-1' });
    expect(mocks.requireAction.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deleteProject.mock.invocationCallOrder[0]);
  });

  it('returns a readable missing-project error for a repeated deletion', async () => {
    mocks.deleteProject.mockResolvedValue(false);
    const response = await deleteRequest();

    expect(response.status).toBe(404);
    await expect(readProjectDeletionError(response)).resolves.toBe('任务不存在或已被删除。');
  });

  it('does not delete anything after authorization fails, and displays the reason', async () => {
    mocks.requireAction.mockRejectedValue(new AuthorizationError('CAPABILITY_DENIED', 403, '无权删除此任务。'));
    const response = await deleteRequest();

    expect(response.status).toBe(403);
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    await expect(readProjectDeletionError(response)).resolves.toBe('无权删除此任务。');
  });

  it('propagates the service failure through the frontend error reader', async () => {
    mocks.deleteProject.mockRejectedValue(new Error('Project workspace is unavailable.'));
    const response = await deleteRequest();

    expect(response.status).toBe(500);
    await expect(readProjectDeletionError(response)).resolves.toBe('Project workspace is unavailable.');
  });

  it('supports local mode without a signed-in user', async () => {
    mocks.requireAction.mockResolvedValue({ session: null });

    expect((await deleteRequest()).status).toBe(200);
    expect(mocks.deleteProject).toHaveBeenCalledWith('project-delete', { deletedByUserId: null });
  });
});
