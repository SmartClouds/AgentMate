import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filesError } from '../../shared/deployFilesErrors';
import {
  SFTP_EDIT_MAX_BYTES,
  type SftpRemoteEntry,
  type SftpTextFile,
  type SftpWriteTextInput,
} from '../../shared/sftpTypes';
import { mapSftpError } from '../deploy/files/transport/errors';
import {
  baseName,
  joinRemote,
  normalizeRemote,
  parentOf,
} from '../deploy/files/transport/remotePath';
import type { SftpFileClient } from './client';

/**
 * Remote text files for the editor (E25, D14). A file over `SFTP_EDIT_MAX_BYTES` is refused
 * before a byte is read; one with a NUL byte in its first 8 KB, or that is not valid UTF-8, is not
 * text. A UTF-8 byte order mark is stripped for the editor and written back on save.
 *
 * A save first checks the file is still what was read (size and mtime), so a change made on the
 * server meanwhile is never silently written over: `[files:changedOnServer]` unless forced. SFTP
 * version 3 times have whole seconds, so a change in the same second that keeps the size is not
 * seen. The text goes to a temp file and then through `uploadFile`, which replaces the file
 * atomically, keeps its mode and checks the hash. A link is written through: the file it points
 * at changes and the link stays.
 */

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** How far into a file a NUL byte marks it as binary. */
const BINARY_SNIFF_BYTES = 8192;

function startsWithBom(bytes: Buffer): boolean {
  return bytes.length >= UTF8_BOM.length && bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
}

function notText(path: string): Error {
  return filesError('notText', `${path} is not UTF-8 text, so it cannot be edited here.`);
}

async function coded<T>(path: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw mapSftpError(error, path);
  }
}

export async function readText(client: SftpFileClient, path: string): Promise<SftpTextFile> {
  const info = await coded(path, () => client.sftpStat(path));
  if (!info) throw filesError('remoteFolderMissing', `${path} is not on the server.`);
  if (info.isDirectory) throw filesError('invalidInput', `${path} is a folder, not a file.`);
  if (info.size > SFTP_EDIT_MAX_BYTES) {
    throw filesError(
      'tooLarge',
      `${path} is larger than ${SFTP_EDIT_MAX_BYTES / 1024 / 1024} MB, too large to edit here.`,
    );
  }
  // One byte more than the stat said shows a file that grew in between.
  const bytes = await coded(path, () => client.sftpReadRange(path, 0, info.size + 1));
  if (bytes.length !== info.size) {
    throw filesError('changedOnServer', `${path} changed while it was being read. Open it again.`);
  }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw notText(path);
  const bom = startsWithBom(bytes);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(UTF8_BOM.length) : bytes,
    );
  } catch {
    throw notText(path);
  }
  return { path, content, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode, bom };
}

/**
 * Whether `path`, whose real path is `target`, is a link itself rather than a file reached
 * through a linked folder (`/var/www/current/index.html` with `current` a link).
 */
async function isLinkItself(
  client: SftpFileClient,
  path: string,
  target: string,
): Promise<boolean> {
  if (target === path) return false;
  const folder = parentOf(path) ?? '/';
  const realFolder = await client.sftpRealpath(folder).catch(() => folder);
  return target !== joinRemote(realFolder, baseName(path));
}

/** Saves the editor's text and answers the file as it now is (owner and group are not read). */
export async function writeText(
  client: SftpFileClient,
  input: SftpWriteTextInput,
  tempDir: string,
): Promise<SftpRemoteEntry> {
  const path = normalizeRemote(input.path);
  const bytes = Buffer.concat([input.bom ? UTF8_BOM : Buffer.alloc(0), Buffer.from(input.content)]);
  if (bytes.length > SFTP_EDIT_MAX_BYTES) {
    throw filesError(
      'tooLarge',
      `The text is larger than ${SFTP_EDIT_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  const existing = await coded(path, () => client.sftpStat(path));
  if (existing?.isDirectory) throw filesError('invalidInput', `${path} is a folder, not a file.`);
  const unchanged =
    existing !== null &&
    existing.size === input.base.size &&
    existing.mtimeMs === input.base.mtimeMs;
  if (!unchanged && !input.force) {
    throw filesError(
      'changedOnServer',
      existing
        ? `${path} changed on the server since it was opened.`
        : `${path} was deleted on the server since it was opened.`,
    );
  }
  // Through a link, the file it points at is what gets replaced, so the link stays a link.
  const target = existing ? await coded(path, () => client.sftpRealpath(path)) : path;

  await mkdir(tempDir, { recursive: true });
  const temp = join(tempDir, `runova-edit-${randomBytes(8).toString('hex')}.tmp`);
  let stat: Awaited<ReturnType<SftpFileClient['uploadFile']>>['stat'];
  try {
    await writeFile(temp, bytes);
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await coded(path, () =>
      client.uploadFile(temp, target, { mode: existing?.mode, expectedSha256 }),
    );
    stat = result.stat;
  } finally {
    await rm(temp, { force: true });
  }
  return {
    name: baseName(path),
    path,
    kind: 'file',
    isDirectory: false,
    isSymlink: await isLinkItself(client, path, target),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    owner: null,
    group: null,
  };
}
