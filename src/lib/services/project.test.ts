import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectCreate: vi.fn(),
  projectUpdate: vi.fn(),
  projectDelete: vi.fn(),
  projectFindUnique: vi.fn(),
  provisionProject: vi.fn(),
  deleteProjectWithOwnedQuota: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    project: {
      create: mocks.projectCreate,
      update: mocks.projectUpdate,
      delete: mocks.projectDelete,
      findUnique: mocks.projectFindUnique,
    },
  },
}));

vi.mock('@/lib/quant/data-agent-application', () => ({
  getApplicationDataAgentCatalog: () => ({
    resolve: () => ({
      profile: { id: 'test.profile', version: '1.0.0' },
      capability: { id: 'test.overview' },
      composition: { sha256: `sha256:${'a'.repeat(64)}` },
      adapter: { provisionProject: mocks.provisionProject },
    }),
  }),
}));

vi.mock('@/lib/quota/allocation-reconciliation', () => ({
  deleteProjectWithOwnedQuota: mocks.deleteProjectWithOwnedQuota,
}));

import { createProject, deleteProject } from './project';

const roots: string[] = [];

function row(id: string, root: string, status: string) {
  const now = new Date('2026-07-23T00:00:00.000Z');
  return {
    id,
    ownerId: null,
    name: 'Test',
    description: null,
    status,
    previewUrl: null,
    previewPort: null,
    repoPath: path.join(root, id),
    initialPrompt: '',
    templateType: 'nextjs',
    preferredCli: 'pi',
    selectedModel: 'local_qwen:qwen3.5-9b-q5km',
    agentProfileId: 'test.profile',
    agentProfileVersion: '1.0.0',
    dataAgentCompositionSha256: `sha256:${'a'.repeat(64)}`,
    settings: '{}',
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.projectFindUnique.mockReset();
  mocks.deleteProjectWithOwnedQuota.mockReset();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-service-'));
  roots.push(root);
  process.env.PROJECTS_DIR = root;
  mocks.projectCreate.mockImplementation(async ({ data }: { data: { id: string } }) => (
    row(data.id, root, 'initializing')
  ));
  mocks.projectUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => (
    row(where.id, root, 'idle')
  ));
  mocks.projectDelete.mockResolvedValue({});
  mocks.provisionProject.mockImplementation(async (
    input: { projectPath: string },
  ) => {
    await fs.writeFile(path.join(input.projectPath, 'ready.txt'), 'ready\n', 'utf8');
    return { settings: { dataAgent: { capabilityId: 'test.overview' } } };
  });
});

