import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { artifactReferenceSchema } from './document-contracts';
import { sha256Schema } from './task-contracts';

export const artifactDigest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Actor-scoped content addressing. A digest is never an authorization token. */
export class ResearchArtifactStore {
  private readonly root: string;
  constructor(root = path.join(process.cwd(), 'data', 'company-research', 'artifacts')) { this.root = path.resolve(root); }
  private async directory(actor: string) {
    if (!actor.trim()) throw new Error('RESEARCH_ACTOR_REQUIRED');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!same(await realpath(this.root), this.root)) throw new Error('RESEARCH_ARTIFACT_SYMLINK');
    const scoped = path.join(this.root, artifactDigest(actor));
    await mkdir(scoped, { recursive: true, mode: 0o700 });
    if ((await lstat(scoped)).isSymbolicLink() || !same(await realpath(scoped), scoped)) throw new Error('RESEARCH_ARTIFACT_SYMLINK');
    return scoped;
  }
  async read(actor: string, reference: unknown) {
    const ref = artifactReferenceSchema.parse(reference);
    const target = path.join(await this.directory(actor), sha256Schema.parse(ref.key));
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.byteLength) throw new Error('RESEARCH_ARTIFACT_INTEGRITY');
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const bytes = await file.readFile();
      if (artifactDigest(bytes) !== ref.sha256) throw new Error('RESEARCH_ARTIFACT_INTEGRITY');
      return bytes;
    } finally { await file.close(); }
  }
  async put(actor: string, bytes: Buffer) {
    if (!bytes.length || bytes.length > 50_000_000) throw new Error('RESEARCH_ARTIFACT_SIZE');
    const hash = artifactDigest(bytes), directory = await this.directory(actor), target = path.join(directory, hash);
    const ref = artifactReferenceSchema.parse({ store: 'local', key: hash, sha256: hash, byteLength: bytes.length });
    const temp = path.join(directory, `.${hash}.${randomUUID()}.tmp`);
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    try { await link(temp, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await unlink(temp); }
    // Atomic hard-link publication never exposes a partially written object.
    await this.read(actor, ref);
    return ref;
  }
}
