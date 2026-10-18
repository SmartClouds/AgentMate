import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  Client,
  type ClientChannel,
  type FileEntryWithStats,
  type SFTPWrapper,
  type Stats,
} from 'ssh2';
import { filesError } from '../../shared/deployFilesErrors';
import { buildConnectConfig, friendlyConnectError, type SshEndpoint } from './connectConfig';

/**
 * A non-interactive SSH connection: commands with real exit codes, stdin for anything secret,
 * atomic uploads, and tunnels. The Deploy section installs and reaches the server core through
 * this; interactive terminals keep using `SshSessionManager`.
 */

export interface SshConnectionHooks {
  /** Fires on a first connect, so the caller can store the fingerprint it just trusted. */
  onHostKeyTrusted?: (fingerprint: string) => void;
  /** Fires once when the connection ends, whoever ended it. */
  onClose?: () => void;
}

export interface ExecOptions {
  /** Written to the command's stdin, then stdin is closed. Secrets go here, never in the command. */
  stdin?: Buffer | string;
  timeoutMs?: number;
  /** Per stream. Output beyond it is dropped and marked as truncated. */
  maxOutputBytes?: number;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Null when the command was killed by a signal or given up on. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export type TunnelTarget = { socketPath: string } | { host: string; port: number };

/** One entry of an SFTP folder listing. A link counts as whatever it points at. */
export interface SftpEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
}

export interface SftpOptions {
  /** How long the whole operation may take before it is given up on. */
  timeoutMs?: number;
}

export interface UploadOptions {
  mode?: number;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}

/** What `sftpStat` reports. A link counts as whatever it points at. */
export interface SftpStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
  /** The permission bits alone, such as 0o644. */
  mode: number;
}

export interface UploadFileOptions {
  /** The SHA-256 the bytes must have. Anything else is never put in place of the target. */
  expectedSha256: string;
  /** Default: the mode of the file it replaces, or 0644 for a new one. */
  mode?: number;
  signal?: AbortSignal;
  /** Bytes the server has taken so far. */
  onProgress?: (sentBytes: number) => void;
  /** How long one request may go unanswered before the upload is given up on. */
  stallTimeoutMs?: number;
}

export interface UploadFileResult {
  /** What the server reports for the file once it is in place. */
  stat: SftpStat;
  /** False when the old file had to be removed before the new one could take its name. */
  atomic: boolean;
  /** A file was at `remotePath` before, so this was a replace rather than a new file. */
  replaced: boolean;
}

/** SSH's reason code when sshd refuses a channel by policy (RFC 4254, section 5.1). */
const ADMINISTRATIVELY_PROHIBITED = 1;

/** A tunnel the server would not open. `prohibited` means sshd's configuration forbids it. */
export class TunnelRefusedError extends Error {
  readonly prohibited: boolean;

  constructor(message: string, reason: unknown) {
    super(message);
    this.name = 'TunnelRefusedError';
    this.prohibited = reason === ADMINISTRATIVELY_PROHIBITED;
  }
}

/**
 * A command that got no answer in time. `exec` resolves with `timedOut` and empty output instead
 * of rejecting, so a caller that reads the output as the answer takes a silent server for an
 * empty one. `requireAnswer` turns that into this error for the callers that cannot go on without.
 */
export class CommandTimeoutError extends Error {
  constructor(host: string, timeoutMs: number) {
    super(
      `${host} accepted the login but did not answer within ${seconds(timeoutMs)}. It may be ` +
        'overloaded or out of resources, or the connection to it may be failing. Try again in a moment.',
    );
    this.name = 'CommandTimeoutError';
  }
}

/** `result` itself, or a `CommandTimeoutError` when the command was given up on. */
export function requireAnswer(result: ExecResult, host: string, timeoutMs: number): ExecResult {
  if (result.timedOut) throw new CommandTimeoutError(host, timeoutMs);
  return result;
}