afterEach(async () => {
  delete process.env.PROJECTS_DIR;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('Project service workspace transaction', () => {
  it('publishes a provisioned workspace only after the initializing row exists', async () => {
    const project = await createProject({
      project_id: 'project-atomic',
      name: 'Atomic',
      initialPrompt: '',
      agentProfileId: 'test.profile',
      capabilityId: 'test.overview',
    });

    expect(project.status).toBe('idle');
    expect(project.preferredCli).toBe('pi');
    expect(mocks.projectCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'initializing',
        preferredCli: 'pi',
      }),
    }));
    expect(mocks.provisionProject).toHaveBeenCalledWith(
      expect.objectContaining({ preferredCli: 'pi' }),
      expect.anything(),
    );
    expect(mocks.projectUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'idle' }),
    }));
    await expect(fs.readFile(
      path.join(process.env.PROJECTS_DIR!, 'project-atomic', 'ready.txt'),
      'utf8',
    )).resolves.toBe('ready\n');
  });

  it('does not overwrite a pre-existing workspace', async () => {
    const target = path.join(process.env.PROJECTS_DIR!, 'project-conflict');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'owned.txt'), 'keep\n', 'utf8');

    await expect(createProject({
      project_id: 'project-conflict',
      name: 'Conflict',
      initialPrompt: '',
      agentProfileId: 'test.profile',
    })).rejects.toThrow('already exists');
    expect(mocks.projectCreate).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(target, 'owned.txt'), 'utf8'))
      .resolves.toBe('keep\n');
  });

  it('rolls back the row and staging directory when provisioning fails', async () => {
    mocks.provisionProject.mockRejectedValueOnce(new Error('provision failed'));
    await expect(createProject({
      project_id: 'project-failed',
      name: 'Failed',
      initialPrompt: '',
      agentProfileId: 'test.profile',
    })).rejects.toThrow('provision failed');
    expect(mocks.projectDelete).toHaveBeenCalledWith({
      where: { id: 'project-failed' },
    });
    await expect(fs.access(path.join(process.env.PROJECTS_DIR!, 'project-failed')))
      .rejects.toThrow();
    expect((await fs.readdir(process.env.PROJECTS_DIR!)))
      .not.toEqual(expect.arrayContaining([expect.stringContaining('project-failed')]));
  });

  it('rejects an out-of-root repoPath before deleting database state', async () => {
    mocks.projectFindUnique.mockResolvedValue({ repoPath: '/tmp/not-the-project' });
    await expect(deleteProject('project-delete')).rejects.toThrow(
      'outside its canonical managed workspace',
    );
    expect(mocks.deleteProjectWithOwnedQuota).not.toHaveBeenCalled();
  });

  it('deletes the workspace only after the database deletion commits', async () => {
    const target = path.join(process.env.PROJECTS_DIR!, 'project-delete');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep-until-commit.txt'), 'keep');
    mocks.projectFindUnique.mockResolvedValue({ repoPath: target });
    mocks.deleteProjectWithOwnedQuota.mockImplementation(async () => {
      await expect(fs.readFile(path.join(target, 'keep-until-commit.txt'), 'utf8'))
        .resolves.toBe('keep');
      return { id: 'project-delete', repoPath: target };
    });

    await expect(deleteProject('project-delete', { deletedByUserId: 'owner-1' }))
      .resolves.toBe(true);
    expect(mocks.deleteProjectWithOwnedQuota).toHaveBeenCalledWith(
      expect.anything(), 'project-delete', { deletedByUserId: 'owner-1' },
    );
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the workspace when the database transaction fails', async () => {
    const target = path.join(process.env.PROJECTS_DIR!, 'project-delete');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep.txt'), 'keep');
    mocks.projectFindUnique.mockResolvedValue({ repoPath: target });
    mocks.deleteProjectWithOwnedQuota.mockRejectedValueOnce(new Error('database rejected deletion'));

    await expect(deleteProject('project-delete')).rejects.toThrow('database rejected deletion');
    await expect(fs.readFile(path.join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('can delete a database record whose canonical workspace is already missing', async () => {
    const target = path.join(process.env.PROJECTS_DIR!, 'project-missing-workspace');
    mocks.projectFindUnique.mockResolvedValue({ repoPath: target });
    mocks.deleteProjectWithOwnedQuota.mockResolvedValue({ id: 'project-missing-workspace' });

    await expect(deleteProject('project-missing-workspace')).resolves.toBe(true);
    expect(mocks.deleteProjectWithOwnedQuota).toHaveBeenCalledOnce();
  });

  it('does not remove files if another request already deleted the database record', async () => {
    const target = path.join(process.env.PROJECTS_DIR!, 'project-delete');
    await fs.mkdir(target);
    mocks.projectFindUnique.mockResolvedValue({ repoPath: target });
    mocks.deleteProjectWithOwnedQuota.mockResolvedValue(null);

    await expect(deleteProject('project-delete')).resolves.toBe(false);
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });

  it('rejects a sibling workspace even when it is inside the managed root', async () => {
    const sibling = path.join(process.env.PROJECTS_DIR!, 'project-sibling');
    await fs.mkdir(sibling);
    mocks.projectFindUnique.mockResolvedValue({ repoPath: sibling });

    await expect(deleteProject('project-delete')).rejects.toThrow('outside its canonical managed workspace');
    expect(mocks.deleteProjectWithOwnedQuota).not.toHaveBeenCalled();
    expect((await fs.lstat(sibling)).isDirectory()).toBe(true);
  });

  it('rejects a junction or symlink workspace before deleting database state', async () => {
    const root = process.env.PROJECTS_DIR!;
    const sibling = path.join(root, 'project-sibling');
    const target = path.join(root, 'project-delete');
    await fs.mkdir(sibling);
    await fs.symlink(sibling, target, process.platform === 'win32' ? 'junction' : 'dir');
    mocks.projectFindUnique.mockResolvedValue({ repoPath: target });

    await expect(deleteProject('project-delete')).rejects.toThrow('must be a real directory');
    expect(mocks.deleteProjectWithOwnedQuota).not.toHaveBeenCalled();
    expect((await fs.lstat(sibling)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('accepts a Windows repoPath differing only in casing and separators', async () => {
    const target = path.join(process.env.PROJECTS_DIR!, 'project-delete');
    await fs.mkdir(target);
    mocks.projectFindUnique.mockResolvedValue({ repoPath: target.toUpperCase().replaceAll('\\', '/') });
    mocks.deleteProjectWithOwnedQuota.mockResolvedValue({ id: 'project-delete', repoPath: target });

    await expect(deleteProject('project-delete')).resolves.toBe(true);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
