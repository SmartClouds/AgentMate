import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { filesError } from '../../../shared/deployFilesErrors';
import type { SftpOptions, SftpStat } from '../../ssh/connection';
import type {
  ClientLease,
  DownloadFileOptions,
  DownloadFileResult,
  FileUploadOptions,
  FileUploadResult,
  SftpDetailedEntry,
  SftpFileClient,
  SftpPool,
} from '../client';

/**
 * An in-memory SFTP server for the file manager's unit tests (E25). `FakeSftpServer` holds one
 * tree of folders, files and links; each `connect()` is a connection to it (an `SftpFileClient`)
 * and `pool` hands those out the way the shared SSH pool does. The contract suite in
 * ./contract.ts holds it to what a real OpenSSH server answers:
 *
 * - SFTP failures are ssh2's: an Error whose `code` is the SFTP status (2 `No such file`,
 *   3 `Permission denied`, 4 `Failure`), the same words mapSftpError matches on.
 * - Links are followed by stat, realpath, chmod, reads and transfers, and listed with
 *   `isSymlink`; a broken one is listed with `brokenLink` and stats as nothing.
 * - Times come back in whole seconds, as SFTP version 3 has them.
 * - A dropped connection fails new calls with `The SSH connection to <host> is closed.` and calls
 *   in flight with `... closed.`, like `SshConnection`.
 * - Uploads and downloads go through a `.runova-<8 hex>.part` beside the target, take its
 *   name only at the end, and honour their abort signal with `[files:cancelled]`. An upload cut
 *   off by a dropped connection leaves its `.part` on the server, as a real one does.
 *
 * Every answer arrives on a later microtask, never on a timer, so tests with fake timers work.
 * Pool leases for every server id share the one tree.
 */

/** SFTP status codes (draft-ietf-secsh-filexfer-02), as ssh2 puts them on `error.code`. */
export const SFTP_STATUS = {
  noSuchFile: 2,
  permissionDenied: 3,
  failure: 4,
} as const;

const STATUS_TEXT: Record<number, string> = {
  2: 'No such file',
  3: 'Permission denied',
  4: 'Failure',
};

/** An error shaped like ssh2's for an SFTP status. */
export function sftpStatusError(code: number, message = STATUS_TEXT[code] ?? 'Failure'): Error {
  return Object.assign(new Error(message), { code });
}

/** A call the fake can fail, hold or count: a client method, or a pool lease. */
export type FakeSftpOp =
  | Exclude<keyof SftpFileClient, 'isOpen'>
  | 'acquire'
  /** `openSeparate` on the pool. */
  | 'openSeparate';

export interface FakeSftpCall {
  op: FakeSftpOp;
  /** The path the call was for; the source for a rename and an upload's remote path. */
  path: string;
  /** A rename's target, or a download's local path. */
  to?: string;
  /** Which connection made it (`FakeSftpClient.id`). */
  clientId: number;
}

/** Holds calls of one kind at their start, so a test can look at what runs concurrently. */
export interface FakeGate {
  /** Calls held right now. */
  readonly waiting: number;
  /** Resolves once at least `count` (default 1) calls are held. */
  waitFor(count?: number): Promise<void>;
  /** Lets the oldest `count` (default 1) held calls go on. */
  release(count?: number): void;
  /** Lets every held call go and removes the gate, so later calls pass straight through. */
  open(): void;
}

export interface FakeNodeOptions {
  /** Permission bits. Default 0o755 for folders, 0o644 for files. */
  mode?: number;
  /** Default: `now()`. Read back rounded down to whole seconds. */
  mtimeMs?: number;
  /** What the longname shows. Default `deploy`. */
  owner?: string;
  group?: string;
}

export interface FakeSftpServerOptions {
  /** Named in the connection-closed messages. Default `fake.example`. */
  host?: string;
  /** The login user's home folder, made at the start; `realpath('.')` answers it. */
  home?: string;
  /** The server's clock, for new files and folders. Default `Date.now`. */
  now?: () => number;
  /** How many `onProgress` calls a non-empty transfer makes. Default 1. */
  progressSteps?: number;
}

interface FakeNode {
  kind: 'dir' | 'file' | 'link';
  mode: number;
  mtimeMs: number;
  owner: string;
  group: string;
  content: Buffer;
  /** For a link, exactly as written: absolute, or relative to the link's folder. */
  target: string;
}

