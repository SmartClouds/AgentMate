import { createHash } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../fs/atomicWrite.js';

/**
 * A video's content-addressed files (`blobs/ab/<sha256>`): AI requests and answers now, imported
 * media and generated audio later. A blob is written and renamed into place before any history row
 * names it, so a crash leaves at worst an unreferenced file, never a reference to nothing. Blobs are
 * never changed or removed.
 */

export const BLOBS_DIR = 'blobs';

const HASH = /^[0-9a-f]{64}$/;

export class BlobStore {
  constructor(private readonly dir: string) {}

  static forVideo(folder: string): BlobStore {
    return new BlobStore(join(folder, BLOBS_DIR));
  }

  path(hash: string): string {
    if (!HASH.test(hash)) throw new Error(`${hash} is not a blob hash.`);
    return join(this.dir, hash.slice(0, 2), hash);
  }

  async put(content: string | Uint8Array): Promise<string> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = this.path(hash);
    try {
      await access(file);
      return hash;
    } catch {
      // Not there yet.
    }
    await mkdir(join(this.dir, hash.slice(0, 2)), { recursive: true });
    await writeFileAtomic(file, bytes);
    return hash;
  }

  async text(hash: string): Promise<string> {
    return readFile(this.path(hash), 'utf8');
  }

  async bytes(hash: string): Promise<Buffer> {
    return readFile(this.path(hash));
  }

  async has(hash: string): Promise<boolean> {
    try {
      await access(this.path(hash));
      return true;
    } catch {
      return false;
    }
  }
}
