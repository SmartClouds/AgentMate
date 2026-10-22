import type {
  FileCapabilities,
  FileEntry,
  FileListing,
  FileSessionInfo,
  FileTarget,
} from '../protocol/generated/AgentMate.ServerCore.Contracts';
import type { FakeDocker } from './fakeDocker';

/**
 * The files of a `FakeCore`'s containers and volumes (E27), with the rules the real core keeps:
 *
 * - A session is opened on a container (by id, id prefix or name) or a volume and lives on the
 *   core, so every browse call and REST transfer names it. One left alone for 15 minutes ends,
 *   and later calls answer `sessionGone`; a target removed meanwhile answers `targetGone`.
 * - A running container with a shell, and every volume, can do everything. A stopped or
 *   shell-less container only lists, transfers and makes folders: rename, remove and chmod are
 *   `unsupported`, and a listing of a big folder there is cut short (`partial`).
 * - Refusals are `FakeFilesError`s whose message is `[files:<code>] <sentence>`, the form the core
 *   sends in hub errors and REST bodies.
 * - Entries are lstat'ed: a link's size, mode and mtime are its own, with where it points, whether
 *   that is a folder and whether it is broken. Times are whole seconds, modes the full st_mode.
 * - An upload is owned like its folder and keeps the mode of the file it replaces (0644 for a new
 *   one) unless a mode is given.
 *
 * The Admin rule lives in the hub (FakeCoreConnection) and the REST handler, as on the core.
 * Bytes are Uint8Arrays: this file is shared with the renderer, which has no Buffer.
 */

export type FakeFilesCode =
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

/** How long the core keeps a session nobody calls. */
export const FAKE_FILES_IDLE_MS = 15 * 60_000;

const TYPE_FILE = 0o100000;
const TYPE_DIR = 0o040000;
const TYPE_LINK = 0o120000;
const DIR_SIZE = 4096;
const MAX_LINK_HOPS = 40;

export class FakeFilesError extends Error {
  constructor(
    readonly code: FakeFilesCode,
    sentence: string,
  ) {
    super(`[files:${code}] ${sentence}`);
    this.name = 'FakeFilesError';
  }
}

interface Owned {
  mtimeMs: number;
  uid: number;
  gid: number;
}

interface FileNode extends Owned {
  kind: 'file';
  mode: number;
  bytes: Uint8Array;
}

interface DirNode extends Owned {
  kind: 'dir';
  mode: number;
  children: Map<string, FakeNode>;
}

interface LinkNode extends Owned {
  kind: 'link';
  target: string;
}

type FakeNode = FileNode | DirNode | LinkNode;

interface Walked {
  /** What is at the path, or null when the last name is free. */
  node: FakeNode | null;
  /** The folder the last name is in (null only for the root). */
  parent: DirNode | null;
  name: string;
  /** The path with every link before the last name (and the last one, when followed) resolved. */
  path: string;
}

export interface FakeSeedOptions {
  mode?: number;
  mtimeMs?: number;
  uid?: number;
  gid?: number;
}

function wholeSeconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
}

/** The path's names, `.` dropped and `..` collapsed; only absolute paths without NUL pass. */
export function fakePathParts(path: string): string[] {
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new FakeFilesError('invalidInput', `${JSON.stringify(path)} is not an absolute path.`);
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts;
}

function joinParts(parts: string[]): string {
  return `/${parts.join('/')}`;
}

/** One file system: a container's or a volume's (paths from `/` either way). */
export class FakeFileTree {
  private readonly root: DirNode;

  constructor(private readonly now: () => number) {
    this.root = { kind: 'dir', mode: 0o755, children: new Map(), ...this.owned() };
  }

  // Seeding, for tests: parents are made as needed.

  dir(path: string, mode = 0o755, owner: Omit<FakeSeedOptions, 'mode'> = {}): this {
    let folder = this.root;
    for (const part of fakePathParts(path)) {
      const next = folder.children.get(part);
      if (next?.kind === 'dir') {
        folder = next;
        continue;
      }
      const made: DirNode = { kind: 'dir', mode, children: new Map(), ...this.owned(owner) };
      folder.children.set(part, made);
      folder = made;
    }
    folder.mode = mode;
    return this;
  }