interface Lookup {
  /** The path with every link before the last part resolved (and the last too when followed). */
  path: string;
  node: FakeNode | null;
  /** The folder the last part would be in exists. */
  parentExists: boolean;
}

interface Pending {
  reason: Promise<never>;
}

const LINK_DEPTH = 40;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** What ext4 reports for a folder's size. */
const DIR_SIZE = 4096;

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function wholeSeconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

function sizeOf(node: FakeNode): number {
  if (node.kind === 'dir') return DIR_SIZE;
  if (node.kind === 'link') return Buffer.byteLength(node.target);
  return node.content.length;
}

/** `rwxr-xr-x` with setuid, setgid and sticky shown the way ls does. */
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

/** OpenSSH's readdir longname (`ls -l` of the entry itself, links not followed). */
function longnameOf(name: string, node: FakeNode): string {
  const type = node.kind === 'dir' ? 'd' : node.kind === 'link' ? 'l' : '-';
  const mode = node.kind === 'link' ? 0o777 : node.mode;
  const date = new Date(node.mtimeMs);
  const day = String(date.getUTCDate()).padStart(2, ' ');
  const when = `${MONTHS[date.getUTCMonth()]} ${day}  ${date.getUTCFullYear()}`;
  const size = String(sizeOf(node)).padStart(8, ' ');
  return `${type}${permissionText(mode)}    1 ${node.owner.padEnd(8)} ${node.group.padEnd(8)} ${size} ${when} ${name}`;
}

