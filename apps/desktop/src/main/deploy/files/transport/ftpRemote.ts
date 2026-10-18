import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isIP, type Socket } from 'node:net';
import { pipeline, type Readable, Transform } from 'node:stream';
import type { ConnectionOptions, PeerCertificate, TLSSocket } from 'node:tls';
import { Client, type FileInfo, type FTPResponse } from 'basic-ftp';
import { filesErrorCode } from '../../../../shared/deployFilesErrors';
import type { FilesCertificateInfo } from '../../../../shared/deployFilesTypes';
import type { FilesConnectTarget } from '../types';
import { FilesTransportError } from './errors';
import { backupPathFor, joinRemote, normalizeRemote, parentOf, partPathFor } from './remotePath';
import type { RemoteCapabilities, RemoteEntry, RemoteFiles, RemoteStat } from './types';

/**
 * FTP and FTPS sites (E23) over basic-ftp. FTP has its quirks, and this is where they are dealt
 * with:
 * - one command at a time per connection, so every call waits its turn on a mutex;
 * - basic-ftp's `ensureDir` moves the working folder, so folders are made with one absolute MKD
 *   each, and every other call names absolute paths too;
 * - only MLSD listings carry reliable times; without it a time is asked per file with MDTM;
 * - the only way to stop a transfer is to close the connection, so a cancel does that and the
 *   next call logs in again.
 *
 * FTPS is explicit TLS (AUTH TLS) with the certificate checked before the password is sent. A
 * certificate that fails the checks is only accepted when it is the one the user pinned, compared
 * by its SHA-256 fingerprint on the control connection and on every data connection.
 */

/** The part of basic-ftp's `Client` this transport uses, so tests can stand in for it. */
export interface FtpClient {
  readonly closed: boolean;
  readonly ftp: {
    socket: Socket | TLSSocket;
    tlsOptions: ConnectionOptions;
    dataSocket: Socket | TLSSocket | undefined;
  };
  connect(host?: string, port?: number): Promise<FTPResponse>;
  useTLS(options?: ConnectionOptions, command?: string): Promise<FTPResponse>;
  login(user?: string, password?: string): Promise<FTPResponse>;
  useDefaultSettings(): Promise<void>;
  send(command: string): Promise<FTPResponse>;
  sendIgnoringError(command: string): Promise<FTPResponse>;
  features(): Promise<Map<string, string>>;
  pwd(): Promise<string>;
  cd(path: string): Promise<FTPResponse>;
  list(path?: string): Promise<FileInfo[]>;
  size(path: string): Promise<number>;
  lastMod(path: string): Promise<Date>;
  uploadFrom(source: Readable | string, toRemotePath: string): Promise<FTPResponse>;
  rename(srcPath: string, destPath: string): Promise<FTPResponse>;
  remove(path: string): Promise<FTPResponse>;
  removeEmptyDir(path: string): Promise<FTPResponse>;
  close(): void;
}

export type FtpClientFactory = (timeoutMs: number) => FtpClient;

export interface FtpOpenOptions {
  createClient?: FtpClientFactory;
  signal?: AbortSignal;
}

interface FtpLogin {
  protocol: 'ftp' | 'ftps';
  host: string;
  port: number;
  username: string;
  password: string;
  /** Normalized: lowercase hex without colons. */
  tlsPin: string | null;
  tlsServername: string | null;
}

interface Session {
  mlst: boolean;
  mdtm: boolean;
  loginDir: string;
}

/** The part of a TLS socket the certificate checks read. */
interface TlsSocketLike {
  authorized: boolean;
  authorizationError?: unknown;
  getPeerCertificate(): PeerCertificate;
  isSessionReused?(): boolean;
  prependOnceListener(event: 'secureConnect', listener: () => void): unknown;
  destroy(error?: Error): unknown;
}

const TIMEOUT_MS = 30_000;
const defaultClient: FtpClientFactory = (timeoutMs) => new Client(timeoutMs);

const isFtpReply = (error: unknown): error is Error & { code: number } =>
  typeof (error as { code?: unknown } | null)?.code === 'number';
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const PERMISSION = /permission|denied|not allowed|forbidden|access/i;
const MISSING = /no such|not found|does not exist|can't find|cannot find|not a directory/i;