  file(path: string, content: string | Uint8Array, options: FakeSeedOptions = {}): this {
    const parts = fakePathParts(path);
    const name = parts.pop() as string;
    this.dir(joinParts(parts), this.seedParentMode(parts));
    const parent = this.walk(joinParts(parts), true).node as DirNode;
    parent.children.set(name, {
      kind: 'file',
      mode: options.mode ?? 0o644,
      bytes: bytesOf(content),
      ...this.owned(options),
    });
    return this;
  }

  link(path: string, target: string, options: Omit<FakeSeedOptions, 'mode'> = {}): this {
    const parts = fakePathParts(path);
    const name = parts.pop() as string;
    this.dir(joinParts(parts), this.seedParentMode(parts));
    const parent = this.walk(joinParts(parts), true).node as DirNode;
    parent.children.set(name, { kind: 'link', target, ...this.owned(options) });
    return this;
  }

  // What the core answers.

  /** The entry itself, a link not followed; null when nothing is there. */
  lstat(path: string): FileEntry | null {
    const walked = this.walkOrNull(path, false);
    if (!walked?.node) return null;
    return this.entryOf(walked.name || '/', walked.node, walked.path);
  }

  /** The path with every link resolved; the last name may be missing, as `realpath` allows. */
  realpath(path: string): string {
    return this.walk(path, true).path;
  }

  list(path: string, cap = Number.POSITIVE_INFINITY): FileListing {
    const { node, path: folder } = this.walk(path, true);
    if (!node) throw new FakeFilesError('notFound', `${path} is not there.`);
    if (node.kind !== 'dir') throw new FakeFilesError('notDirectory', `${path} is not a folder.`);
    const names = [...node.children.keys()].sort();
    const kept = names.slice(0, cap);
    return {
      path: folder,
      entries: kept.map((name) =>
        this.entryOf(name, node.children.get(name) as FakeNode, `${folder}/${name}`),
      ),
      partial: kept.length < names.length,
    };
  }

  mkdir(path: string): void {
    const walked = this.walk(path, false);
    if (walked.node) throw new FakeFilesError('exists', `${path} is already there.`);
    const parent = this.parentOf(walked, path);
    parent.children.set(walked.name, {
      kind: 'dir',
      mode: 0o755,
      children: new Map(),
      ...this.owned({ uid: parent.uid, gid: parent.gid }),
    });
  }

  rename(from: string, to: string): void {
    const source = this.walk(from, false);
    if (!source.node || !source.parent) {
      throw new FakeFilesError(source.node ? 'invalidInput' : 'notFound', `${from} is not there.`);
    }
    const target = this.walk(to, false);
    if (target.node) throw new FakeFilesError('exists', `${to} is already there.`);
    const parent = this.parentOf(target, to);
    if (source.node.kind === 'dir' && `${target.path}/`.startsWith(`${source.path}/`)) {
      throw new FakeFilesError('invalidInput', `${from} cannot be moved into itself.`);
    }
    source.parent.children.delete(source.name);
    parent.children.set(target.name, source.node);
  }

  remove(path: string, directory: boolean): void {
    const walked = this.walk(path, false);
    if (!walked.node) throw new FakeFilesError('notFound', `${path} is not there.`);
    if (!walked.parent) throw new FakeFilesError('invalidInput', 'The root cannot be removed.');
    if (directory) {
      if (walked.node.kind !== 'dir') {
        throw new FakeFilesError('notDirectory', `${path} is not a folder.`);
      }
      if (walked.node.children.size > 0) {
        throw new FakeFilesError('notEmpty', `${path} is not empty.`);
      }
    } else if (walked.node.kind === 'dir') {
      throw new FakeFilesError('isDirectory', `${path} is a folder.`);
    }
    walked.parent.children.delete(walked.name);
  }

