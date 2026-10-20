import type {
  SftpEntry,
  SftpOptions,
  SftpStat,
  UploadFileOptions,
  UploadFileResult,
} from '../ssh/connection';

/**
 * What the SFTP file manager (E25) needs from an SSH connection, and from the pool that hands
 * them out. Everything under main/sftp is written against these, so the unit tests run on the
 * in-memory fake in ./testing/fakeSftpClient.ts and the integration test on a real server.
 *
 * `SshConnection` (main/ssh/connection.ts) satisfies `SftpFileClient` structurally once it has
 * `sftpListDetailed` and `downloadFile` and its upload hash is optional. Those types are defined
 * here; connection.ts imports and re-exports them rather than declaring them a second time.
 */

/**
 * One entry of a detailed folder listing. A working link counts as what it points at, like
 * `SftpEntry` (its `isDirectory`, `isFile`, `size`, `mtimeMs` and `mode` are the target's), with
 * `isSymlink` set. A broken link is kept: `brokenLink` set, neither a file nor a folder, and the
 * size, mtime and mode of the link itself.
 */
export interface SftpDetailedEntry extends SftpEntry {
  /** The entry itself is a symbolic link, working or broken. */
  isSymlink: boolean;
  /** A link whose target is missing (or cannot be read). */
  brokenLink: boolean;
  /** The permission bits alone (`mode & 0o7777`). */
  mode: number;
  /**
   * The `ls -l` style line the server sent with the entry, such as
   * `-rw-r--r--    1 deploy   www-data     1234 Jan  5 10:12 index.html`. Owner and group names
   * come from here (see `parseLongname`). Empty when the server sent none.
   */
  longname: string;
}

/** `uploadFile` options. Unlike Deploy's, the file manager does not always know the hash ahead. */
export type FileUploadOptions = Omit<UploadFileOptions, 'expectedSha256'> & {
  /** When given, bytes that hash to anything else never take the target's place (`localChanged`). */
  expectedSha256?: string;
};

export interface FileUploadResult extends UploadFileResult {
  /** SHA-256 of the bytes sent, hex. */
  sha256: string;
}

export interface DownloadFileOptions {
  signal?: AbortSignal;
  /** Bytes written to the local file so far, out of the size the server reported at the start. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  /** How long one read may go unanswered before the download is given up on (`timeout`). */
  stallTimeoutMs?: number;
  /** Give the local file the remote file's mtime. Default true. */
  preserveMtime?: boolean;
}

export interface DownloadFileResult {
  /** Bytes written. */
  size: number;
  /** The remote file's mtime, which the local file now has unless `preserveMtime` was false. */
  mtimeMs: number;
  /** A file was at the local path before, so this replaced it. */
  replaced: boolean;
}

/**
 * The SFTP side of an SSH connection. The method shapes and their failures are those of
 * `SshConnection`: SFTP errors reject with ssh2's errors, which carry the SFTP status as a number
 * in `code` (2 no such file, 3 permission denied, 4 failure), and a connection that has ended
 * rejects with `The SSH connection to <host> closed.` (in flight) or `... is closed.` (new calls).
 * `mapSftpError` and main/sftp/errors.ts turn both into coded errors.
 */
export interface SftpFileClient {
  /** False once the connection has ended, whoever ended it. */
  readonly isOpen: boolean;
  /** The absolute form of `path`, links resolved. `.` is the login user's home folder. */
  sftpRealpath(path: string, options?: SftpOptions): Promise<string>;
  /** A folder's entries, `.` and `..` left out, links marked (see `SftpDetailedEntry`). */
  sftpListDetailed(dir: string, options?: SftpOptions): Promise<SftpDetailedEntry[]>;
  /** Size, mtime and mode of `path`, links followed, or null when nothing is there. */
  sftpStat(path: string, options?: SftpOptions): Promise<SftpStat | null>;
  /** Makes one folder (default mode 0o755). Fails when the name is taken or the parent is missing. */
  sftpMkdir(path: string, options?: SftpOptions & { mode?: number }): Promise<void>;
  /** Removes an empty folder. A link to a folder is not one. */
  sftpRmdir(path: string, options?: SftpOptions): Promise<void>;
  /** Removes a file, or a link itself (never its target). Fails on a folder. */
  sftpUnlink(path: string, options?: SftpOptions): Promise<void>;
  /** Sets the permission bits. Follows a link, as chmod(2) does. */
  sftpChmod(path: string, mode: number, options?: SftpOptions): Promise<void>;
  /** A plain SFTP rename, which fails when `to` already exists. */
  sftpRename(from: string, to: string, options?: SftpOptions): Promise<void>;
  /** Up to `length` bytes from `start`; fewer when the file ends sooner. */
  sftpReadRange(
    path: string,
    start: number,
    length: number,
    options?: SftpOptions,
  ): Promise<Buffer>;
  /**
   * Sends a local file to `remotePath` atomically: the bytes go to a `.part` beside it and only
   * then take the name, so the target keeps its old contents after a failure or a cancel
   * (`[files:cancelled]`). The mode defaults to the replaced file's, or 0o644.
   */
  uploadFile(
    localPath: string,
    remotePath: string,
    options?: FileUploadOptions,
  ): Promise<FileUploadResult>;
  /**
   * Fetches `remotePath` into `localPath` the same way round: the bytes go to
   * `<localPath>.agentmate-<8 hex>.part` and only then replace the target, which is left as it
   * was after a failure or a cancel. A file that ends early or grows while it is read fails with
   * `[files:changedOnServer]`.
   */
  downloadFile(
    remotePath: string,
    localPath: string,
    options?: DownloadFileOptions,
  ): Promise<DownloadFileResult>;
}

/** A client lent out by the pool. */
export interface ClientLease {
  readonly client: SftpFileClient;
  /** Hands the client back. Safe to call more than once. */
  release(): void;
}

/**
 * Where sessions get their clients. The real one wraps the shared `SshConnectionPool`
 * (main/ssh/sharedPool.ts), whose leases name the connection `connection`, so main/sftp/index.ts
 * adapts them: `{ client: lease.connection, release: lease.release }`.
 */
export interface SftpPool {
  /**
   * The server's shared connection, the one the terminal and Deploy use too. Rejects with
   * `VaultLockedError`, `HostKeyChangedError` and the like when it cannot log in.
   */
  acquire(serverId: string): Promise<ClientLease>;
  /** A connection of its own, for transfers, so a big upload never holds up the listings. Releasing it closes it. */
  openSeparate(serverId: string): Promise<ClientLease>;
}
