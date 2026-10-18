import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  Client,
  type ClientChannel,
  type FileEntryWithStats,
  type SFTPWrapper,
  type Stats,
} from 'ssh2';
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