  chmod(path: string, mode: number): void {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new FakeFilesError('invalidInput', `${mode} is not a permission mode.`);
    }
    const { node } = this.walk(path, true);
    if (!node || node.kind === 'link') throw new FakeFilesError('notFound', `${path} is not there.`);
    node.mode = mode;
  }

  /** A file's bytes, links followed. */
  read(path: string): { bytes: Uint8Array; mtimeMs: number } {
    const { node } = this.walk(path, true);
    if (!node) throw new FakeFilesError('notFound', `${path} is not there.`);
    if (node.kind === 'dir') throw new FakeFilesError('isDirectory', `${path} is a folder.`);
    const file = node as FileNode;
    return { bytes: file.bytes, mtimeMs: wholeSeconds(file.mtimeMs) };
  }

  /** Puts a file at `path` (a link there is replaced, not followed) and answers its entry. */
  write(path: string, bytes: Uint8Array, mode?: number): FileEntry {
    const walked = this.walk(path, false);
    if (walked.node?.kind === 'dir') throw new FakeFilesError('isDirectory', `${path} is a folder.`);
    const parent = this.parentOf(walked, path);
    const kept = walked.node?.kind === 'file' ? walked.node.mode : 0o644;
    const node: FileNode = {
      kind: 'file',
      mode: mode ?? kept,
      bytes: new Uint8Array(bytes),
      ...this.owned({ uid: parent.uid, gid: parent.gid }),
    };
    parent.children.set(walked.name, node);
    return this.entryOf(walked.name, node, walked.path);
  }

  private parentOf(walked: Walked, path: string): DirNode {
    if (!walked.parent) throw new FakeFilesError('invalidInput', `${path} is the root.`);
    return walked.parent;
  }

  private seedParentMode(parts: string[]): number {
    const existing = this.walkOrNull(joinParts(parts), true)?.node;
    return existing?.kind === 'dir' ? existing.mode : 0o755;
  }

  private owned(options: Omit<FakeSeedOptions, 'mode'> = {}): Owned {
    return {
      mtimeMs: wholeSeconds(options.mtimeMs ?? this.now()),
      uid: options.uid ?? 0,
      gid: options.gid ?? 0,
    };
  }

  private entryOf(name: string, node: FakeNode, path: string): FileEntry {
    const base = { name, mtimeUnixMs: wholeSeconds(node.mtimeMs), uid: node.uid, gid: node.gid };
    if (node.kind === 'file') {
      return {
        ...base,
        kind: 'file',
        size: node.bytes.length,
        mode: TYPE_FILE | node.mode,
        linkIsDirectory: false,
        brokenLink: false,
      };
    }
    if (node.kind === 'dir') {
      return {
        ...base,
        kind: 'directory',
        size: DIR_SIZE,
        mode: TYPE_DIR | node.mode,
        linkIsDirectory: false,
        brokenLink: false,
      };
    }
    const target = this.walkOrNull(path, true)?.node ?? null;
    return {
      ...base,
      kind: 'symlink',
      size: new TextEncoder().encode(node.target).length,
      mode: TYPE_LINK | 0o777,
      linkTarget: node.target,
      linkIsDirectory: target?.kind === 'dir',
      brokenLink: target === null,
    };
  }

  private walkOrNull(path: string, followLast: boolean): Walked | null {
    try {
      return this.walk(path, followLast);
    } catch (error) {
      if (error instanceof FakeFilesError && error.code !== 'invalidInput') return null;
      throw error;
    }
  }

  /** Follows the path from the root, links before the last name always, the last one if asked. */
  private walk(path: string, followLast: boolean, hops = 0): Walked {
    if (hops > MAX_LINK_HOPS) {
      throw new FakeFilesError('invalidInput', `${path} goes through too many links.`);
    }
    const parts = fakePathParts(path);
    if (parts.length === 0) return { node: this.root, parent: null, name: '', path: '/' };
    let folder = this.root;
    const done: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const last = index === parts.length - 1;
      const node = folder.children.get(name) ?? null;
      if (!node) {
        if (last) return { node: null, parent: folder, name, path: joinParts([...done, name]) };
        throw new FakeFilesError('notFound', `${joinParts(parts.slice(0, index + 1))} is not there.`);
      }
      if (node.kind === 'link' && (!last || followLast)) {
        const target = node.target.startsWith('/')
          ? node.target
          : `${joinParts(done)}/${node.target}`;
        const rest = parts.slice(index + 1).join('/');
        return this.walk(rest ? `${target}/${rest}` : target, followLast, hops + 1);
      }
      if (last) return { node, parent: folder, name, path: joinParts([...done, name]) };
      if (node.kind !== 'dir') {
        throw new FakeFilesError('notDirectory', `${joinParts(done)}/${name} is not a folder.`);
      }
      done.push(name);
      folder = node;
    }
    throw new Error('unreachable');
  }
}

