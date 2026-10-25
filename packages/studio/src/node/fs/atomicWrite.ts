import { randomBytes } from 'node:crypto';
import { rename as fsRename, open, readFile, rm } from 'node:fs/promises';

/**
 * Writes `content` to `file` so a reader only ever sees the old file or the whole new one: write a
 * temp file beside it, flush it to disk, then rename over the target. On Windows a rename can fail
 * for a moment while an indexer or antivirus holds the file, so it is retried briefly.
 */
export async function writeFileAtomic(
  file: string,
  content: string | Uint8Array,
  deps: { rename?: (from: string, to: string) => Promise<void> } = {},
): Promise<void> {
  const rename = deps.rename ?? fsRename;
  const temp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  const handle = await open(temp, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await rm(temp, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

export type JsonRead = { state: 'ok'; value: unknown } | { state: 'missing' } | { state: 'broken' };

export async function readJsonFile(file: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    throw error;
  }
  try {
    return { state: 'ok', value: JSON.parse(text) };
  } catch {
    return { state: 'broken' };
  }
}