const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** How long a tunnel or a command stream may take to open before the server counts as stuck. */
const OPEN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 32 * 1024;
const SFTP_TIMEOUT_MS = 30_000;
/** Writes `uploadFile` keeps in flight at once, so a slow link is not waited on for every chunk. */
const UPLOAD_WRITES_IN_FLIGHT = 16;
/** A big upload on a slow link may take hours, so only a request that gets no answer fails it. */
const UPLOAD_STALL_MS = 60_000;
/** A site file the web server can read. */
const DEFAULT_FILE_MODE = 0o644;
/** The SFTP status for a path that is not there (SSH_FX_NO_SUCH_FILE). */
const NO_SUCH_FILE = 2;
/** What `mktemp -d -t agentmate.XXXXXXXXXX` prints: an absolute path ending in that name. */
const STAGING_DIRECTORY = /^\/[^\s'"]*\/agentmate\.[A-Za-z0-9]{6,}$/;
const TRUNCATED = '\n[output truncated]\n';

class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;
  private readonly decoder = new StringDecoder('utf8');

  constructor(
    private readonly limit: number,
    private readonly onText?: (text: string) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.onText) {
      const text = this.decoder.write(chunk);
      if (text) this.onText(text);
    }
    if (this.truncated) return;
    const room = this.limit - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = this.limit;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    const text = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${text}${TRUNCATED}` : text;
  }
}

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`;
}

function describeTarget(target: TunnelTarget): string {
  return 'socketPath' in target ? target.socketPath : `${target.host}:${target.port}`;
}

/** An SFTP callback as a promise. */
function sftpCall<T>(start: (done: (error: Error | null | undefined, value: T) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    start((error, value) => (error ? reject(error) : resolve(value)));
  });
}

function toEntry(name: string, attrs: Stats): SftpEntry {
  return {
    name,
    isDirectory: attrs.isDirectory(),
    isFile: attrs.isFile(),
    size: attrs.size ?? 0,
    // SFTP version 3 only has whole seconds.
    mtimeMs: (attrs.mtime ?? 0) * 1000,
  };
}

function toStat(attrs: Stats): SftpStat {
  return {
    isDirectory: attrs.isDirectory(),
    isFile: attrs.isFile(),
    size: attrs.size ?? 0,
    mtimeMs: (attrs.mtime ?? 0) * 1000,
    mode: (attrs.mode ?? 0) & 0o7777,
  };
}

function isNoSuchFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === NO_SUCH_FILE;
}

/** An SFTP request whose callback carries no value, as a promise. */
function sftpDone(start: (done: (error?: Error | null) => void) => void): Promise<void> {
  return sftpCall<void>((done) => start((error) => done(error, undefined)));
}

/**
 * An OpenSSH extension request, or false when the server did not advertise it: ssh2 throws at
 * once in that case instead of calling back.
 */
function sftpExtension(start: (done: (error?: Error | null) => void) => void): Promise<boolean> {
  return new Promise((resolve, reject) => {
    try {
      start((error) => (error ? reject(error) : resolve(true)));
    } catch {
      resolve(false);
    }
  });
}

export class SshConnection {
  private closed = false;
  private sftpSession: Promise<SFTPWrapper> | null = null;
  /**
   * Rejects when the connection ends. ssh2 never calls back SFTP requests that were in flight
   * when the connection dropped, so every step of an upload races against this.
   */
  private readonly closedSignal: Promise<never>;
  private signalClosed: (error: Error) => void = () => undefined;

  private constructor(
    private readonly client: Client,
    readonly endpoint: SshEndpoint,
  ) {
    this.closedSignal = new Promise<never>((_resolve, reject) => {
      this.signalClosed = reject;
    });
    // Nobody may be racing against it when it fires; that is not an unhandled rejection.
    this.closedSignal.catch(() => undefined);
  }