/** The operations `failNext` can fail. */
export type FakeFilesOp =
  | 'open'
  | 'list'
  | 'stat'
  | 'realpath'
  | 'mkdir'
  | 'rename'
  | 'remove'
  | 'chmod'
  | 'read'
  | 'write';

interface FakeFileSession {
  info: FileSessionInfo;
  tree: FakeFileTree;
  /** The container's id, or the volume's name, to see whether it is still there. */
  key: string;
  shell: boolean;
  lastUsed: number;
}

interface Host {
  now(): number;
  readonly docker: FakeDocker;
}

const ALL: FileCapabilities = { rename: true, remove: true, chmod: true, atomicUpload: true };
const NONE: FileCapabilities = { rename: false, remove: false, chmod: false, atomicUpload: false };

export class FakeFiles {
  /** Container ids or names that have no shell (distroless images). */
  readonly noShell = new Set<string>();
  /** Where a container's pane starts, by container name; `/` otherwise. */
  readonly homes = new Map<string, string>();
  /** How many entries a listing without a shell reads before it gives up (`partial`). */
  scanCap = Number.POSITIVE_INFINITY;
  /** When set, the REST endpoint wants this bearer token. */
  token: string | null = null;
  /** Session ids `filesClose` was called with, in order. */
  readonly closed: string[] = [];
  /** Session ids opened, in order. */
  readonly opened: string[] = [];
  private readonly trees = new Map<string, FakeFileTree>();
  private readonly sessions = new Map<string, FakeFileSession>();
  private readonly failures = new Map<FakeFilesOp, FakeFilesError>();
  private counter = 0;

  constructor(private readonly host: Host) {}

  /** The file system of a container or volume, made empty (with a few folders) on first use. */
  tree(target: FileTarget): FakeFileTree {
    const key = this.keyOf(target);
    let tree = this.trees.get(key);
    if (!tree) {
      tree = new FakeFileTree(() => this.host.now());
      if (target.kind === 'container') {
        tree.dir('/etc').dir('/tmp', 0o1777).dir('/root', 0o700);
        tree.file('/etc/hostname', `${key.slice('container:'.length, 'container:'.length + 12)}\n`);
      }
      this.trees.set(key, tree);
    }
    return tree;
  }

  /** The next call of `op` fails with this code and sentence. */
  failNext(op: FakeFilesOp, code: FakeFilesCode, sentence: string): void {
    this.failures.set(op, new FakeFilesError(code, sentence));
  }

  /** Sessions the core still holds. */
  get openSessions(): number {
    return this.sessions.size;
  }

  /** Forgets a session (or all of them), as the core does after its idle time. */
  expire(sessionId?: string): void {
    if (sessionId) this.sessions.delete(sessionId);
    else this.sessions.clear();
  }

