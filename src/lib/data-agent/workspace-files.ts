import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ATOMIC_RENAME_RETRY_ATTEMPTS = 8;
const ATOMIC_RENAME_INITIAL_RETRY_DELAY_MS = 25;
const RETRYABLE_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function isRetryableRenameError(error: unknown): boolean {
  return RETRYABLE_RENAME_ERROR_CODES.has(
    (error as NodeJS.ErrnoException | undefined)?.code ?? '',
  );
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  let delayMs = ATOMIC_RENAME_INITIAL_RETRY_DELAY_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !isRetryableRenameError(error) ||
        attempt >= ATOMIC_RENAME_RETRY_ATTEMPTS
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 250);
    }
  }
}

function safeRelativePath(relativePath: string): string {
  const normalized = relativePath.trim().replaceAll('\\', '/');
  if (
    !normalized
    || normalized.startsWith('/')
    || normalized.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('Workspace artifact path must be a safe relative path.');
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function ensureSafeParent(
  absoluteRoot: string,
  parent: string,
  safePath: string,
): Promise<string> {
  const rootStat = await fs.lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Workspace root must be a real directory.');
  }
  const realRoot = await fs.realpath(absoluteRoot);
  const relativeParent = path.relative(absoluteRoot, parent);
  let current = absoluteRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Workspace artifact path escapes through a symbolic link: ${safePath}`);
    }
    const realCurrent = await fs.realpath(current);
    if (!isWithin(realRoot, realCurrent)) {
      throw new Error(`Workspace artifact path escapes through a symbolic link: ${safePath}`);
    }
  }
  return realRoot;
}

/**
 * Same-directory temp + rename prevents readers from observing partial JSON
 * and rejects nested symlink escapes before the write is committed.
 */
export async function writeWorkspaceFileAtomic(
  workspaceRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const safePath = safeRelativePath(relativePath);
  const absoluteRoot = path.resolve(workspaceRoot);
  const target = path.join(absoluteRoot, safePath);
  const parent = path.dirname(target);
  const realRoot = await ensureSafeParent(absoluteRoot, parent, safePath);
  const realParent = await fs.realpath(parent);
  if (!isWithin(realRoot, realParent)) {
    throw new Error(`Workspace artifact path escapes through a symbolic link: ${safePath}`);
  }
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await renameWithRetry(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function writeWorkspaceJsonAtomic(
  workspaceRoot: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  await writeWorkspaceFileAtomic(
    workspaceRoot,
    relativePath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
