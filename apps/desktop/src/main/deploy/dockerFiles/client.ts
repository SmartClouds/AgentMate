import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, lstat, open, rename, rm, stat, utimes } from 'node:fs/promises';
import { Readable, Transform, Writable, pipeline } from 'node:stream';
import type {
  FileEntry,
  FileSessionInfo,
} from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/AgentMate.ServerCore.Contracts';
import { encodeFilesError, filesError } from '../../../shared/deployFilesErrors';
import type { SftpCapabilities } from '../../../shared/sftpTypes';
import type {
  DownloadFileOptions,
  DownloadFileResult,
  FileUploadOptions,
  FileUploadResult,
  SftpDetailedEntry,
  SftpFileClient,
} from '../../sftp/client';
import type { SftpStat } from '../../ssh/connection';
import {
  CoreHttpAbortError,
  type CoreHttpClient,
  CoreHttpError,
  CoreHttpStallError,
} from '../connection/coreHttp';
import { joinRemote } from '../files/transport/remotePath';

/**
 * The file manager's client (E25's `SftpFileClient`) for a container or a volume on a Deploy
 * server (E27), on one file session the server core holds. Browsing and changes are hub calls
 * (`files*`, Admin only); bytes go over the core's REST, streamed both ways:
 * `GET /api/v1/files/{session}/content?path=` (with `Range` for the editor's reads) and `PUT` the
 * same with the raw body.
 *
 * The core's refusals carry `[files:<code>] <sentence>` (hub) or `{ code, message }` (REST). They
 * come out the way ssh2's SFTP errors do, so the service, the engine and `mapSftpError` read them
 * without knowing which backend answered: a numeric `code` (2 no such file, 3 permission denied,
 * 4 failure, 8 not supported) and the core's sentence, tagged `[files:*]` where the file manager
 * has a code of its own (exists, permissionDenied, diskFull, invalidInput). A session the core
 * has ended (`sessionGone`, `targetGone`) or a lost connection closes the client, and it then
 * rejects like a closed SSH connection, so the service's lease opens a new session.
 *
 * Downloads go to `<target>.agentmate-<8 hex>.part`, are synced and given the remote mtime, and
 * only then take the target's place. Uploads are atomic on the core when it has a shell there
 * (`atomic` says so). The bytes are hashed on the way, and the last chunk is only sent once the
 * hash is known to be right, so a file that changed under an upload with `expectedSha256` cuts
 * the body short and the core puts nothing in place.
 */

/** A big transfer on a slow link may take hours; only one that stops moving fails. */
const STALL_MS = 60_000;
/** Links in one listing resolved at once, to show what each points at. */
const LINKS_IN_FLIGHT = 8;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

/** SFTP status codes, as ssh2 puts them on `error.code`. */
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;
const OP_UNSUPPORTED = 8;

/** What the core says a file call failed with. */
export type CoreFilesCode =
  | 'notFound'
  | 'permissionDenied'
  | 'exists'
  | 'notEmpty'
  | 'isDirectory'
  | 'notDirectory'
  | 'unsupported'
  | 'invalidInput'
  | 'sessionGone'
  | 'targetGone'
  | 'diskFull'
  | 'server';

const CORE_CODES: ReadonlySet<string> = new Set<CoreFilesCode>([
  'notFound',
  'permissionDenied',
  'exists',
  'notEmpty',
  'isDirectory',
  'notDirectory',
  'unsupported',
  'invalidInput',
  'sessionGone',
  'targetGone',
  'diskFull',
  'server',
]);
const CODED = /\[files:([A-Za-z]+)\]\s*([\s\S]*)$/;
/** What SignalR says when the Admin policy turned a hub method down. */
const UNAUTHORIZED = /because user is unauthorized/;
/** A hub or REST connection that has gone. */
const LOST =
  /connection .*(closed|lost)|is closed|no connection|not in the 'Connected' State|socket hang up|ECONNRESET|EPIPE|ECONNREFUSED|ECONNABORTED/i;
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const ONLY_ADMINS = 'Only Admins can work with files in containers and volumes.';

/** The Deploy service's two ways to a server's core (DeployService.withHub, withCoreHttp). */
export interface DockerFilesBackend {
  withHub<T>(serverId: string, work: (hub: ICoreHub) => Promise<T>): Promise<T>;
  withCoreHttp<T>(
    serverId: string,
    work: (client: CoreHttpClient, token: string) => Promise<T>,
  ): Promise<T>;
}

