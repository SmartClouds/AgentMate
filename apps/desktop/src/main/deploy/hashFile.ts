import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * The SHA-256 of a local file, for the deploy walkers (WordPress items in E19, FTP and SFTP sites
 * in E23). The file is streamed, so a large upload is never read into memory, and a cache keyed by
 * size and modification time skips files that have not changed since they were last hashed.
 */

export type HashCache = Map<string, { size: number; mtimeMs: number; sha256: string }>;

/**
 * SHA-256 of a file, from the cache when its size and modification time are unchanged. The cache
 * is keyed by `key`, the file's own path unless the caller names it otherwise (a site walk keys it
 * by the path relative to the site, so a cache can be seeded from the last deploy).
 */
export async function hashFile(
  path: string,
  size: number,
  mtimeMs: number,
  cache?: HashCache,
  key: string = path,
): Promise<string> {
  const cached = cache?.get(key);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.sha256;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const sha256 = hash.digest('hex');
  cache?.set(key, { size, mtimeMs, sha256 });
  return sha256;
}
