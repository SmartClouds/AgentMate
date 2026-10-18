import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { ConnectionOptions, PeerCertificate } from 'node:tls';
import { FileInfo, FileType, FTPError, type FTPResponse } from 'basic-ftp';
import type { FtpClient } from '../ftpRemote';
import { normalizeRemote, parentOf } from '../remotePath';

/**
 * A stand-in for basic-ftp's `Client` over an in-memory server, for the FTP transport's tests.
 * It is strict where basic-ftp and real servers are: one task at a time (a second one throws, as
 * basic-ftp does), paths without a leading slash resolve against the working folder, a closed
 * client fails every task, and the TLS checks follow what Node does with `rejectUnauthorized`
 * off (the identity check only runs when the chain is trusted).
 */

export interface FakeTls {
  /** The certificate chain checks out (a real CA). */
  chainTrusted: boolean;
  /** Node's code when it does not, such as `DEPTH_ZERO_SELF_SIGNED_CERT`. */
  chainError?: string;
  /** The names the certificate is for. */
  names: string[];
  fingerprint256: string;
  /** The server answers AUTH TLS with 534. */
  refused?: boolean;
}

export interface FakeFtpServerOptions {
  /** MLST and MLSD (with MDTM). Default true. */
  mlsd?: boolean;
  /** MDTM. Default true. */
  mdtm?: boolean;
  /** RNTO onto an existing file fails with 550, like some Windows servers. */
  renameOverwriteRefused?: boolean;
  /** LIST of a missing folder answers an empty listing, like some vsftpd builds. */
  emptyListForMissing?: boolean;
  password?: string;
  home?: string;
  tls?: FakeTls;
  /** connect() fails with this Node error code. */
  refuseConnect?: string;
}

interface Node {
  dir: boolean;
  data: Buffer;
  mode: number;
  mtimeMs: number;
}

const ok = (code: number, message: string): FTPResponse => ({
  code,
  message: `${code} ${message}`,
});
const fail = (code: number, message: string): FTPError =>
  new FTPError({ code, message: `${code} ${message}` });
const pad = (value: number, size = 2) => String(value).padStart(size, '0');
const mlsTime = (ms: number): string => {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
};

export class FakeTlsSocket extends EventEmitter {
  authorized = false;
  authorizationError: string | undefined;
  destroyed = false;

  constructor(
    readonly certificate: PeerCertificate,
    readonly resumed = false,
  ) {
    super();
  }

  getPeerCertificate(): PeerCertificate {
    return this.certificate;
  }

  isSessionReused(): boolean {
    return this.resumed;
  }

  setTimeout(): this {
    return this;
  }

  /** What the socket was destroyed with, the way basic-ftp would see it fail. */
  destroyError: Error | undefined;

  destroy(error?: Error): this {
    this.destroyed = true;
    this.destroyError = error;
    return this;
  }
}

export function fakeCertificate(tls: Pick<FakeTls, 'names' | 'fingerprint256'>): PeerCertificate {
  return {
    subject: { CN: tls.names[0] ?? 'unknown', O: 'AgentMate Test' },
    issuer: { CN: tls.names[0] ?? 'unknown', O: 'AgentMate Test' },
    subjectaltname: tls.names.map((name) => `DNS:${name}`).join(', '),
    valid_from: 'Jan  1 00:00:00 2026 GMT',
    valid_to: 'Jan  1 00:00:00 2036 GMT',
    fingerprint: '00',
    fingerprint256: tls.fingerprint256,
    fingerprint512: '00',
    serialNumber: '01',
    raw: Buffer.alloc(0),
  } as unknown as PeerCertificate;
}