function toStat(node: FakeNode): SftpStat {
  return {
    isDirectory: node.kind === 'dir',
    isFile: node.kind === 'file',
    size: sizeOf(node),
    mtimeMs: wholeSeconds(node.mtimeMs),
    mode: node.mode & 0o7777,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function partSuffix(): string {
  return `.runova-${randomBytes(4).toString('hex')}.part`;
}

/** Lets other work run, without a timer. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class GateState implements FakeGate {
  private readonly held: Array<() => void> = [];
  private readonly watchers: Array<{ count: number; resolve: () => void }> = [];
  private opened = false;

  constructor(private readonly onOpen: () => void) {}

  get waiting(): number {
    return this.held.length;
  }

  /** Waits for a release; `pending.reason` rejecting (a drop, an abort) gives up the place. */
  async pass(pending: Pending): Promise<void> {
    if (this.opened) return;
    let resolveTurn: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    this.held.push(resolveTurn);
    this.notify();
    try {
      await Promise.race([turn, pending.reason]);
    } finally {
      const index = this.held.indexOf(resolveTurn);
      if (index >= 0) this.held.splice(index, 1);
    }
  }

  waitFor(count = 1): Promise<void> {
    if (this.held.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => this.watchers.push({ count, resolve }));
  }

  release(count = 1): void {
    for (const resolve of this.held.splice(0, count)) resolve();
  }

  open(): void {
    this.opened = true;
    this.release(this.held.length);
    this.onOpen();
  }

  private notify(): void {
    for (const watcher of [...this.watchers]) {
      if (this.held.length >= watcher.count) {
        this.watchers.splice(this.watchers.indexOf(watcher), 1);
        watcher.resolve();
      }
    }
  }
}

interface Failure {
  op: FakeSftpOp;
  path: string | null;
  error: Error;
}

export class FakeSftpServer {
  readonly host: string;
  readonly home: string;
  /** How many `onProgress` calls a non-empty transfer makes. Can be changed between calls. */
  progressSteps: number;
  /** Every client call, in the order they were made (pool leases are counted on `pool`). */
  readonly calls: FakeSftpCall[] = [];
  /** Every connection made, in order. */
  readonly clients: FakeSftpClient[] = [];
  readonly pool: FakeSftpPool;
  readonly now: () => number;

  private readonly nodes = new Map<string, FakeNode>();
  private readonly failures: Failure[] = [];
  private readonly gates = new Map<FakeSftpOp, GateState>();
  private readonly running = new Map<FakeSftpOp, number>();
  private readonly peaks = new Map<FakeSftpOp, number>();
  private nextClientId = 1;

  constructor(options: FakeSftpServerOptions = {}) {
    this.host = options.host ?? 'fake.example';
    this.home = normalize(options.home ?? '/home/deploy');
    this.now = options.now ?? Date.now;
    this.progressSteps = options.progressSteps ?? 1;
    this.nodes.set('/', this.makeNode('dir', {}));
    this.dir(this.home);
    this.pool = new FakeSftpPool(this);
  }

  /** A new connection to this server. */
  connect(): FakeSftpClient {
    const client = new FakeSftpClient(this, this.nextClientId);
    this.nextClientId += 1;
    this.clients.push(client);
    return client;
  }

  /** Makes a folder and any missing parents. Chainable. */
  dir(path: string, options: FakeNodeOptions = {}): this {
    const target = normalize(path);
    this.ensureParents(target);
    const existing = this.nodes.get(target);
    if (existing?.kind === 'dir') {
      if (options.mode !== undefined) existing.mode = options.mode & 0o7777;
    } else {
      this.nodes.set(target, this.makeNode('dir', options));
    }
    return this;
  }

  /** Writes a file, making missing parents. Chainable. */
  file(path: string, content: string | Buffer, options: FakeNodeOptions = {}): this {
    const target = normalize(path);
    this.ensureParents(target);
    const node = this.makeNode('file', options);
    node.content = Buffer.from(content);
    this.nodes.set(target, node);
    return this;
  }

  /** Makes a symbolic link holding `target` as written, making missing parents. Chainable. */
  link(path: string, target: string, options: Omit<FakeNodeOptions, 'mode'> = {}): this {
    const at = normalize(path);
    this.ensureParents(at);
    const node = this.makeNode('link', { ...options, mode: 0o777 });
    node.target = target;
    this.nodes.set(at, node);
    return this;
  }

  /** A file's bytes, links followed; null when there is no file there. */
  read(path: string): Buffer | null {
    const { node } = this.lookup(path, true);
    return node?.kind === 'file' ? Buffer.from(node.content) : null;
  }

  /** The permission bits, links followed; null when nothing is there. */
  modeOf(path: string): number | null {
    return this.lookup(path, true).node?.mode ?? null;
  }

  /** Whether anything is at `path` itself, a broken link included. */
  exists(path: string): boolean {
    return this.lookup(path, false).node !== null;
  }

  /** What the link at `path` holds, or null when `path` is not a link. */
  linkTarget(path: string): string | null {
    const { node } = this.lookup(path, false);
    return node?.kind === 'link' ? node.target : null;
  }

  /** The names in a folder, sorted, `.part` files included. Empty when it is not a folder. */
  list(path: string): string[] {
    const { path: real, node } = this.lookup(path, true);
    if (node?.kind !== 'dir') return [];
    return this.childrenOf(real).map(([child]) => baseName(child));
  }

  /** Fails the next call of `op` (for any path) with `error`, or an SFTP status code. */
  failNext(op: FakeSftpOp, error: Error | number): void;
  /** Fails the next call of `op` for `path` (a server id for pool leases). */
  failNext(op: FakeSftpOp, path: string, error: Error | number): void;
  failNext(
    op: FakeSftpOp,
    pathOrError: string | Error | number,
    maybeError?: Error | number,
  ): void {
    const hasPath = typeof pathOrError === 'string';
    const raw = (hasPath ? maybeError : pathOrError) ?? SFTP_STATUS.failure;
    const error = typeof raw === 'number' ? sftpStatusError(raw) : raw;
    const path = hasPath ? (pathOrError as string) : null;
    this.failures.push({
      op,
      path: path === null || op === 'acquire' || op === 'openSeparate' ? path : normalize(path),
      error,
    });
  }

  /** Holds calls of `op` at their start until released. The same gate comes back while it is closed. */
  gate(op: FakeSftpOp): FakeGate {
    let gate = this.gates.get(op);
    if (!gate) {
      gate = new GateState(() => this.gates.delete(op));
      this.gates.set(op, gate);
    }
    return gate;
  }

  /** Drops every open connection, as a network failure would. */
  dropConnection(): void {
    for (const client of this.clients) client.dropConnection();
  }

  /** The paths of the calls of one kind, in order. */
  callsOf(op: FakeSftpOp): string[] {
    return this.calls.filter((call) => call.op === op).map((call) => call.path);
  }

  /** The most calls of `op` that were past their gate at the same time. */
  maxInFlight(op: FakeSftpOp): number {
    return this.peaks.get(op) ?? 0;
  }

  /** Calls of `op` past their gate right now. */
  inFlight(op: FakeSftpOp): number {
    return this.running.get(op) ?? 0;
  }

  // Everything below is for FakeSftpClient and FakeSftpPool.

  /** @internal The gate, then a queued failure, for one call. */
  async enter(op: FakeSftpOp, path: string, pending: Pending): Promise<void> {
    const gate = this.gates.get(op);
    if (gate) await gate.pass(pending);
    const index = this.failures.findIndex(
      (failure) => failure.op === op && (failure.path === null || failure.path === path),
    );
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1);
      throw failure.error;
    }
  }

  /** @internal */
  started(op: FakeSftpOp): void {
    const now = (this.running.get(op) ?? 0) + 1;
    this.running.set(op, now);
    this.peaks.set(op, Math.max(this.peaks.get(op) ?? 0, now));
  }

  /** @internal */
  ended(op: FakeSftpOp): void {
    this.running.set(op, (this.running.get(op) ?? 1) - 1);
  }

  /**
   * @internal Finds `path`, resolving links on the way. The last part is followed only with
   * `follow`. A missing part, a file or a broken link in the middle, or a loop, gives no node.
   */
  lookup(path: string, follow: boolean, depth = 0): Lookup {
    const parts = normalize(path).split('/').filter(Boolean);
    let current = '/';
    for (let index = 0; index < parts.length; index += 1) {
      const last = index === parts.length - 1;
      const next = join(current, parts[index]);
      const node = this.nodes.get(next);
      if (!node) return { path: next, node: null, parentExists: last };
      if (node.kind === 'link' && (!last || follow)) {
        if (depth >= LINK_DEPTH) return { path: next, node: null, parentExists: false };
        const target = node.target.startsWith('/') ? node.target : join(current, node.target);
        const resolved = this.lookup(target, true, depth + 1);
        if (last) {
          return resolved.node ? resolved : { path: next, node: null, parentExists: true };
        }
        if (resolved.node?.kind !== 'dir') return { path: next, node: null, parentExists: false };
        current = resolved.path;
        continue;
      }
      if (!last && node.kind !== 'dir') return { path: next, node: null, parentExists: false };
      current = next;
      if (last) return { path: current, node, parentExists: true };
    }
    return { path: '/', node: this.nodes.get('/') ?? null, parentExists: true };
  }

  /** @internal The entries right inside a folder, by real path, sorted by name. */
  childrenOf(dir: string): [string, FakeNode][] {
    const found: [string, FakeNode][] = [];
    for (const [path, node] of this.nodes) {
      if (path !== '/' && parentOf(path) === dir) found.push([path, node]);
    }
    return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** @internal */
  getNode(path: string): FakeNode | undefined {
    return this.nodes.get(path);
  }

  /** @internal */
  setNode(path: string, node: FakeNode): void {
    this.nodes.set(path, node);
  }

  /** @internal Removes `path` and everything under it. */
  deleteTree(path: string): void {
    for (const key of [...this.nodes.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
    }
  }

  /** @internal Moves `from` and everything under it to `to`. */
  moveTree(from: string, to: string): void {
    const moved: [string, FakeNode][] = [];
    for (const [key, node] of this.nodes) {
      if (key === from || key.startsWith(`${from}/`)) moved.push([key, node]);
    }
    for (const [key] of moved) this.nodes.delete(key);
    for (const [key, node] of moved) this.nodes.set(to + key.slice(from.length), node);
  }

  /** @internal */
  makeNode(kind: FakeNode['kind'], options: FakeNodeOptions): FakeNode {
    return {
      kind,
      mode: (options.mode ?? (kind === 'file' ? 0o644 : 0o755)) & 0o7777,
      mtimeMs: options.mtimeMs ?? this.now(),
      owner: options.owner ?? 'deploy',
      group: options.group ?? 'deploy',
      content: Buffer.alloc(0),
      target: '',
    };
  }

  private ensureParents(path: string): void {
    let current = '/';
    for (const part of parentOf(path).split('/').filter(Boolean)) {
      current = join(current, part);
      if (!this.nodes.has(current)) this.nodes.set(current, this.makeNode('dir', {}));
    }
  }
}

/** One connection to a `FakeSftpServer`. */
export class FakeSftpClient implements SftpFileClient {
  private open = true;
  private rejectClosed: (error: Error) => void = () => undefined;
  private readonly closedSignal: Promise<never>;

  constructor(
    readonly server: FakeSftpServer,
    /** Numbered from 1 in the order of `connect()`. */
    readonly id: number,
  ) {
    this.closedSignal = new Promise<never>((_resolve, reject) => {
      this.rejectClosed = reject;
    });
    this.closedSignal.catch(() => undefined);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Ends this connection: calls in flight fail with `closed.`, later ones with `is closed.` */
  dropConnection(): void {
    if (!this.open) return;
    this.open = false;
    this.rejectClosed(new Error(`The SSH connection to ${this.server.host} closed.`));
  }

  sftpRealpath(path: string, _options?: SftpOptions): Promise<string> {
    return this.run('sftpRealpath', path, () => {
      const absolute = path.startsWith('/') ? path : join(this.server.home, path);
      const found = this.server.lookup(absolute, true);
      if (!found.node) throw sftpStatusError(SFTP_STATUS.noSuchFile);
      return found.path;
    });
  }

  sftpListDetailed(dir: string, _options?: SftpOptions): Promise<SftpDetailedEntry[]> {
    return this.run('sftpListDetailed', dir, () => {
      const found = this.server.lookup(dir, true);
      if (found.node?.kind !== 'dir') throw sftpStatusError(SFTP_STATUS.noSuchFile);
      return this.server.childrenOf(found.path).map(([path, node]) => {
        const name = baseName(path);
        const longname = longnameOf(name, node);
        if (node.kind !== 'link') {
          return { name, ...toStat(node), isSymlink: false, brokenLink: false, longname };
        }
        const target = this.server.lookup(path, true).node;
        if (target)
          return { name, ...toStat(target), isSymlink: true, brokenLink: false, longname };
        return {
          name,
          ...toStat(node),
          isDirectory: false,
          isFile: false,
          isSymlink: true,
          brokenLink: true,
          longname,
        };
      });
    });
  }

  sftpStat(path: string, _options?: SftpOptions): Promise<SftpStat | null> {
    return this.run('sftpStat', path, () => {
      const { node } = this.server.lookup(path, true);
      return node ? toStat(node) : null;
    });
  }

  sftpMkdir(path: string, options: SftpOptions & { mode?: number } = {}): Promise<void> {
    return this.run('sftpMkdir', path, () => {
      const found = this.server.lookup(path, false);
      if (found.node) throw sftpStatusError(SFTP_STATUS.failure);
      if (!found.parentExists) throw sftpStatusError(SFTP_STATUS.noSuchFile);
      this.server.setNode(found.path, this.server.makeNode('dir', { mode: options.mode ?? 0o755 }));
    });
  }

  sftpRmdir(path: string, _options?: SftpOptions): Promise<void> {
    return this.run('sftpRmdir', path, () => {
      const found = this.server.lookup(path, false);
      if (found.node?.kind !== 'dir') throw sftpStatusError(SFTP_STATUS.noSuchFile);
      if (this.server.childrenOf(found.path).length > 0) {
        throw sftpStatusError(SFTP_STATUS.failure);
      }
      this.server.deleteTree(found.path);
    });
  }

  sftpUnlink(path: string, _options?: SftpOptions): Promise<void> {
    return this.run('sftpUnlink', path, () => {
      const found = this.server.lookup(path, false);
      if (!found.node) throw sftpStatusError(SFTP_STATUS.noSuchFile);
      if (found.node.kind === 'dir') throw sftpStatusError(SFTP_STATUS.failure);
      this.server.deleteTree(found.path);
    });
  }

  sftpChmod(path: string, mode: number, _options?: SftpOptions): Promise<void> {
    return this.run('sftpChmod', path, () => {
      const { node } = this.server.lookup(path, true);
      if (!node) throw sftpStatusError(SFTP_STATUS.noSuchFile);
      node.mode = mode & 0o7777;
    });
  }

  sftpRename(from: string, to: string, _options?: SftpOptions): Promise<void> {
    return this.run(
      'sftpRename',
      from,
      () => {
        const source = this.server.lookup(from, false);
        if (!source.node) throw sftpStatusError(SFTP_STATUS.noSuchFile);
        const target = this.server.lookup(to, false);
        // SFTP version 3 refuses to rename onto an existing name.
        if (target.node) throw sftpStatusError(SFTP_STATUS.failure);
        if (!target.parentExists) throw sftpStatusError(SFTP_STATUS.noSuchFile);
        if (target.path.startsWith(`${source.path}/`)) throw sftpStatusError(SFTP_STATUS.failure);
        this.server.moveTree(source.path, target.path);
      },
      { to },
    );
  }

  sftpReadRange(
    path: string,
    start: number,
    length: number,
    _options?: SftpOptions,
  ): Promise<Buffer> {
    return this.run('sftpReadRange', path, () => {
      const { node } = this.server.lookup(path, true);
      if (!node) throw sftpStatusError(SFTP_STATUS.noSuchFile);
      if (node.kind !== 'file') throw sftpStatusError(SFTP_STATUS.failure);
      return Buffer.from(node.content.subarray(start, start + length));
    });
  }

  uploadFile(
    localPath: string,
    remotePath: string,
    options: FileUploadOptions = {},
  ): Promise<FileUploadResult> {
    const { signal } = options;
    const cancelled = (): Error =>
      filesError('cancelled', `The upload of ${remotePath} was cancelled.`);
    return this.run(
      'uploadFile',
      remotePath,
      async (alive) => {
        const bytes = await readFile(localPath);
        alive();
        const at = this.server.lookup(remotePath, false);
        if (!at.parentExists) throw sftpStatusError(SFTP_STATUS.noSuchFile);
        const existing = this.server.lookup(remotePath, true).node;
        if (at.node?.kind === 'dir' || existing?.kind === 'dir') {
          throw sftpStatusError(SFTP_STATUS.failure);
        }
        const mode = options.mode ?? existing?.mode ?? 0o644;
        const part = `${at.path}${partSuffix()}`;
        const partNode = this.server.makeNode('file', { mode });
        this.server.setNode(part, partNode);
        try {
          const steps = bytes.length === 0 ? 0 : Math.max(1, this.server.progressSteps);
          for (let step = 1; step <= steps; step += 1) {
            if (signal?.aborted) throw cancelled();
            const sent = Math.round((bytes.length * step) / steps);
            partNode.content = Buffer.from(bytes.subarray(0, sent));
            options.onProgress?.(sent);
            await tick();
            alive();
          }
          const hash = sha256(bytes);
          if (options.expectedSha256 !== undefined && hash !== options.expectedSha256) {
            throw filesError(
              'localChanged',
              `${localPath} changed while it was being sent, so ${remotePath} was left as it was.`,
            );
          }
          if (signal?.aborted) throw cancelled();
          this.server.deleteTree(part);
          const node = this.server.makeNode('file', {
            mode,
            owner: existing?.owner,
            group: existing?.group,
          });
          node.content = bytes;
          this.server.setNode(at.path, node);
          return { stat: toStat(node), atomic: true, replaced: existing !== null, sha256: hash };
        } catch (error) {
          // A dropped connection cannot tidy up, so the part stays, as on a real server.
          if (this.open) this.server.deleteTree(part);
          throw error;
        }
      },
      { signal, cancelled },
    );
  }

  downloadFile(
    remotePath: string,
    localPath: string,
    options: DownloadFileOptions = {},
  ): Promise<DownloadFileResult> {
    const { signal } = options;
    const cancelled = (): Error =>
      filesError('cancelled', `The download of ${remotePath} was cancelled.`);
    return this.run(
      'downloadFile',
      remotePath,
      async (alive) => {
        const { node } = this.server.lookup(remotePath, true);
        if (!node) throw sftpStatusError(SFTP_STATUS.noSuchFile);
        if (node.kind !== 'file') throw sftpStatusError(SFTP_STATUS.failure);
        const bytes = Buffer.from(node.content);
        const mtimeMs = wholeSeconds(node.mtimeMs);
        const replaced = await stat(localPath).then(
          () => true,
          () => false,
        );
        const part = `${localPath}${partSuffix()}`;
        try {
          await writeFile(part, Buffer.alloc(0));
          const steps = bytes.length === 0 ? 0 : Math.max(1, this.server.progressSteps);
          for (let step = 1; step <= steps; step += 1) {
            if (signal?.aborted) throw cancelled();
            alive();
            const received = Math.round((bytes.length * step) / steps);
            await writeFile(part, bytes.subarray(0, received));
            options.onProgress?.(received, bytes.length);
            await tick();
          }
          if (signal?.aborted) throw cancelled();
          alive();
          if (options.preserveMtime !== false) {
            await utimes(part, new Date(), new Date(mtimeMs));
          }
          await rename(part, localPath);
          return { size: bytes.length, mtimeMs, replaced };
        } catch (error) {
          await rm(part, { force: true });
          throw error;
        }
      },
      // The local .part is removed before the call fails, so a drop is not raced here: the
      // steps notice it through alive().
      { signal, cancelled, to: localPath, raceClose: false },
    );
  }

  /**
   * One call: logged, refused when the connection is gone, held at its gate, failed when a
   * failure is queued, then `work` on a later microtask. `alive()` throws once the connection has
   * dropped, for the long calls to check between steps; a drop or an abort also fails the call
   * while it waits at its gate.
   */
  private async run<T>(
    op: FakeSftpOp,
    path: string,
    work: (alive: () => void) => T | Promise<T>,
    extra: {
      to?: string;
      signal?: AbortSignal;
      cancelled?: () => Error;
      raceClose?: boolean;
    } = {},
  ): Promise<T> {
    this.server.calls.push({
      op,
      path,
      ...(extra.to === undefined ? {} : { to: extra.to }),
      clientId: this.id,
    });
    if (!this.open) throw new Error(`The SSH connection to ${this.server.host} is closed.`);
    const { signal, cancelled } = extra;
    if (signal?.aborted && cancelled) throw cancelled();

    let stopListening = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal || !cancelled) return;
      const onAbort = (): void => reject(cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
      stopListening = () => signal.removeEventListener('abort', onAbort);
    });
    aborted.catch(() => undefined);
    const reason = Promise.race([this.closedSignal, aborted]);
    reason.catch(() => undefined);

    try {
      await this.server.enter(op, normalize(path), { reason });
      await tick();
      const alive = (): void => {
        if (!this.open) throw new Error(`The SSH connection to ${this.server.host} closed.`);
      };
      alive();
      this.server.started(op);
      try {
        const result = Promise.resolve(work(alive));
        return await (extra.raceClose === false
          ? result
          : Promise.race([result, this.closedSignal]));
      } finally {
        this.server.ended(op);
      }
    } finally {
      stopListening();
    }
  }
}