export interface DockerFileClientOptions {
  /** The Deploy server the core runs on. */
  serverId: string;
  /** The core's session, as `filesOpen` answered it. */
  session: FileSessionInfo;
  backend: DockerFilesBackend;
  /** How long a transfer may go without a byte moving. Default 60 s. */
  stallTimeoutMs?: number;
}

/** A failure from the core, worded and numbered like ssh2's. */
export type CoreFilesError = Error & { code?: number; coreCode?: CoreFilesCode };

/** The core's code and sentence in an error, from a hub message or a REST body. */
export function coreFilesFailure(error: unknown): { code: CoreFilesCode; sentence: string } | null {
  if (error instanceof CoreHttpError) {
    const body = error.body as { code?: unknown; message?: unknown } | null;
    if (body && typeof body.code === 'string' && CORE_CODES.has(body.code)) {
      return {
        code: body.code as CoreFilesCode,
        sentence: typeof body.message === 'string' ? body.message : error.message,
      };
    }
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = CODED.exec(message);
  if (!match || !CORE_CODES.has(match[1])) return null;
  return { code: match[1] as CoreFilesCode, sentence: match[2].trim() };
}

function statusError(code: number, message: string, coreCode?: CoreFilesCode): CoreFilesError {
  return Object.assign(new Error(message), { code, ...(coreCode ? { coreCode } : {}) });
}

function isLost(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  return LOST.test(error instanceof Error ? error.message : String(error));
}

function wholeSeconds(ms: number | undefined): number {
  return Math.floor((ms ?? 0) / 1000) * 1000;
}

function toStat(entry: FileEntry): SftpStat {
  return {
    isDirectory: entry.kind === 'directory',
    isFile: entry.kind === 'file',
    size: entry.size,
    mtimeMs: wholeSeconds(entry.mtimeUnixMs),
    mode: entry.mode & 0o7777,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `rwxr-xr-x`, with setuid, setgid and sticky shown the way ls does. */
function permissionText(mode: number): string {
  const triple = (bits: number, special: boolean, letter: string): string => {
    const execute = (bits & 1) !== 0;
    const last = special ? (execute ? letter : letter.toUpperCase()) : execute ? 'x' : '-';
    return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${last}`;
  };
  return (
    triple((mode >> 6) & 7, (mode & 0o4000) !== 0, 's') +
    triple((mode >> 3) & 7, (mode & 0o2000) !== 0, 's') +
    triple(mode & 7, (mode & 0o1000) !== 0, 't')
  );
}

function typeLetter(entry: FileEntry): string {
  switch (entry.kind) {
    case 'directory':
      return 'd';
    case 'symlink':
      return 'l';
    case 'file':
      return '-';
    default:
      switch (entry.mode & 0o170000) {
        case 0o010000:
          return 'p';
        case 0o140000:
          return 's';
        case 0o020000:
          return 'c';
        case 0o060000:
          return 'b';
        default:
          return '?';
      }
  }
}

/** Uid 0 is root everywhere; other ids are shown as numbers, as `ls -n` does. */
function ownerName(id: number): string {
  return id === 0 ? 'root' : String(id);
}

/** An `ls -l` style line for the entry itself, like OpenSSH's, so owner and group parse. */
function longnameOf(entry: FileEntry): string {
  const date = new Date(wholeSeconds(entry.mtimeUnixMs));
  const day = String(date.getUTCDate()).padStart(2, ' ');
  const when = `${MONTHS[date.getUTCMonth()]} ${day}  ${date.getUTCFullYear()}`;
  const owner = ownerName(entry.uid).padEnd(8);
  const group = ownerName(entry.gid).padEnd(8);
  const size = String(entry.size).padStart(8, ' ');
  return `${typeLetter(entry)}${permissionText(entry.mode & 0o7777)}    1 ${owner} ${group} ${size} ${when} ${entry.name}`;
}

/** Runs `work` over `items`, at most `limit` at once, keeping their order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/** Writes to an open file, reporting what is on disk after each write. */
class PartWriter extends Writable {
  written = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly progress: (written: number) => void,
  ) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
    this.handle.write(chunk).then(
      () => {
        this.written += chunk.length;
        this.progress(this.written);
        done();
      },
      (error: Error) => done(error),
    );
  }
}

export class DockerFileClient implements SftpFileClient {
  readonly session: FileSessionInfo;
  private readonly serverId: string;
  private readonly backend: DockerFilesBackend;
  private readonly stallMs: number;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(options: DockerFileClientOptions) {
    this.session = options.session;
    this.serverId = options.serverId;
    this.backend = options.backend;
    this.stallMs = options.stallTimeoutMs ?? STALL_MS;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** What the session allows. Editing saves through a rename, so it goes with rename. */
  capabilities(): SftpCapabilities {
    const { rename, remove, chmod } = this.session.capabilities;
    return { rename, remove, chmod, edit: rename };
  }

  limitation(): string | null {
    return this.session.limitation ?? null;
  }

  /** Ends the session on the core (a failure there is ignored: it expires on its own). */
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.backend
      .withHub(this.serverId, (hub) => hub.filesClose(this.session.sessionId))
      .then(
        () => undefined,
        () => undefined,
      );
    return this.closing;
  }

  // Browsing and changes, over the hub.

  async sftpRealpath(path: string): Promise<string> {
    const absolute = this.absolute(path);
    return this.call((hub, sessionId) => hub.filesRealpath({ sessionId, path: absolute }));
  }

  async sftpListDetailed(dir: string): Promise<SftpDetailedEntry[]> {
    return (await this.sftpListing(dir)).entries;
  }

  /** The listing with whether the core cut it short (a big folder without a shell). */
  async sftpListing(dir: string): Promise<{ entries: SftpDetailedEntry[]; partial: boolean }> {
    const listing = await this.call((hub, sessionId) => hub.filesList({ sessionId, path: dir }));
    const entries = await mapLimit(listing.entries, LINKS_IN_FLIGHT, async (entry) => {
      if (entry.kind !== 'symlink' || entry.brokenLink) return this.detailed(entry, null);
      const target = await this.followed(joinRemote(listing.path, entry.name)).catch(
        (error: unknown) => {
          if (!this.isOpen) throw error;
          return null;
        },
      );
      return this.detailed(entry, target);
    });
    return { entries, partial: listing.partial };
  }

  async sftpStat(path: string): Promise<SftpStat | null> {
    try {
      const entry = await this.call((hub, sessionId) => hub.filesStat({ sessionId, path }));
      if (!entry) return null;
      if (entry.kind !== 'symlink') return toStat(entry);
      if (entry.brokenLink) return null;
      const target = await this.followed(path);
      return target ? toStat(target) : null;
    } catch (error) {
      if (isNothingThere(error)) return null;
      throw error;
    }
  }

  async sftpMkdir(path: string, options: { mode?: number } = {}): Promise<void> {
    await this.call((hub, sessionId) => hub.filesMkdir({ sessionId, path }));
    const { mode } = options;
    if (mode !== undefined && mode !== DEFAULT_DIR_MODE && this.session.capabilities.chmod) {
      await this.sftpChmod(path, mode);
    }
  }

  async sftpRmdir(path: string): Promise<void> {
    await this.call((hub, sessionId) => hub.filesRemove({ sessionId, path, directory: true }));
  }

  async sftpUnlink(path: string): Promise<void> {
    await this.call((hub, sessionId) => hub.filesRemove({ sessionId, path, directory: false }));
  }

  async sftpChmod(path: string, mode: number): Promise<void> {
    await this.call((hub, sessionId) => hub.filesChmod({ sessionId, path, mode }));
  }

  async sftpRename(from: string, to: string): Promise<void> {
    await this.call((hub, sessionId) => hub.filesRename({ sessionId, from, to }));
  }

  // Bytes, over REST.

  async sftpReadRange(path: string, start: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let size = 0;
    let whole = false;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        chunks.push(chunk);
        done();
      },
    });
    try {
      await this.rest((client, token) =>
        client.download(this.contentPath(path), sink, {
          token,
          headers: { range: `bytes=${start}-${start + length - 1}` },
          stallTimeoutMs: this.stallMs,
          // A core that sends the whole file has ignored the range.
          onResponse: (status) => {
            whole = status === 200;
          },
        }),
      );
    } catch (error) {
      if (error instanceof CoreHttpError && error.status === 416) return Buffer.alloc(0);
      throw this.failure(error);
    }
    const bytes = Buffer.concat(chunks, size);
    return whole ? bytes.subarray(start, start + length) : bytes.subarray(0, length);
  }

  async uploadFile(
    localPath: string,
    remotePath: string,
    options: FileUploadOptions = {},
  ): Promise<FileUploadResult> {
    const { signal } = options;
    const cancelled = (): Error =>
      filesError('cancelled', `The upload of ${remotePath} was cancelled.`);
    if (signal?.aborted) throw cancelled();
    const existing = await this.sftpStat(remotePath);
    const size = (await stat(localPath)).size;
    const mode = options.mode ?? existing?.mode ?? DEFAULT_FILE_MODE;
    const hashed = { sha256: '' };
    const changed = filesError(
      'localChanged',
      `${localPath} changed while it was being sent, so ${remotePath} was left as it was.`,
    );
    const source =
      size === 0 ? Readable.from([]) : createReadStream(localPath, { start: 0, end: size - 1 });
    const body = pipeline(
      source,
      holdLastChunk(size, options.expectedSha256, hashed, changed),
      () => undefined,
    );
    let entry: FileEntry | undefined;
    try {
      entry = await this.rest((client, token) =>
        client.putStream<FileEntry>(
          `${this.contentPath(remotePath)}&mode=${mode.toString(8)}`,
          body,
          {
            token,
            contentType: 'application/octet-stream',
            contentLength: size,
            stallTimeoutMs: options.stallTimeoutMs ?? this.stallMs,
            ...(signal ? { signal } : {}),
            ...(options.onProgress ? { onProgress: options.onProgress } : {}),
          },
        ),
      );
    } catch (error) {
      if (error === changed) throw changed;
      if (signal?.aborted || error instanceof CoreHttpAbortError) throw cancelled();
      throw this.failure(error, `Sending ${remotePath}`, options.stallTimeoutMs);
    } finally {
      source.destroy();
    }
    const placed = entry ? toStat(entry) : await this.sftpStat(remotePath);
    if (!placed) throw new Error(`${remotePath} was not there right after it was sent.`);
    return {
      stat: placed,
      atomic: this.session.capabilities.atomicUpload,
      replaced: existing !== null,
      sha256: hashed.sha256,
    };
  }

  async downloadFile(
    remotePath: string,
    localPath: string,
    options: DownloadFileOptions = {},
  ): Promise<DownloadFileResult> {
    const { signal } = options;
    const cancelled = (): Error =>
      filesError('cancelled', `The download of ${remotePath} was cancelled.`);
    const changed = (): Error =>
      filesError(
        'changedOnServer',
        `${remotePath} changed in ${this.session.displayName} while it was being fetched, so ` +
          `${localPath} was left as it was.`,
      );
    if (signal?.aborted) throw cancelled();
    if (this.closed) throw this.closedError(false);

    const part = `${localPath}.agentmate-${randomBytes(4).toString('hex')}.part`;
    let handle: FileHandle | null = await open(part, 'wx');
    const file = handle;
    let total = -1;
    let mtimeMs: number | null = null;
    try {
      const writer = new PartWriter(file, (written) =>
        options.onProgress?.(written, total < 0 ? written : total),
      );
      try {
        await this.rest((client, token) =>
          client.download(this.contentPath(remotePath), writer, {
            token,
            stallTimeoutMs: options.stallTimeoutMs ?? this.stallMs,
            ...(signal ? { signal } : {}),
            onResponse: (_status, headers) => {
              const length = Number(headers['content-length']);
              if (Number.isFinite(length) && length >= 0) total = length;
              const mtime = Number(headers['x-agentmate-mtime-ms']);
              if (Number.isFinite(mtime) && mtime > 0) mtimeMs = wholeSeconds(mtime);
            },
          }),
        );
      } catch (error) {
        if (signal?.aborted || error instanceof CoreHttpAbortError) throw cancelled();
        throw this.failure(error, `Fetching ${remotePath}`, options.stallTimeoutMs);
      }
      if (total >= 0 && writer.written !== total) throw changed();
      const size = writer.written;
      await file.sync();
      handle = null;
      await file.close();
      const mtime = mtimeMs ?? (await this.sftpStat(remotePath))?.mtimeMs ?? Date.now();
      // Before the rename, so the target never shows the download's own time.
      if (options.preserveMtime !== false) await utimes(part, mtime / 1000, mtime / 1000);
      if (signal?.aborted) throw cancelled();
      const replaced = await lstat(localPath).then(
        () => true,
        () => false,
      );
      await rename(part, localPath);
      return { size, mtimeMs: mtime, replaced };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(part, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  // Plumbing.

  /** A hub call on the session, its failure worded like ssh2's. */
  private async call<T>(work: (hub: ICoreHub, sessionId: string) => Promise<T>): Promise<T> {
    if (this.closed) throw this.closedError(false);
    try {
      return await this.backend.withHub(this.serverId, (hub) => work(hub, this.session.sessionId));
    } catch (error) {
      throw this.failure(error);
    }
  }

  private rest<T>(work: (client: CoreHttpClient, token: string) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(this.closedError(false));
    return this.backend.withCoreHttp(this.serverId, work);
  }

  /** What a link points at (its own entry, links resolved), or null when that is nothing. */
  private async followed(path: string): Promise<FileEntry | null> {
    try {
      return await this.call(async (hub, sessionId) => {
        const real = await hub.filesRealpath({ sessionId, path });
        const entry = await hub.filesStat({ sessionId, path: real });
        return entry && entry.kind !== 'symlink' ? entry : null;
      });
    } catch (error) {
      if (!this.isOpen) throw error;
      return null;
    }
  }

  private detailed(entry: FileEntry, target: FileEntry | null): SftpDetailedEntry {
    const isSymlink = entry.kind === 'symlink';
    const brokenLink = isSymlink && (entry.brokenLink || target === null);
    const shown = isSymlink && target ? target : entry;
    return {
      name: entry.name,
      isDirectory: !brokenLink && shown.kind === 'directory',
      isFile: !brokenLink && shown.kind === 'file',
      size: shown.size,
      mtimeMs: wholeSeconds(shown.mtimeUnixMs),
      mode: shown.mode & 0o7777,
      isSymlink,
      brokenLink,
      longname: longnameOf(entry),
    };
  }

  private absolute(path: string): string {
    if (path.startsWith('/')) return path;
    const home = this.session.home || '/';
    if (path === '' || path === '.') return home;
    return `${home.replace(/\/+$/, '')}/${path}`;
  }

  private contentPath(path: string): string {
    return `/api/v1/files/${encodeURIComponent(this.session.sessionId)}/content?path=${encodeURIComponent(path)}`;
  }

  private closedError(inFlight: boolean, why?: string): Error {
    const name = this.session.displayName;
    const sentence = inFlight
      ? `The connection to ${name} closed.`
      : `The connection to ${name} is closed.`;
    return new Error(why ? `${sentence} ${why}` : sentence);
  }

  /** A failure from the hub or REST, in the shapes the file manager reads (see the top). */
  private failure(error: unknown, what?: string, stallMs = this.stallMs): Error {
    if (error instanceof CoreHttpStallError) {
      const seconds = `${stallMs / 1000} s`;
      return filesError(
        'timeout',
        `${what ?? 'The transfer'}: ${this.session.displayName} stopped answering for ${seconds}.`,
      );
    }
    const coded = coreFilesFailure(error);
    if (coded) {
      const { code, sentence } = coded;
      switch (code) {
        case 'sessionGone':
        case 'targetGone':
          this.closed = true;
          return this.closedError(true, sentence);
        case 'notFound':
          return statusError(NO_SUCH_FILE, sentence, code);
        case 'permissionDenied':
          return statusError(PERMISSION_DENIED, encodeFilesError(code, sentence), code);
        case 'unsupported':
          return statusError(OP_UNSUPPORTED, sentence, code);
        case 'exists':
        case 'invalidInput':
        case 'diskFull':
          return statusError(FAILURE, encodeFilesError(code, sentence), code);
        default:
          return statusError(FAILURE, sentence, code);
      }
    }
    if (UNAUTHORIZED.test(error instanceof Error ? error.message : String(error))) {
      return statusError(PERMISSION_DENIED, encodeFilesError('permissionDenied', ONLY_ADMINS));
    }
    if (error instanceof CoreHttpError) {
      if (error.status === 401 || error.status === 403) {
        return statusError(PERMISSION_DENIED, encodeFilesError('permissionDenied', ONLY_ADMINS));
      }
      if (error.status === 404) {
        return filesError(
          'server',
          'This server core cannot transfer files yet. Update it from the Deploy page.',
        );
      }
      return error;
    }
    if (isLost(error)) {
      this.closed = true;
      return this.closedError(true);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** For stat: what means "nothing there" rather than a failure. */
function isNothingThere(error: unknown): boolean {
  const coreCode = (error as CoreFilesError | null)?.coreCode;
  return coreCode === 'notFound' || coreCode === 'notDirectory';
}

/**
 * Passes the bytes on one chunk behind, hashing them, and lets the last one go only once the
 * whole file has been read and it is the size it was (and hashes to `expected`, when given).
 * Otherwise the stream fails with `changed` and the body never reaches its Content-Length.
 */
function holdLastChunk(
  size: number,
  expected: string | undefined,
  result: { sha256: string },
  changed: Error,
): Transform {
  const hash = createHash('sha256');
  let held: Buffer | null = null;
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      seen += chunk.length;
      const previous = held;
      held = chunk;
      done(null, previous ?? undefined);
    },
    flush(done) {
      result.sha256 = hash.digest('hex');
      if (seen !== size || (expected !== undefined && result.sha256 !== expected)) {
        done(changed);
        return;
      }
      done(null, held ?? undefined);
    },
  });
}