  open(target: FileTarget): FileSessionInfo {
    this.failIfTold('open');
    let displayName: string;
    let home = '/';
    let capabilities = ALL;
    let limitation: string | undefined;
    let shell = true;
    let key: string;
    if (target.kind === 'container') {
      const container = this.host.docker.find(target.id);
      if (!container) throw new FakeFilesError('notFound', `No such container: ${target.id}.`);
      const { id, name, state } = container.summary;
      displayName = name;
      key = id;
      home = this.homes.get(name) ?? '/';
      shell = !this.noShell.has(id) && !this.noShell.has(name);
      if (state !== 'running') {
        capabilities = NONE;
        limitation = 'The container is stopped. Start it to rename, delete or change permissions.';
      } else if (!shell) {
        capabilities = NONE;
        limitation =
          'This container has no shell, so files can only be listed, transferred and made into new folders.';
      }
    } else {
      if (!this.host.docker.volumes.some((volume) => volume.name === target.id)) {
        throw new FakeFilesError('notFound', `No such volume: ${target.id}.`);
      }
      displayName = target.id;
      key = target.id;
    }
    this.counter += 1;
    const sessionId = `00000000-0000-4000-9000-${String(this.counter).padStart(12, '0')}`;
    const info: FileSessionInfo = {
      sessionId,
      target: { kind: target.kind, id: target.id },
      displayName,
      home,
      user: 'root',
      capabilities: { ...capabilities },
      ...(limitation ? { limitation } : {}),
    };
    this.sessions.set(sessionId, {
      info,
      tree: this.tree(target),
      key,
      shell: capabilities.rename,
      lastUsed: this.host.now(),
    });
    this.opened.push(sessionId);
    return structuredClone(info);
  }

  close(sessionId: string): void {
    this.closed.push(sessionId);
    this.sessions.delete(sessionId);
  }

  list(sessionId: string, path: string): FileListing {
    const session = this.use(sessionId, 'list');
    return session.tree.list(path, session.shell ? Number.POSITIVE_INFINITY : this.scanCap);
  }

  stat(sessionId: string, path: string): FileEntry | null {
    return this.use(sessionId, 'stat').tree.lstat(path);
  }

  realpath(sessionId: string, path: string): string {
    return this.use(sessionId, 'realpath').tree.realpath(path);
  }

  mkdir(sessionId: string, path: string): void {
    this.use(sessionId, 'mkdir').tree.mkdir(path);
  }

  rename(sessionId: string, from: string, to: string): void {
    this.use(sessionId, 'rename', 'rename').tree.rename(from, to);
  }

  remove(sessionId: string, path: string, directory: boolean): void {
    this.use(sessionId, 'remove', 'remove').tree.remove(path, directory);
  }

  chmod(sessionId: string, path: string, mode: number): void {
    this.use(sessionId, 'chmod', 'chmod').tree.chmod(path, mode);
  }

  /** The REST download's bytes. */
  read(sessionId: string, path: string): { bytes: Uint8Array; mtimeMs: number } {
    return this.use(sessionId, 'read').tree.read(path);
  }

  /** The REST upload, once every byte has arrived. */
  write(sessionId: string, path: string, bytes: Uint8Array, mode?: number): FileEntry {
    return this.use(sessionId, 'write').tree.write(path, bytes, mode);
  }

  private use(
    sessionId: string,
    op: FakeFilesOp,
    needs?: 'rename' | 'remove' | 'chmod',
  ): FakeFileSession {
    const session = this.sessions.get(sessionId);
    const now = this.host.now();
    if (!session || now - session.lastUsed > FAKE_FILES_IDLE_MS) {
      this.sessions.delete(sessionId);
      throw new FakeFilesError('sessionGone', 'This file session has ended. Open it again.');
    }
    const gone =
      session.info.target.kind === 'container'
        ? !this.host.docker.find(session.key)
        : !this.host.docker.volumes.some((volume) => volume.name === session.key);
    if (gone) {
      this.sessions.delete(sessionId);
      throw new FakeFilesError(
        'targetGone',
        `${session.info.displayName} is no longer on the server.`,
      );
    }
    session.lastUsed = now;
    this.failIfTold(op);
    if (needs && !session.info.capabilities[needs]) {
      throw new FakeFilesError(
        'unsupported',
        session.info.limitation ?? 'This target cannot do that.',
      );
    }
    return session;
  }

  private failIfTold(op: FakeFilesOp): void {
    const failure = this.failures.get(op);
    if (!failure) return;
    this.failures.delete(op);
    throw failure;
  }

  private keyOf(target: FileTarget): string {
    if (target.kind === 'volume') return `volume:${target.id}`;
    const container = this.host.docker.find(target.id);
    return `container:${container?.summary.id ?? target.id}`;
  }
}
