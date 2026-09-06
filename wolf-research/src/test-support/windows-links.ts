import fs from 'node:fs/promises';

/** Creates a directory link without requiring Windows developer mode. */
export async function createTestDirectoryLink(
  target: string,
  linkPath: string,
): Promise<void> {
  await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}
