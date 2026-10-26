import type { RemoteTimeSource } from '@runova/core';
import type { FileSiteProtocol } from '../../../../shared/deployFilesTypes';
import type { FilesConnectTarget } from '../types';

/**
 * One way to reach the files on a server, whatever the protocol (E23). SFTP, FTP and FTPS each
 * implement it, and so does the in-memory server the tests use; one contract suite
 * (contract.ts) holds all of them to the same behaviour.
 *
 * Every path here is absolute and POSIX (`/var/www/site/css/a.css`): no call depends on a working
 * folder. Failures throw errors coded with `filesError` (shared/deployFilesErrors.ts).
 */

export interface RemoteEntry {
  name: string;
  /** Absolute path of the entry. */
  path: string;
  isDirectory: boolean;
  size: number;
  /** Null when the listing carries no usable time (FTP LIST): ask `stat` for it. */
  mtimeMs: number | null;
  via: RemoteTimeSource | null;
}

export interface RemoteStat {
  isDirectory: boolean;
  size: number;
  mtimeMs: number | null;
  via: RemoteTimeSource | null;
}

export interface RemoteCapabilities {
  /** A file can be replaced in one step: renaming over an existing file works. */
  atomicReplace: boolean;
  /** `exact`: listings carry times; `mdtm`: only `stat` does, one file at a time; `none`: neither. */
  mtime: 'exact' | 'mdtm' | 'none';
}

export interface PutFileOptions {
  /** The hash the plan expects. The bytes are hashed as they go; a mismatch keeps the old file. */
  sha256: string;
  size: number;
  signal?: AbortSignal;
  /** Bytes sent so far for this file, as they go. */
  onBytes?: (sent: number) => void;
}

export interface PutFileResult {
  /** What the server reports for the file once it is in place. */
  stat: RemoteStat;
  /** False when the old file had to be moved aside before the new one took its name. */
  atomic: boolean;
}

export interface RemoteFiles {
  readonly protocol: FileSiteProtocol;
  /** How many `putFile` calls may run at once on this connection (4 for SFTP, 1 for FTP). */
  readonly maxParallel: number;
  capabilities(): Promise<RemoteCapabilities>;
  /** The absolute form of `path`; `.` is the folder the login starts in. */
  realpath(path: string): Promise<string>;
  /** The entries of a folder, without `.` and `..`; null when the folder does not exist. */
  list(dir: string): Promise<RemoteEntry[] | null>;
  /** Null when nothing is at `path`. */
  stat(path: string): Promise<RemoteStat | null>;
  /** Makes the folder and any missing parents. True when it made the folder itself. */
  ensureDir(path: string): Promise<boolean>;
  /**
   * Sends a local file to `remotePath` under a temporary name in the same folder, then puts it in
   * place. A failure, a cancel or a hash mismatch leaves the old file as it was and removes the
   * temporary one where it can. A new file is readable by the web server (0644); a replaced one
   * keeps its mode. Where the server will not rename onto a file, the old one is renamed to a
   * backup (`BACKUP_FILE`) first and deleted once the new one is in place, never deleted before.
   */
  putFile(localPath: string, remotePath: string, options: PutFileOptions): Promise<PutFileResult>;
  /** Renames a file to a name nothing has yet (servers differ when it has). */
  rename(from: string, to: string): Promise<void>;
  /** Removes a file. Nothing at `path` is not an error. */
  remove(path: string): Promise<void>;
  /** Removes an empty folder. False when it still has something in it, or is not there. */
  removeEmptyDir(path: string): Promise<boolean>;
  close(): Promise<void>;
}

/** The temporary name pattern `putFile` uses, so a later run can clean up what a crash left. */
export const PART_FILE = /\.runova-[0-9a-f]{8}\.part$/;

/**
 * The name the old file has while a replace that cannot rename onto it is under way. A run that
 * finds one deletes it when the real file is there, and renames it back when it is not.
 */
export const BACKUP_FILE = /\.runova-[0-9a-f]{8}\.old$/;

/** The real name of a backup left by `putFile`: `a.css.runova-0123abcd.old` gives `a.css`. */
export function backupTargetOf(path: string): string {
  return path.replace(BACKUP_FILE, '');
}

export type OpenRemoteFiles = (
  target: FilesConnectTarget,
  options: {
    purpose: 'run' | 'browse';
    signal?: AbortSignal;
    /**
     * Nobody is there to look (Deploy on save): a server whose host key was never trusted is
     * refused with `hostKeyUnknown` instead of trusted on first use.
     */
    unattended?: boolean;
  },
) => Promise<RemoteFiles>;