/** The pool side: shared leases per server id, and separate connections for transfers. */
export class FakeSftpPool implements SftpPool {
  /** `acquire` calls, failed ones included. */
  acquired = 0;
  /** `openSeparate` calls, failed ones included. */
  openedSeparate = 0;
  /** Leases handed back (a second release of the same lease is not counted). */
  released = 0;
  private failed = 0;
  private readonly shared = new Map<string, FakeSftpClient>();
  private readonly pending: Pending = { reason: new Promise<never>(() => undefined) };

  constructor(private readonly server: FakeSftpServer) {}

  /** Leases handed out and not released yet. */
  get outstanding(): number {
    return this.acquired + this.openedSeparate - this.failed - this.released;
  }

  async acquire(serverId: string): Promise<ClientLease> {
    this.acquired += 1;
    await this.lease('acquire', serverId);
    let client = this.shared.get(serverId);
    if (!client?.isOpen) {
      client = this.server.connect();
      this.shared.set(serverId, client);
    }
    return this.handOut(client, false);
  }

  async openSeparate(serverId: string): Promise<ClientLease> {
    this.openedSeparate += 1;
    await this.lease('openSeparate', serverId);
    return this.handOut(this.server.connect(), true);
  }

  private async lease(op: 'acquire' | 'openSeparate', serverId: string): Promise<void> {
    try {
      await this.server.enter(op, serverId, this.pending);
      await tick();
    } catch (error) {
      this.failed += 1;
      throw error;
    }
  }

  private handOut(client: FakeSftpClient, closeOnRelease: boolean): ClientLease {
    let done = false;
    return {
      client,
      release: () => {
        if (done) return;
        done = true;
        this.released += 1;
        if (closeOnRelease) client.dropConnection();
      },
    };
  }
}

/** A server, one connection to it and its pool, for the common case. */
export function createFakeSftp(options: FakeSftpServerOptions = {}): {
  server: FakeSftpServer;
  client: FakeSftpClient;
  pool: FakeSftpPool;
} {
  const server = new FakeSftpServer(options);
  return { server, client: server.connect(), pool: server.pool };
}
