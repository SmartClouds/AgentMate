import type { SshConnection } from '../../../ssh/connection';
import { limiter } from '../../../util/limiter';
import { FilesTransportError, mapSftpError } from './errors';
import { joinRemote, normalizeRemote, parentOf } from './remotePath';
import type { RemoteFiles, RemoteStat } from './types';

/**
 * SFTP sites (E23) on top of an `SshConnection`: a server saved in Remote, leased from the pool,
 * or a login of the site's own. Times come from SFTP itself, in whole seconds, so a later listing
 * compares exactly with what was recorded after an upload.
 */

/** The SFTP calls the transport uses, so tests can stand in for a whole connection. */
export type SftpFilesConnection = Pick<
  SshConnection,
  | 'isOpen'
  | 'sftpRealpath'
  | 'sftpList'
  | 'sftpStat'
  | 'sftpMkdir'
  | 'sftpUnlink'
  | 'sftpRmdir'
  | 'sftpRename'
  | 'sftpSupports'
  | 'uploadFile'
>;

/** Folders listed at once: enough to hide the round trips, few enough not to flood the server. */
const MAX_LISTINGS = 8;
const MAX_UPLOADS = 4;
const SFTP_NO_SUCH_FILE = 2;
const SFTP_FAILURE = 4;

const statusOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

export function createSftpRemote(
  connection: SftpFilesConnection,
  release: () => void,
): RemoteFiles {
  const listings = limiter(MAX_LISTINGS);
  const uploads = limiter(MAX_UPLOADS);
  /** Folders known to exist, so a deploy does not ask about the same parent for every file. */
  const knownDirs = new Set<string>();
  let closed = false;
  let posixRename: Promise<boolean> | null = null;
  let sawAtomicReplace = false;
  let sawSplitReplace = false;

  const guard = async <T>(path: string, work: () => Promise<T>): Promise<T> => {
    if (closed) throw new FilesTransportError('unreachable', 'This SFTP connection is closed.');
    try {
      return await work();
    } catch (error) {
      throw mapSftpError(error, path);
    }
  };

  const statOf = async (path: string): Promise<RemoteStat | null> => {
    const stat = await connection.sftpStat(path);
    if (!stat) return null;
    return { isDirectory: stat.isDirectory, size: stat.size, mtimeMs: stat.mtimeMs, via: 'sftp' };
  };

  return {
    protocol: 'sftp',
    maxParallel: MAX_UPLOADS,

    async capabilities() {
      posixRename ??= guard('the server', () =>
        connection.sftpSupports('posix-rename@openssh.com'),
      );
      const advertised = await posixRename;
      return {
        atomicReplace: !sawSplitReplace && (advertised || sawAtomicReplace),
        mtime: 'exact',
      };
    },

    realpath: (path) => guard(path, () => connection.sftpRealpath(path)),

    list: (dir) =>
      guard(dir, () =>
        listings(async () => {
          const folder = normalizeRemote(dir);
          try {
            const entries = await connection.sftpList(folder);
            knownDirs.add(folder);
            return entries.map((entry) => ({
              name: entry.name,
              path: joinRemote(folder, entry.name),
              isDirectory: entry.isDirectory,
              size: entry.size,
              mtimeMs: entry.mtimeMs,
              via: 'sftp' as const,
            }));
          } catch (error) {
            if (statusOf(error) === SFTP_NO_SUCH_FILE) return null;
            throw error;
          }
        }),
      ),

    stat: (path) => guard(path, () => statOf(normalizeRemote(path))),

    ensureDir: (path) =>
      guard(path, async () => {
        const target = normalizeRemote(path);
        if (knownDirs.has(target)) return false;
        // Up from the target to the deepest folder that exists, so folders the login may not
        // read (a chroot's parents) are never asked about.
        const missing: string[] = [];
        let current: string | null = target;
        while (current && !knownDirs.has(current)) {
          const stat = await connection.sftpStat(current);
          if (stat?.isDirectory) break;
          if (stat) throw new FilesTransportError('server', `${current} is a file, not a folder.`);
          missing.unshift(current);
          current = parentOf(current);
        }
        if (current) knownDirs.add(current);
        let made = false;
        for (const dir of missing) {
          try {
            await connection.sftpMkdir(dir);
            made = dir === target;
          } catch (error) {
            // Made by someone else in the meantime: fine, as long as it is a folder now.
            if (!(await connection.sftpStat(dir))?.isDirectory) throw error;
            made = false;
          }
          knownDirs.add(dir);
        }
        return made;
      }),

    putFile: (localPath, remotePath, options) =>
      guard(remotePath, () =>
        uploads(async () => {
          const result = await connection.uploadFile(localPath, normalizeRemote(remotePath), {
            expectedSha256: options.sha256,
            signal: options.signal,
            onProgress: options.onBytes,
          });
          if (result.replaced && result.atomic) sawAtomicReplace = true;
          if (!result.atomic) sawSplitReplace = true;
          return {
            stat: {
              isDirectory: false,
              size: result.stat.size,
              mtimeMs: result.stat.mtimeMs,
              via: 'sftp',
            },
            atomic: result.atomic,
          };
        }),
      ),

    rename: (from, to) =>
      guard(from, () => connection.sftpRename(normalizeRemote(from), normalizeRemote(to))),

    remove: (path) =>
      guard(path, async () => {
        try {
          await connection.sftpUnlink(normalizeRemote(path));
        } catch (error) {
          if (statusOf(error) !== SFTP_NO_SUCH_FILE) throw error;
        }
      }),

    removeEmptyDir: (path) =>
      guard(path, async () => {
        const folder = normalizeRemote(path);
        try {
          await connection.sftpRmdir(folder);
          knownDirs.delete(folder);
          return true;
        } catch (error) {
          // SFTP version 3 has no code for a folder that is not empty: servers say "Failure".
          const status = statusOf(error);
          if (status === SFTP_NO_SUCH_FILE || status === SFTP_FAILURE) return false;
          throw error;
        }
      }),

    async close() {
      if (closed) return;
      closed = true;
      release();
    },
  };
}