/** `AB:CD:...` or `abcd...` as 64 lowercase hex digits. */
export function normalizeFingerprint(value: string): string {
  return value.replace(/:/g, '').toLowerCase();
}

function fingerprintOf(certificate: PeerCertificate | null | undefined): string {
  return normalizeFingerprint(certificate?.fingerprint256 ?? '');
}

function formatName(name: Record<string, string | string[]> | undefined): string {
  return Object.entries(name ?? {})
    .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${key}=${v}`))
    .join(', ');
}

function reasonOf(authorizationError: unknown): FilesCertificateInfo['reason'] {
  const code =
    typeof authorizationError === 'string'
      ? authorizationError
      : ((authorizationError as { code?: string } | null)?.code ?? messageOf(authorizationError));
  if (/SELF_SIGNED/.test(code)) return 'selfSigned';
  if (/ALTNAME|HOSTNAME|IP_MISMATCH/i.test(code)) return 'nameMismatch';
  if (/EXPIRED/.test(code)) return 'expired';
  return 'untrusted';
}

/**
 * What the user is shown about a certificate before trusting it. `reason` comes from Node's
 * check of it; a certificate that passed every check reads as `untrusted` since nothing failed.
 */
export function certificateInfo(
  certificate: PeerCertificate,
  authorizationError: unknown,
): FilesCertificateInfo {
  const subject = certificate.subject as unknown as Record<string, string | string[]>;
  const alternative = (certificate.subjectaltname ?? '')
    .split(/,\s*/)
    .filter((entry) => /^(DNS|IP Address):/.test(entry))
    .map((entry) => entry.slice(entry.indexOf(':') + 1));
  const commonName = subject?.CN;
  return {
    fingerprint256: fingerprintOf(certificate),
    subject: formatName(subject),
    issuer: formatName(certificate.issuer as unknown as Record<string, string | string[]>),
    names:
      alternative.length > 0
        ? alternative
        : (Array.isArray(commonName) ? commonName : [commonName]).filter(Boolean),
    validTo: certificate.valid_to,
    reason: reasonOf(authorizationError),
  };
}

/**
 * A `checkServerIdentity` that accepts only the pinned certificate, whatever names it carries.
 * Node only calls it once the chain checks out, so for a self-signed certificate the pin is
 * compared again on the socket itself (see `login` and `guardDataSockets`).
 */
export function pinnedIdentityCheck(
  pin: string,
): (host: string, certificate: PeerCertificate) => Error | undefined {
  const expected = normalizeFingerprint(pin);
  return (_host, certificate) =>
    fingerprintOf(certificate) === expected
      ? undefined
      : new Error('The server presented a certificate other than the one you trusted.');
}

/**
 * Checks the pin on every data connection basic-ftp opens. With `rejectUnauthorized` off for a
 * pinned certificate, nothing else would look at it, so this hooks the context's `dataSocket` and
 * closes a TLS socket whose certificate is not the pinned one before any data goes through it. A
 * resumed session was set up with the control connection's (checked) server, so it passes.
 */
export function guardDataSockets(ftp: { dataSocket: unknown }, pin: string): void {
  const expected = normalizeFingerprint(pin);
  let owner: object | null = ftp;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, 'dataSocket');
    if (!descriptor) owner = Object.getPrototypeOf(owner);
  }
  let stored: unknown = descriptor?.value;
  const { get, set } = descriptor ?? {};
  Object.defineProperty(ftp, 'dataSocket', {
    configurable: true,
    enumerable: true,
    get: get ? () => get.call(ftp) : () => stored,
    set: (socket: unknown) => {
      if (socket && typeof (socket as TlsSocketLike).getPeerCertificate === 'function') {
        const tls = socket as TlsSocketLike;
        tls.prependOnceListener('secureConnect', () => {
          if (tls.isSessionReused?.()) return;
          if (fingerprintOf(tls.getPeerCertificate()) !== expected) {
            // Coded like the control connection's refusal, so a run breaks off on it.
            tls.destroy(
              new FilesTransportError(
                'tlsUntrusted',
                'The data connection presented a certificate other than the one you trusted.',
              ),
            );
          }
        });
      }
      if (set) set.call(ftp, socket);
      else stored = socket;
    },
  });
}

function refusal(error: unknown, what: string): FilesTransportError {
  const message = messageOf(error);
  return PERMISSION.test(message)
    ? new FilesTransportError('permissionDenied', `The server refused ${what}: ${message}`)
    : new FilesTransportError('server', `The server refused ${what}: ${message}`);
}

/** An FTP failure as a coded error. */
export function mapFtpError(error: unknown, path: string): Error {
  if (filesErrorCode(error)) return error as Error;
  const message = messageOf(error);
  if (isFtpReply(error)) {
    const { code } = error;
    if (code === 530) return new FilesTransportError('auth', 'The server refused the login.');
    if (code === 421 || code === 425 || code === 426) {
      return new FilesTransportError('unreachable', `The server closed the connection: ${message}`);
    }
    if (code === 452 || code === 552) {
      return new FilesTransportError('diskFull', `The server has no room left for ${path}.`);
    }
    if (PERMISSION.test(message)) {
      return new FilesTransportError('permissionDenied', `The server refused access to ${path}.`);
    }
    if (MISSING.test(message)) {
      return new FilesTransportError('remoteFolderMissing', `${path} is not on the server.`);
    }
    return new FilesTransportError('server', `The server could not work on ${path}: ${message}`);
  }
  const nodeCode = String((error as { code?: unknown } | null)?.code ?? '');
  if (/ALTNAME/.test(nodeCode) || /ALTNAME/.test(message)) {
    return new FilesTransportError('tlsNameMismatch', `The certificate does not match: ${message}`);
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS/.test(nodeCode)) {
    return new FilesTransportError('tlsUntrusted', `The certificate is not trusted: ${message}`);
  }
  if (/Timeout|timed out|ETIMEDOUT/i.test(message) || nodeCode === 'ETIMEDOUT') {
    return new FilesTransportError('timeout', `The server stopped answering (${path}).`);
  }
  if (
    ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE'].includes(
      nodeCode,
    ) ||
    /closed|FIN packet|socket hang up/i.test(message)
  ) {
    return new FilesTransportError(
      'unreachable',
      `The connection to the server failed: ${message}`,
    );
  }
  return new FilesTransportError('server', `The server could not work on ${path}: ${message}`);
}

function toLogin(target: FilesConnectTarget): FtpLogin {
  if (target.login.kind !== 'custom' || target.protocol === 'sftp') {
    throw new FilesTransportError('invalidInput', 'FTP and FTPS sites need a login of their own.');
  }
  const { login } = target;
  return {
    protocol: target.protocol,
    host: login.host,
    port: login.port,
    username: login.username,
    password: login.secret ?? '',
    tlsPin: login.tlsPin ? normalizeFingerprint(login.tlsPin) : null,
    tlsServername: login.tlsServername,
  };
}

function tlsBase(login: FtpLogin): ConnectionOptions {
  // An IP address is no server name: Node refuses it for SNI and checks it as the host instead.
  const servername = login.tlsServername ?? (isIP(login.host) ? undefined : login.host);
  return { host: login.host, ...(servername ? { servername } : {}) };
}

/** AUTH TLS on a connected client, with nothing refused yet: the caller looks at the result. */
async function startTls(client: FtpClient, options: ConnectionOptions): Promise<TlsSocketLike> {
  try {
    await client.useTLS({ ...options, rejectUnauthorized: false });
  } catch (error) {
    if (isFtpReply(error)) {
      throw new FilesTransportError(
        'tlsUnavailable',
        'The server does not offer FTPS (it refused AUTH TLS). Use FTP only if you accept that ' +
          'the password and files travel unencrypted.',
      );
    }
    throw error;
  }
  return client.ftp.socket as unknown as TlsSocketLike;
}

function checkControlCertificate(socket: TlsSocketLike, login: FtpLogin): void {
  const certificate = socket.getPeerCertificate();
  if (!fingerprintOf(certificate)) {
    throw new FilesTransportError('tlsUntrusted', `${login.host} sent no certificate.`);
  }
  const info = certificateInfo(certificate, socket.authorizationError);
  if (login.tlsPin) {
    if (info.fingerprint256 === login.tlsPin) return;
    throw new FilesTransportError(
      'tlsUntrusted',
      `The certificate ${login.host} presented is not the one you trusted. It may have been ` +
        'renewed, or someone may be in the way.',
      { certificate: info },
    );
  }
  if (socket.authorized) return;
  if (info.reason === 'nameMismatch') {
    throw new FilesTransportError(
      'tlsNameMismatch',
      `The certificate of ${login.host} is for ${info.names.join(', ') || 'another name'}.`,
      { certificate: info },
    );
  }
  throw new FilesTransportError(
    'tlsUntrusted',
    `The certificate of ${login.host} is not trusted on this computer.`,
    { certificate: info },
  );
}

/** Connects, checks TLS before the password goes out, logs in and learns the features. */
async function logIn(client: FtpClient, login: FtpLogin): Promise<Session> {
  await client.connect(login.host, login.port);
  if (login.protocol === 'ftps') {
    const base = tlsBase(login);
    const pinned = login.tlsPin
      ? { ...base, checkServerIdentity: pinnedIdentityCheck(login.tlsPin) }
      : base;
    checkControlCertificate(await startTls(client, pinned), login);
    // Data connections take these options; without a pin they are checked by Node as usual.
    client.ftp.tlsOptions = login.tlsPin
      ? { ...pinned, rejectUnauthorized: false }
      : { ...base, rejectUnauthorized: true };
    if (login.tlsPin) guardDataSockets(client.ftp, login.tlsPin);
  }
  // Before the login, so a name or password with non-ASCII letters arrives as UTF-8.
  await client.sendIgnoringError('OPTS UTF8 ON');
  try {
    await client.login(login.username, login.password);
  } catch (error) {
    if (isFtpReply(error) && error.code >= 500 && error.code < 600) {
      throw new FilesTransportError('auth', 'The server refused the username or password.');
    }
    throw error;
  }
  await client.useDefaultSettings();
  const features = await client.features();
  return {
    mlst: features.has('MLST'),
    mdtm: features.has('MDTM'),
    loginDir: normalizeRemote(await client.pwd()),
  };
}

function modeOf(info: FileInfo | undefined): number | null {
  const permissions = info?.permissions;
  if (!permissions) return null;
  return (permissions.user << 6) | (permissions.group << 3) | permissions.world;
}

export interface MlstFacts {
  isDirectory: boolean;
  size: number;
  mtimeMs: number | null;
  mode: number | null;
}

/**
 * The facts of an MLST answer (RFC 3659): `type=file;size=12;modify=20260102030405; /path`.
 * The time is read the way basic-ftp reads MLSD listings, so stat and list agree to the
 * millisecond. Null when the answer carries no fact line.
 */
export function parseMlstReply(message: string): MlstFacts | null {
  const line = message.split(/\r?\n/).find((candidate) => candidate.startsWith(' '));
  if (!line) return null;
  const packed = line.trimStart();
  const space = packed.indexOf(' ');
  const facts = new Map(
    (space < 0 ? packed : packed.slice(0, space))
      .split(';')
      .filter((fact) => fact.includes('='))
      .map((fact) => {
        const equals = fact.indexOf('=');
        return [fact.slice(0, equals).toLowerCase(), fact.slice(equals + 1)] as const;
      }),
  );
  const modify = facts.get('modify') ?? '';
  const mode = facts.get('unix.mode') ?? '';
  return {
    isDirectory: /^(dir|cdir|pdir)$/i.test(facts.get('type') ?? ''),
    size: Number(facts.get('size') ?? facts.get('sizd') ?? 0) || 0,
    mtimeMs: /^\d{14}/.test(modify)
      ? Date.UTC(
          +modify.slice(0, 4),
          +modify.slice(4, 6) - 1,
          +modify.slice(6, 8),
          +modify.slice(8, 10),
          +modify.slice(10, 12),
          +modify.slice(12, 14),
          +modify.slice(15, 18),
        )
      : null,
    mode: /^[0-7]+$/.test(mode) ? Number.parseInt(mode, 8) & 0o777 : null,
  };
}

export async function openFtpRemote(
  target: FilesConnectTarget,
  options: FtpOpenOptions = {},
): Promise<RemoteFiles> {
  const login = toLogin(target);
  const createClient = options.createClient ?? defaultClient;
  const label = `${login.host}:${login.port}`;
  if (options.signal?.aborted) {
    throw new FilesTransportError('cancelled', `Connecting to ${label} was cancelled.`);
  }

  let client: FtpClient | null = null;
  let session: Session | null = null;
  let closed = false;
  let sawSplitReplace = false;
  let queue: Promise<unknown> = Promise.resolve();
  /** Folders known to exist, so a deploy does not ask about the same parent for every file. */
  const knownDirs = new Set<string>();
  /** Modes seen in listings, for keeping a file's mode when it is replaced (LIST servers). */
  const modes = new Map<string, number>();
  /** Part files a cancel left behind; removed as soon as there is a connection again. */
  const leftovers = new Set<string>();

  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  async function connected(): Promise<{ client: FtpClient; session: Session }> {
    if (client && session && !client.closed) return { client, session };
    client?.close();
    client = null;
    const fresh = createClient(TIMEOUT_MS);
    try {
      session = await logIn(fresh, login);
    } catch (error) {
      fresh.close();
      throw mapFtpError(error, label);
    }
    client = fresh;
    for (const part of leftovers) await fresh.remove(part).catch(() => undefined);
    leftovers.clear();
    return { client: fresh, session };
  }

  function op<T>(path: string, work: (client: FtpClient, session: Session) => Promise<T>) {
    return exclusive(async () => {
      if (closed) throw new FilesTransportError('unreachable', 'This FTP connection is closed.');
      const current = await connected();
      try {
        return await work(current.client, current.session);
      } catch (error) {
        throw mapFtpError(error, path);
      }
    });
  }

  async function isDir(ftp: FtpClient, path: string): Promise<boolean> {
    try {
      await ftp.cd(path);
      return true;
    } catch (error) {
      if (isFtpReply(error)) return false;
      throw error;
    }
  }

  async function listInside(ftp: FtpClient, folder: string): Promise<RemoteEntry[] | null> {
    // Some servers answer LIST of a missing folder with an empty listing, so look first.
    if (!(await isDir(ftp, folder))) return null;
    const infos = await ftp.list();
    knownDirs.add(folder);
    return infos
      .filter((info) => info.name !== '.' && info.name !== '..')
      .map((info) => {
        const path = joinRemote(folder, info.name);
        const mode = modeOf(info);
        if (mode !== null) modes.set(path, mode);
        const mtimeMs = info.modifiedAt?.getTime() ?? null;
        return {
          name: info.name,
          path,
          isDirectory: info.isDirectory,
          size: info.size,
          mtimeMs,
          via: mtimeMs === null ? null : ('mlsd' as const),
        };
      });
  }

  async function statInside(ftp: FtpClient, current: Session, path: string) {
    if (current.mlst) {
      let reply: FTPResponse | null = null;
      try {
        reply = await ftp.send(`MLST ${path}`);
      } catch (error) {
        if (!isFtpReply(error)) throw error;
        if (error.code === 550 || error.code === 450) return { stat: null, mode: null };
      }
      const facts = reply ? parseMlstReply(reply.message) : null;
      if (facts) {
        const stat: RemoteStat = {
          isDirectory: facts.isDirectory,
          size: facts.size,
          mtimeMs: facts.mtimeMs,
          via: facts.mtimeMs === null ? null : 'mlsd',
        };
        return { stat, mode: facts.mode };
      }
    }
    let size: number;
    try {
      size = await ftp.size(path);
    } catch (error) {
      if (!isFtpReply(error)) throw error;
      const dir = await isDir(ftp, path);
      return {
        stat: dir ? { isDirectory: true, size: 0, mtimeMs: null, via: null } : null,
        mode: null,
      };
    }
    let mtimeMs: number | null = null;
    if (current.mdtm) {
      try {
        mtimeMs = (await ftp.lastMod(path)).getTime();
      } catch (error) {
        if (!isFtpReply(error)) throw error;
      }
    }
    const stat: RemoteStat = {
      isDirectory: false,
      size,
      mtimeMs: Number.isNaN(mtimeMs) ? null : mtimeMs,
      via: mtimeMs === null || Number.isNaN(mtimeMs) ? null : 'mdtm',
    };
    return { stat, mode: modes.get(path) ?? null };
  }

  /**
   * The mode of a file about to be replaced, or null for a new one or one nobody can tell.
   * Without MLST it takes a fresh listing of the folder, and only when SIZE says the file is
   * there, so a new file costs one command and a mode changed meanwhile is not missed.
   */
  async function modeToKeep(ftp: FtpClient, current: Session, path: string) {
    if (current.mlst) return (await statInside(ftp, current, path)).mode;
    try {
      await ftp.size(path);
    } catch (error) {
      if (isFtpReply(error)) return null;
      throw error;
    }
    await listInside(ftp, parentOf(path) ?? '/');
    return modes.get(path) ?? null;
  }

  const remote: RemoteFiles = {
    protocol: login.protocol,
    maxParallel: 1,

    capabilities: () =>
      op(
        label,
        async (_ftp, current): Promise<RemoteCapabilities> => ({
          atomicReplace: !sawSplitReplace,
          mtime: current.mlst ? 'exact' : current.mdtm ? 'mdtm' : 'none',
        }),
      ),

    realpath: (path) =>
      op(path, async (ftp, current) => {
        if (path === '.') return current.loginDir;
        const absolute = path.startsWith('/')
          ? normalizeRemote(path)
          : joinRemote(current.loginDir, path);
        if (!(await isDir(ftp, absolute))) {
          throw new FilesTransportError('remoteFolderMissing', `${absolute} is not on the server.`);
        }
        return normalizeRemote(await ftp.pwd());
      }),

    list: (dir) => op(dir, (ftp) => listInside(ftp, normalizeRemote(dir))),

    stat: (path) =>
      op(
        path,
        async (ftp, current) => (await statInside(ftp, current, normalizeRemote(path))).stat,
      ),

    ensureDir: (path) =>
      op(path, async (ftp) => {
        const target = normalizeRemote(path);
        if (knownDirs.has(target)) return false;
        // Up from the target to the deepest folder that exists, then one MKD per missing folder.
        const missing: string[] = [];
        let current: string | null = target;
        while (current && !knownDirs.has(current) && !(await isDir(ftp, current))) {
          missing.unshift(current);
          current = parentOf(current);
        }
        if (current) knownDirs.add(current);
        let made = false;
        for (const dir of missing) {
          try {
            await ftp.send(`MKD ${dir}`);
            made = dir === target;
          } catch (error) {
            if (!isFtpReply(error)) throw error;
            // Made by someone else meanwhile is fine; a file in the way or a refusal is not.
            if (!(await isDir(ftp, dir))) throw refusal(error, `to make the folder ${dir}`);
            made = false;
          }
          knownDirs.add(dir);
        }
        return made;
      }),

    putFile: (localPath, remotePath, put) =>
      op(remotePath, async (ftp, current) => {
        const cancelled = () =>
          new FilesTransportError('cancelled', `The upload of ${remotePath} was cancelled.`);
        if (put.signal?.aborted) throw cancelled();
        const target = normalizeRemote(remotePath);
        const part = partPathFor(target);
        const mode = await modeToKeep(ftp, current, target);

        const hash = createHash('sha256');
        let sent = 0;
        const hasher = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            sent += chunk.length;
            put.onBytes?.(sent);
            done(null, chunk);
          },
        });
        pipeline(createReadStream(localPath), hasher, () => undefined);
        // A STOR refused, or a cancel, before the transfer started never reads the file: closing
        // the hasher closes the file with it (pipeline passes the destroy on).
        const letGo = (): void => {
          hasher.destroy();
        };
        const stop = (): void => ftp.close();
        put.signal?.addEventListener('abort', stop, { once: true });
        const removePart = async () => {
          if (ftp.closed) leftovers.add(part);
          else await ftp.remove(part).catch(() => undefined);
        };
        try {
          await ftp.uploadFrom(hasher, part);
        } catch (error) {
          letGo();
          await removePart();
          if (put.signal?.aborted) throw cancelled();
          throw error;
        } finally {
          put.signal?.removeEventListener('abort', stop);
        }
        if (put.signal?.aborted) {
          letGo();
          await removePart();
          throw cancelled();
        }
        if (hash.digest('hex') !== put.sha256) {
          letGo();
          await removePart();
          throw new FilesTransportError(
            'localChanged',
            `${localPath} changed while it was being sent, so ${target} was left as it was.`,
          );
        }

        if (mode !== null) {
          await ftp.sendIgnoringError(`SITE CHMOD ${mode.toString(8).padStart(3, '0')} ${part}`);
        }
        let atomic = true;
        try {
          await ftp.rename(part, target);
        } catch (error) {
          if (!isFtpReply(error) || !(await statInside(ftp, current, target)).stat) {
            await removePart();
            throw error;
          }
          // RNTO onto an existing file is refused here. The old one moves aside rather than
          // going, so a refusal of the second rename can put it back.
          const backup = backupPathFor(target);
          try {
            await ftp.rename(target, backup);
          } catch (aside) {
            await removePart();
            throw aside;
          }
          try {
            await ftp.rename(part, target);
          } catch (failed) {
            // The new file stays as long as the old one is not back: a later run restores it.
            await ftp.rename(backup, target);
            await removePart();
            throw failed;
          }
          await ftp.remove(backup).catch(() => undefined);
          atomic = false;
          sawSplitReplace = true;
        }
        if (mode !== null) modes.set(target, mode);
        const { stat } = await statInside(ftp, current, target);
        return {
          stat: stat ?? { isDirectory: false, size: put.size, mtimeMs: null, via: null },
          atomic,
        };
      }),

    rename: (from, to) =>
      op(from, async (ftp) => {
        await ftp.rename(normalizeRemote(from), normalizeRemote(to));
      }),

    remove: (path) =>
      op(path, async (ftp, current) => {
        const target = normalizeRemote(path);
        try {
          await ftp.remove(target);
        } catch (error) {
          if (!isFtpReply(error)) throw error;
          if ((await statInside(ftp, current, target)).stat)
            throw refusal(error, `to remove ${target}`);
        }
        modes.delete(target);
      }),

    removeEmptyDir: (path) =>
      op(path, async (ftp) => {
        const target = normalizeRemote(path);
        try {
          await ftp.removeEmptyDir(target);
        } catch (error) {
          // FTP answers 550 alike for a folder that is not empty and one that is not there.
          if (isFtpReply(error)) return false;
          throw error;
        }
        knownDirs.delete(target);
        return true;
      }),

    async close() {
      closed = true;
      client?.close();
    },
  };

  const abort = (): void => client?.close();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    await exclusive(connected);
  } catch (error) {
    if (options.signal?.aborted) {
      throw new FilesTransportError('cancelled', `Connecting to ${label} was cancelled.`);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
  return remote;
}

/**
 * The certificate an FTPS server presents, read without logging in, so the user can look at it
 * before trusting it and the trust step can check it is still the same one.
 */
export async function readCertificate(
  target: FilesConnectTarget,
  options: Pick<FtpOpenOptions, 'createClient'> = {},
): Promise<FilesCertificateInfo> {
  const login = toLogin(target);
  const client = (options.createClient ?? defaultClient)(TIMEOUT_MS);
  try {
    await client.connect(login.host, login.port);
    const socket = await startTls(client, tlsBase(login));
    const certificate = socket.getPeerCertificate();
    if (!fingerprintOf(certificate)) {
      throw new FilesTransportError('tlsUntrusted', `${login.host} sent no certificate.`);
    }
    return certificateInfo(certificate, socket.authorizationError);
  } catch (error) {
    throw mapFtpError(error, `${login.host}:${login.port}`);
  } finally {
    client.close();
  }
}