  static async open(endpoint: SshEndpoint, hooks: SshConnectionHooks = {}): Promise<SshConnection> {
    const { config, verdict } = await buildConnectConfig(endpoint, {
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    });
    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        client.end();
        reject(friendlyConnectError(error, endpoint, verdict));
      };
      client.once('error', onError);
      client.once('ready', () => {
        client.off('error', onError);
        resolve();
      });
      client.connect(config);
    });

    const connection = new SshConnection(client, endpoint);
    // After the handshake, a failure ends the connection and 'close' reports it.
    client.on('error', () => undefined);
    client.on('close', () => {
      connection.markClosed();
      hooks.onClose?.();
    });
    if (verdict.trustedFingerprint) hooks.onHostKeyTrusted?.(verdict.trustedFingerprint);
    return connection;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.assertOpen();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    // The clock runs from the request, so a server that never takes the command cannot hang this.
    const channel = await this.openChannel<ClientChannel>(
      (done) => this.client.exec(command, done),
      timeoutMs,
    );
    if (!channel) {
      return { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: true };
    }

    return new Promise((resolve) => {
      const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const stdout = new OutputCollector(limit, options.onStdout);
      const stderr = new OutputCollector(limit, options.onStderr);
      let exitCode: number | null = null;
      let signal: string | null = null;
      let timedOut = false;
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: stdout.text(),
          stderr: stderr.text(),
          exitCode: timedOut ? null : exitCode,
          signal,
          timedOut,
        });
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          channel.close();
          finish();
        },
        Math.max(0, timeoutMs - (Date.now() - started)),
      );

      channel.on('data', (chunk: Buffer) => stdout.push(chunk));
      channel.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      channel.on('exit', (code: number | null, signalName?: string) => {
        exitCode = code ?? null;
        signal = signalName ?? null;
      });
      // A command that finishes at once can have its exit status parsed in the same burst as the
      // exec reply, before this listener exists. ssh2 repeats the status on 'close', which only
      // fires once the buffered output has been read, so it cannot be missed there.
      channel.on('close', (code?: number | null, signalName?: string) => {
        if (exitCode === null && typeof code === 'number') exitCode = code;
        if (signal === null && typeof signalName === 'string') signal = signalName;
        finish();
      });

      if (options.stdin !== undefined && options.stdin.length > 0) channel.end(options.stdin);
      else channel.end();
    });
  }

  /**
   * A command's stdin and stdout as one two-way stream, for long-lived conversations such as the
   * core's `bridge`. Whatever the command writes to stderr is left out of the stream.
   */
  async openExecStream(command: string, options: { timeoutMs?: number } = {}): Promise<Duplex> {
    this.assertOpen();
    const timeoutMs = options.timeoutMs ?? OPEN_TIMEOUT_MS;
    const channel = await this.openChannel<ClientChannel>(
      (done) => this.client.exec(command, done),
      timeoutMs,
    );
    if (!channel) {
      throw new Error(
        `The command did not start within ${seconds(timeoutMs)} on ${this.endpoint.host}.`,
      );
    }
    return channel;
  }

  /** A byte stream to a Unix socket or TCP port on the server, carried inside this connection. */
  async openStream(target: TunnelTarget, options: { timeoutMs?: number } = {}): Promise<Duplex> {
    this.assertOpen();
    const timeoutMs = options.timeoutMs ?? OPEN_TIMEOUT_MS;
    let channel: ClientChannel | null;
    try {
      channel = await this.openChannel<ClientChannel>((done) => {
        if ('socketPath' in target)
          this.client.openssh_forwardOutStreamLocal(target.socketPath, done);
        else this.client.forwardOut('127.0.0.1', 0, target.host, target.port, done);
      }, timeoutMs);
    } catch (error) {
      if (this.closed) throw error;
      const refusal = error as Error & { reason?: unknown };
      throw new TunnelRefusedError(
        `Could not open a tunnel to ${describeTarget(target)} on ${this.endpoint.host}: ` +
          `${refusal.message}`,
        refusal.reason,
      );
    }
    // No answer at all is not a refusal, so it must not send the caller to the bridge instead.
    if (!channel) {
      throw new Error(
        `The tunnel to ${describeTarget(target)} on ${this.endpoint.host} did not open within ` +
          `${seconds(timeoutMs)}.`,
      );
    }
    return channel;
  }

  /**
   * Writes `content` to `remotePath` so that the path either keeps its old contents or holds the
   * complete new file, never a partial one: a temporary name first, fsync, then an atomic rename.
   * SFTP runs as the login user, so the target folder must be one that user can write to.
   */
  async upload(content: Buffer, remotePath: string, options: UploadOptions = {}): Promise<void> {
    const sftp = await this.untilClosed(this.sftp());
    const partial = `${remotePath}.${randomUUID()}.partial`;
    try {
      const handle = await this.untilClosed(
        new Promise<Buffer>((resolve, reject) => {
          sftp.open(partial, 'w', { mode: options.mode ?? 0o600 }, (error, result) =>
            error ? reject(error) : resolve(result),
          );
        }),
      );
      try {
        for (let offset = 0; offset < content.length; offset += UPLOAD_CHUNK_BYTES) {
          const length = Math.min(UPLOAD_CHUNK_BYTES, content.length - offset);
          await this.untilClosed(
            new Promise<void>((resolve, reject) => {
              sftp.write(handle, content, offset, length, offset, (error) =>
                error ? reject(error) : resolve(),
              );
            }),
          );
          options.onProgress?.(offset + length, content.length);
        }
        await this.untilClosed(
          new Promise<void>((resolve, reject) => {
            sftp.ext_openssh_fsync(handle, (error) => (error ? reject(error) : resolve()));
          }),
        );
      } finally {
        if (this.isOpen) {
          await this.untilClosed(
            new Promise<void>((resolve) => sftp.close(handle, () => resolve())),
          ).catch(() => undefined);
        }
      }
      await this.untilClosed(
        new Promise<void>((resolve, reject) => {
          sftp.ext_openssh_rename(partial, remotePath, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
      );
    } catch (error) {
      if (this.isOpen) {
        await this.untilClosed(
          new Promise<void>((resolve) => sftp.unlink(partial, () => resolve())),
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * A fresh folder in the server's temp directory, owned by the login user. The answer must look
   * like the folder mktemp was asked for, because callers remove it again with `rm -rf`.
   */
  async createStagingDirectory(): Promise<string> {
    const result = await this.exec('mktemp -d -t agentmate.XXXXXXXXXX', { timeoutMs: 30_000 });
    const path = result.stdout.trim();
    if (result.exitCode !== 0 || !STAGING_DIRECTORY.test(path)) {
      throw new Error(
        `Could not create a staging folder on ${this.endpoint.host}: ${result.stderr.trim()}`,
      );
    }
    return path;
  }

  /**
   * A folder's entries with their size and mtime, read over SFTP as the login user. Links are
   * followed, and one that leads nowhere is left out. Rejects when the folder is missing.
   */
  sftpList(dir: string, options: SftpOptions = {}): Promise<SftpEntry[]> {
    return this.sftpOp(`Listing ${dir}`, options, async (sftp) => {
      const list = await sftpCall<FileEntryWithStats[]>((done) => sftp.readdir(dir, done));
      const entries = await Promise.all(
        list.map(async ({ filename, attrs }): Promise<SftpEntry | null> => {
          if (!attrs.isSymbolicLink()) return toEntry(filename, attrs);
          const path = `${dir.replace(/\/+$/, '')}/${filename}`;
          try {
            return toEntry(filename, await sftpCall<Stats>((done) => sftp.stat(path, done)));
          } catch {
            return null;
          }
        }),
      );
      return entries.filter((entry): entry is SftpEntry => entry !== null);
    });
  }

  /**
   * Up to `length` bytes of a file from `start`. Fewer come back when the file ends sooner,
   * including a file that shrank since it was listed.
   */
  sftpReadRange(
    path: string,
    start: number,
    length: number,
    options: SftpOptions = {},
  ): Promise<Buffer> {
    return this.sftpOp(`Reading ${path}`, options, async (sftp) => {
      const handle = await sftpCall<Buffer>((done) => sftp.open(path, 'r', done));
      try {
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          // ssh2 splits a read bigger than the server's limit and reports the end of the file
          // as zero bytes, so a short answer only means "go on from here".
          const bytes = await sftpCall<number>((done) =>
            sftp.read(handle, buffer, filled, length - filled, start + filled, done),
          );
          if (!bytes) break;
          filled += bytes;
        }
        return buffer.subarray(0, filled);
      } finally {
        if (this.isOpen) {
          await this.untilClosed(
            new Promise<void>((resolve) => sftp.close(handle, () => resolve())),
          ).catch(() => undefined);
        }
      }
    });
  }

  /** The absolute form of `path` on the server. `.` is the login user's home folder. */
  sftpRealpath(path: string, options: SftpOptions = {}): Promise<string> {
    return this.sftpOp(`Resolving ${path}`, options, (sftp) =>
      sftpCall<string>((done) => sftp.realpath(path, done)),
    );
  }

  /** Size, mtime and mode of `path`, or null when nothing is there. */
  sftpStat(path: string, options: SftpOptions = {}): Promise<SftpStat | null> {
    return this.sftpOp(`Reading ${path}`, options, async (sftp) => {
      try {
        return toStat(await sftpCall<Stats>((done) => sftp.stat(path, done)));
      } catch (error) {
        if (isNoSuchFile(error)) return null;
        throw error;
      }
    });
  }

  /** Makes one folder. Fails when it is already there or its parent is missing. */
  sftpMkdir(path: string, options: SftpOptions & { mode?: number } = {}): Promise<void> {
    return this.sftpOp(`Creating ${path}`, options, (sftp) =>
      sftpDone((done) => sftp.mkdir(path, { mode: options.mode ?? 0o755 }, done)),
    );
  }

  /** Removes an empty folder. */
  sftpRmdir(path: string, options: SftpOptions = {}): Promise<void> {
    return this.sftpOp(`Removing ${path}`, options, (sftp) =>
      sftpDone((done) => sftp.rmdir(path, done)),
    );
  }

  sftpUnlink(path: string, options: SftpOptions = {}): Promise<void> {
    return this.sftpOp(`Removing ${path}`, options, (sftp) =>
      sftpDone((done) => sftp.unlink(path, done)),
    );
  }

  sftpChmod(path: string, mode: number, options: SftpOptions = {}): Promise<void> {
    return this.sftpOp(`Changing the mode of ${path}`, options, (sftp) =>
      sftpDone((done) => sftp.chmod(path, mode, done)),
    );
  }

  /** A plain SFTP rename, which most servers refuse when `to` already exists. */
  sftpRename(from: string, to: string, options: SftpOptions = {}): Promise<void> {
    return this.sftpOp(`Renaming ${from}`, options, (sftp) =>
      sftpDone((done) => sftp.rename(from, to, done)),
    );
  }

  /**
   * Whether the server advertised an SFTP extension, such as `posix-rename@openssh.com`. ssh2
   * keeps what the server's version reply listed and has no public way to ask for it.
   */
  sftpSupports(extension: string, options: SftpOptions = {}): Promise<boolean> {
    return this.sftpOp(`Starting SFTP`, options, async (sftp) => {
      const listed = (sftp as unknown as { _extensions?: Record<string, unknown> })._extensions;
      return Boolean(listed && Object.hasOwn(listed, extension));
    });
  }

  /**
   * Sends a local file to `remotePath` for a site deploy (E23). Unlike `upload`, it streams from
   * disk with several writes in flight, hashes the bytes as they go, and gives a new file the
   * mode a web server needs. The bytes go to `<name>.agentmate-<8 hex>.part` in the same folder
   * first and only take the real name when their hash is the one expected, so the target keeps
   * its old contents after a failure, a cancel or a file edited mid-upload.
   *
   * Servers without OpenSSH's posix-rename cannot rename onto an existing file; there the old
   * file is moved aside to `<name>.agentmate-<8 hex>.old` first, deleted once the new one is in
   * place (or put back when it cannot be), and the result says the replace was not atomic. Only a request that
   * goes unanswered for `stallTimeoutMs` fails the upload; the whole of it has no deadline.
   */
  async uploadFile(
    localPath: string,
    remotePath: string,
    options: UploadFileOptions,
  ): Promise<UploadFileResult> {
    const { signal } = options;
    const stallMs = options.stallTimeoutMs ?? UPLOAD_STALL_MS;
    const cancelled = (): Error =>
      filesError('cancelled', `The upload of ${remotePath} was cancelled.`);
    if (signal?.aborted) throw cancelled();
    const sftp = await this.untilClosed(this.sftp());

    let stopListening = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      const onAbort = (): void => reject(cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
      stopListening = () => signal.removeEventListener('abort', onAbort);
    });
    aborted.catch(() => undefined);
    const step = <T>(work: Promise<T>): Promise<T> =>
      this.withStallTimeout(work, remotePath, stallMs, aborted);
    const statOrNull = (path: string): Promise<SftpStat | null> =>
      step(sftpCall<Stats>((done) => sftp.stat(path, done))).then(toStat, (error: unknown) => {
        if (isNoSuchFile(error)) return null;
        throw error;
      });

    const part = `${remotePath}.agentmate-${randomBytes(4).toString('hex')}.part`;
    let handle: Buffer | null = null;
    let partExists = false;
    let existing: SftpStat | null = null;
    try {
      existing = await statOrNull(remotePath);
      const mode = options.mode ?? existing?.mode ?? DEFAULT_FILE_MODE;
      handle = await step(sftpCall<Buffer>((done) => sftp.open(part, 'w', { mode }, done)));
      partExists = true;
      const open = handle;

      const hash = createHash('sha256');
      const stream = createReadStream(localPath, { highWaterMark: UPLOAD_CHUNK_BYTES });
      const pending = new Set<Promise<void>>();
      let failure: unknown = null;
      let position = 0;
      let sent = 0;
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          if (signal?.aborted) throw cancelled();
          hash.update(chunk);
          const offset = position;
          position += chunk.length;
          const write: Promise<void> = step(
            sftpDone((done) => sftp.write(open, chunk, 0, chunk.length, offset, done)),
          ).then(
            () => {
              sent += chunk.length;
              options.onProgress?.(sent);
            },
            (error: unknown) => {
              failure ??= error;
            },
          );
          pending.add(write);
          void write.then(() => pending.delete(write));
          while (pending.size >= UPLOAD_WRITES_IN_FLIGHT && !failure) {
            await Promise.race(pending);
          }
          if (failure) throw failure;
        }
        await Promise.all(pending);
        if (failure) throw failure;
      } finally {
        stream.destroy();
      }

      if (hash.digest('hex') !== options.expectedSha256) {
        throw filesError(
          'localChanged',
          `${localPath} changed while it was being sent, so ${remotePath} was left as it was.`,
        );
      }
      await step(sftpExtension((done) => sftp.ext_openssh_fsync(open, done)));
      handle = null;
      await step(sftpDone((done) => sftp.close(open, done)));
      // The server's umask applies to the mode given at open, so set it outright.
      await step(sftpDone((done) => sftp.chmod(part, mode, done)));

      // The last chance to cancel. Once the rename is sent the server finishes it whatever we do,
      // so from here the upload runs to the end and is reported: a cancel that gave up on it
      // would leave a new file on the server that the deploy never recorded.
      if (signal?.aborted) throw cancelled();
      const commit = <T>(work: Promise<T>): Promise<T> =>
        this.withStallTimeout(work, remotePath, stallMs);
      const statAfter = (path: string): Promise<SftpStat | null> =>
        commit(sftpCall<Stats>((done) => sftp.stat(path, done))).then(toStat, (error: unknown) => {
          if (isNoSuchFile(error)) return null;
          throw error;
        });
      let atomic = true;
      const renamed = await commit(
        sftpExtension((done) => sftp.ext_openssh_rename(part, remotePath, done)),
      );
      if (!renamed) {
        try {
          await commit(sftpDone((done) => sftp.rename(part, remotePath, done)));
        } catch (error) {
          if (!(await statAfter(remotePath))) throw error;
          // The old file moves aside rather than going, so it can come back if the part cannot
          // take its name. A later deploy restores a backup whose file is missing.
          const backup = `${remotePath}.agentmate-${randomBytes(4).toString('hex')}.old`;
          await commit(sftpDone((done) => sftp.rename(remotePath, backup, done)));
          try {
            await commit(sftpDone((done) => sftp.rename(part, remotePath, done)));
          } catch (failed) {
            // Until the old file is back, the part is the only copy of the new one: keep it.
            partExists = false;
            await commit(sftpDone((done) => sftp.rename(backup, remotePath, done)));
            partExists = true;
            throw failed;
          }
          await commit(sftpDone((done) => sftp.unlink(backup, done))).catch(() => undefined);
          atomic = false;
        }
      }
      partExists = false;

      const stat = await statAfter(remotePath);
      if (!stat) throw new Error(`${remotePath} was not there right after it was sent.`);
      return { stat, atomic, replaced: existing !== null };
    } catch (error) {
      // Cleaning up must not wait on the cancel that may have caused the failure.
      const tidy = <T>(work: Promise<T>) =>
        this.withStallTimeout(work, remotePath, stallMs).catch(() => undefined);
      const left = handle;
      if (left && this.isOpen) await tidy(sftpDone((done) => sftp.close(left, done)));
      if (partExists && this.isOpen) await tidy(sftpDone((done) => sftp.unlink(part, done)));
      throw error;
    } finally {
      stopListening();
    }
  }

  close(): void {
    if (this.closed) return;
    this.markClosed();
    this.client.end();
  }

  /** Safe to call twice: close() calls it, and so does the 'close' event that follows. */
  private markClosed(): void {
    this.closed = true;
    this.sftpSession = null;
    this.signalClosed(new Error(`The SSH connection to ${this.endpoint.host} closed.`));
  }

  private untilClosed<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.closedSignal]);
  }

  /**
   * Opens a channel, or gives up after `timeoutMs` with null. A channel that opens after that is
   * closed right away, and a connection that ends meanwhile fails the wait.
   */
  private openChannel<T extends { close(): unknown }>(
    open: (done: (error: Error | undefined, channel: T) => void) => void,
    timeoutMs: number,
  ): Promise<T | null> {
    return this.untilClosed(
      new Promise<T | null>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          resolve(null);
        }, timeoutMs);
        open((error, channel) => {
          if (settled) {
            if (!error) channel.close();
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(channel);
        });
      }),
    );
  }

  /**
   * Runs one SFTP operation against its own deadline. The closed signal only covers a connection
   * that ends; a server that stops answering one request would otherwise hang it forever.
   */
  private async sftpOp<T>(
    what: string,
    options: SftpOptions,
    work: (sftp: SFTPWrapper) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? SFTP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${what} on ${this.endpoint.host} did not answer within ${seconds(timeoutMs)}.`,
            ),
          ),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([
        this.untilClosed(this.sftp().then((sftp) => work(sftp))),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One request of a long upload: it fails when the server leaves it unanswered for `stallMs`,
   * when the connection ends, or when `aborted` rejects.
   */
  private withStallTimeout<T>(
    work: Promise<T>,
    remotePath: string,
    stallMs: number,
    aborted?: Promise<never>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            filesError(
              'timeout',
              `Sending ${remotePath}: ${this.endpoint.host} stopped answering for ` +
                `${seconds(stallMs)}.`,
            ),
          ),
        stallMs,
      );
    });
    const racers = aborted
      ? [this.untilClosed(work), stalled, aborted]
      : [this.untilClosed(work), stalled];
    return Promise.race(racers).finally(() => clearTimeout(timer));
  }

  private sftp(): Promise<SFTPWrapper> {
    this.assertOpen();
    if (!this.sftpSession) {
      const session = new Promise<SFTPWrapper>((resolve, reject) => {
        this.client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
      });
      this.sftpSession = session;
      // A failed start is not kept: the connection is shared, so the next caller tries again.
      session.catch(() => {
        if (this.sftpSession === session) this.sftpSession = null;
      });
    }
    return this.sftpSession;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`The SSH connection to ${this.endpoint.host} is closed.`);
  }
}