export function createFakeFtpServer(options: FakeFtpServerOptions = {}) {
  const mlsd = options.mlsd ?? true;
  const mdtm = options.mdtm ?? true;
  const home = options.home ?? '/home/deploy';
  const nodes = new Map<string, Node>();
  const log: string[] = [];
  const clients: FakeFtpClient[] = [];
  let clock = 1_700_000_000_000;
  const dir = (path: string) =>
    nodes.set(path, { dir: true, data: Buffer.alloc(0), mode: 0o755, mtimeMs: clock });
  for (const path of ['/', '/home', home]) dir(path);

  const children = (folder: string) =>
    [...nodes.keys()].filter((path) => path !== folder && parentOf(path) === folder);

  class FakeFtpClient implements FtpClient {
    readonly ftp: FtpClient['ftp'] = {
      socket: new EventEmitter() as never,
      tlsOptions: {},
      dataSocket: undefined,
    };
    tlsOptionsUsed: ConnectionOptions | null = null;
    connected = false;
    shut = false;
    busy = false;
    cwd = '/';

    get closed(): boolean {
      return !this.connected || this.shut;
    }

    resolve(path: string): string {
      return normalizeRemote(path.startsWith('/') ? path : `${this.cwd}/${path}`);
    }

    async task<T>(line: string, work: () => T | Promise<T>): Promise<T> {
      if (this.busy) {
        throw new Error(
          "User launched a task while another one is still running. Forgot to use 'await' or '.then()'?",
        );
      }
      if (this.shut) throw new Error('Client is closed because User closed client');
      this.busy = true;
      log.push(line);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (this.shut) throw new Error('Client is closed because User closed client');
        return await work();
      } finally {
        this.busy = false;
      }
    }

    async connect(host?: string, port?: number): Promise<FTPResponse> {
      log.push(`connect ${host}:${port}`);
      if (options.refuseConnect) {
        throw Object.assign(new Error(`connect ${options.refuseConnect} ${host}:${port}`), {
          code: options.refuseConnect,
        });
      }
      this.connected = true;
      this.shut = false;
      return ok(220, 'Welcome');
    }

    useTLS(tlsOptions: ConnectionOptions = {}): Promise<FTPResponse> {
      return this.task('AUTH TLS', () => {
        const tls = options.tls;
        if (!tls || tls.refused) throw fail(534, 'TLS not available');
        this.tlsOptionsUsed = tlsOptions;
        const certificate = fakeCertificate(tls);
        const socket = new FakeTlsSocket(certificate);
        if (!tls.chainTrusted) {
          socket.authorizationError = tls.chainError ?? 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
        } else {
          const name = tlsOptions.servername ?? tlsOptions.host ?? '';
          const check =
            tlsOptions.checkServerIdentity ??
            ((host: string) =>
              tls.names.includes(host)
                ? undefined
                : Object.assign(new Error('altnames'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }));
          const error = check(name, certificate);
          socket.authorized = !error;
          socket.authorizationError = error
            ? ((error as Error & { code?: string }).code ?? error.message)
            : undefined;
        }
        if (!socket.authorized && tlsOptions.rejectUnauthorized !== false) {
          throw Object.assign(new Error(socket.authorizationError), {
            code: socket.authorizationError,
          });
        }
        this.ftp.socket = socket as never;
        this.ftp.tlsOptions = tlsOptions;
        return ok(234, 'AUTH TLS successful');
      });
    }

    login(user = 'anonymous', password = 'guest'): Promise<FTPResponse> {
      return this.task(`USER ${user}`, () => {
        if (password !== (options.password ?? 'pw')) throw fail(530, 'Login incorrect.');
        this.cwd = home;
        return ok(230, 'Logged in');
      });
    }

    useDefaultSettings(): Promise<void> {
      return this.task('TYPE I', () => undefined);
    }

    send(command: string): Promise<FTPResponse> {
      return this.task(command, () => this.command(command));
    }

    async sendIgnoringError(command: string): Promise<FTPResponse> {
      try {
        return await this.send(command);
      } catch (error) {
        if (error instanceof FTPError) return { code: error.code, message: error.message };
        throw error;
      }
    }

    command(command: string): FTPResponse {
      const [verb, ...rest] = command.split(' ');
      const argument = rest.join(' ');
      if (command === 'OPTS UTF8 ON') return ok(200, 'UTF8 set to on');
      if (verb === 'MKD') {
        const path = this.resolve(argument);
        if (nodes.has(path) || !nodes.get(parentOf(path) ?? '/')?.dir) {
          throw fail(550, `${argument}: File exists`);
        }
        dir(path);
        return ok(257, `"${path}" created`);
      }
      if (verb === 'MLST') {
        if (!mlsd) throw fail(500, 'MLST not understood');
        const path = this.resolve(argument);
        const node = nodes.get(path);
        if (!node) throw fail(550, `${argument}: No such file or directory`);
        const facts =
          `type=${node.dir ? 'dir' : 'file'};size=${node.data.length};` +
          `modify=${mlsTime(node.mtimeMs)};unix.mode=0${node.mode.toString(8)};`;
        return { code: 250, message: `250-Start of list for ${path}\n ${facts} ${path}\n250 End` };
      }
      if (verb === 'SITE' && rest[0] === 'CHMOD') {
        const path = this.resolve(rest.slice(2).join(' '));
        const node = nodes.get(path);
        if (!node) throw fail(550, 'No such file');
        node.mode = Number.parseInt(rest[1], 8);
        return ok(200, 'SITE CHMOD command successful');
      }
      throw fail(500, `${verb} not understood`);
    }

    async features(): Promise<Map<string, string>> {
      return this.task('FEAT', () => {
        const features = new Map<string, string>([
          ['SIZE', ''],
          ['UTF8', ''],
        ]);
        if (mlsd) features.set('MLST', 'type*;size*;modify*;unix.mode*;');
        if (mdtm) features.set('MDTM', '');
        return features;
      });
    }

    pwd(): Promise<string> {
      return this.task('PWD', () => this.cwd);
    }

    cd(path: string): Promise<FTPResponse> {
      return this.task(`CWD ${path}`, () => {
        const target = this.resolve(path);
        if (!nodes.get(target)?.dir) throw fail(550, `${path}: No such file or directory`);
        this.cwd = target;
        return ok(250, 'CWD command successful');
      });
    }

    list(path = ''): Promise<FileInfo[]> {
      return this.task(`${mlsd ? 'MLSD' : 'LIST -a'} ${path}`.trim(), () => {
        const folder = this.resolve(path || this.cwd);
        if (!nodes.get(folder)?.dir) {
          if (options.emptyListForMissing) return [];
          throw fail(450, `${path}: No such file or directory`);
        }
        const entries = children(folder).map((child) => {
          const node = nodes.get(child) as Node;
          const info = new FileInfo(child.slice(child.lastIndexOf('/') + 1));
          info.type = node.dir ? FileType.Directory : FileType.File;
          info.size = node.dir ? 4096 : node.data.length;
          info.rawModifiedAt = new Date(node.mtimeMs).toUTCString();
          if (mlsd) info.modifiedAt = new Date(Math.floor(node.mtimeMs / 1000) * 1000);
          info.permissions = {
            user: (node.mode >> 6) & 7,
            group: (node.mode >> 3) & 7,
            world: node.mode & 7,
          };
          return info;
        });
        if (!mlsd) {
          for (const name of ['.', '..']) {
            const info = new FileInfo(name);
            info.type = FileType.Directory;
            entries.unshift(info);
          }
        }
        return entries;
      });
    }

    size(path: string): Promise<number> {
      return this.task(`SIZE ${path}`, () => {
        const node = nodes.get(this.resolve(path));
        if (!node || node.dir) throw fail(550, `${path}: not a regular file`);
        return node.data.length;
      });
    }

    lastMod(path: string): Promise<Date> {
      return this.task(`MDTM ${path}`, () => {
        if (!mdtm) throw fail(500, 'MDTM not understood');
        const node = nodes.get(this.resolve(path));
        if (!node || node.dir) throw fail(550, `${path}: not a regular file`);
        return new Date(Math.floor(node.mtimeMs / 1000) * 1000);
      });
    }

    uploadFrom(source: Readable | string, toRemotePath: string): Promise<FTPResponse> {
      return this.task(`STOR ${toRemotePath}`, async () => {
        const path = this.resolve(toRemotePath);
        if (!nodes.get(parentOf(path) ?? '/')?.dir) throw fail(553, 'Could not create file.');
        const node: Node = { dir: false, data: Buffer.alloc(0), mode: 0o644, mtimeMs: clock };
        nodes.set(path, node);
        for await (const chunk of source as Readable) {
          if (this.shut) throw new Error('Client is closed because User closed client during task');
          node.data = Buffer.concat([node.data, chunk as Buffer]);
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (this.shut) throw new Error('Client is closed because User closed client during task');
        clock += 1000;
        node.mtimeMs = clock;
        return ok(226, 'Transfer complete');
      });
    }

    rename(srcPath: string, destPath: string): Promise<FTPResponse> {
      return this.task(`RNFR ${srcPath} RNTO ${destPath}`, () => {
        const from = this.resolve(srcPath);
        const to = this.resolve(destPath);
        const node = nodes.get(from);
        if (!node) throw fail(550, `${srcPath}: No such file or directory`);
        if (nodes.has(to) && options.renameOverwriteRefused) throw fail(550, 'Rename failed.');
        nodes.delete(from);
        nodes.set(to, node);
        return ok(250, 'Rename successful');
      });
    }

    remove(path: string): Promise<FTPResponse> {
      return this.task(`DELE ${path}`, () => {
        const target = this.resolve(path);
        if (nodes.get(target)?.dir !== false) throw fail(550, `${path}: No such file`);
        nodes.delete(target);
        return ok(250, 'DELE command successful');
      });
    }

    removeEmptyDir(path: string): Promise<FTPResponse> {
      return this.task(`RMD ${path}`, () => {
        const target = this.resolve(path);
        if (!nodes.get(target)?.dir) throw fail(550, `${path}: No such file or directory`);
        if (children(target).length > 0) throw fail(550, `${path}: Directory not empty`);
        nodes.delete(target);
        return ok(250, 'RMD command successful');
      });
    }

    close(): void {
      this.shut = true;
    }
  }

  return {
    nodes,
    log,
    clients,
    dir,
    file: (path: string, content: string, mode = 0o644) =>
      nodes.set(path, { dir: false, data: Buffer.from(content), mode, mtimeMs: clock }),
    createClient: (): FakeFtpClient => {
      const client = new FakeFtpClient();
      clients.push(client);
      return client;
    },
  };
}
