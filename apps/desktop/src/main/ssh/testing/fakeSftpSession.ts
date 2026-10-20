import { vi } from 'vitest';
import type { SshConnection } from '../connection';

/**
 * The fake SSH server has no SFTP subsystem, so these hand the connection a stand-in session in
 * its place. It answers the way ssh2's SFTPWrapper does: one callback per request, on a later
 * tick, errors carrying the SFTP status as a number in `code`, the end of a file read as zero
 * bytes, and the OpenSSH extensions throwing at once when the server did not advertise them.
 * Real SFTP is covered against OpenSSH in sshRemote.int.test.ts and sftp.int.test.ts.
 */

export const NO_SUCH_FILE = 2;
export const PERMISSION_DENIED = 3;
export const FAILURE = 4;

const TYPE_DIR = 0o040000;
const TYPE_FILE = 0o100000;
const TYPE_LINK = 0o120000;
/** Links followed in a row before a path counts as a loop. */
const MAX_LINK_HOPS = 8;

export interface FakeStats {
  mode: number;
  size?: number;
  mtime?: number;
  atime?: number;
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}

interface NodeExtras {
  /** Whole seconds, as SFTP version 3 has them. */
  mtime?: number;
  /** Permission bits. Default 0755 for folders, 0644 for files, 0777 for links. */
  mode?: number;
  /** The link count the listing's `ls -l` line shows. */
  links?: number;
  /** The `ls -l` line readdir sends, in place of the one made up from the other fields. */
  longname?: string;
}

export type FakeNode =
  | ({ kind: 'dir' } & NodeExtras)
  | ({ kind: 'file'; content: string | Buffer } & NodeExtras)
  /** `target` is absolute, or relative to the link's folder. */
  | ({ kind: 'link'; target: string } & NodeExtras);

type FileNode = Extract<FakeNode, { kind: 'file' }>;

export interface FakeSftpOptions {
  /** Most bytes one read hands back, like a server with a small packet size. */
  maxRead?: number;
  failRead?: boolean;
  /** Requests of these kinds are never answered. */
  hang?: ReadonlySet<string>;
  /** Called on every request, with its kind and path, before it is answered. */
  onRequest?: (kind: string, path: string) => void;
  /** Once the first read of `path` is answered, the file is cut to `size` bytes. */
  truncateAt?: { path: string; size: number };
  /** Default: posix-rename and fsync, like OpenSSH. */
  extensions?: string[];
}

type Callback = (error?: Error, value?: unknown, ...rest: unknown[]) => void;

interface FailRule {
  kind: string;
  path?: string;
  code: number;
}

interface OpenFile {
  path: string;
  node: FileNode;
}

export function sftpError(code: number, message?: string): Error {
  const text =
    message ??
    (code === NO_SUCH_FILE
      ? 'No such file'
      : code === PERMISSION_DENIED
        ? 'Permission denied'
        : 'Failure');
  return Object.assign(new Error(text), { code });
}

function bytesOf(node: FileNode): Buffer {
  return typeof node.content === 'string' ? Buffer.from(node.content) : node.content;
}

function typeBits(node: FakeNode): number {
  return node.kind === 'dir' ? TYPE_DIR : node.kind === 'file' ? TYPE_FILE : TYPE_LINK;
}

function permissionsOf(node: FakeNode): number {
  return node.mode ?? (node.kind === 'dir' ? 0o755 : node.kind === 'file' ? 0o644 : 0o777);
}

function sizeOf(node: FakeNode): number {
  if (node.kind === 'file') return bytesOf(node).length;
  return node.kind === 'dir' ? 4096 : Buffer.byteLength(node.target);
}

function stats(node: FakeNode): FakeStats {
  const mtime = node.kind === 'link' ? (node.mtime ?? 0) : node.mtime;
  return {
    mode: typeBits(node) | permissionsOf(node),
    size: sizeOf(node),
    mtime,
    atime: mtime,
    isDirectory: () => node.kind === 'dir',
    isFile: () => node.kind === 'file',
    isSymbolicLink: () => node.kind === 'link',
  };
}

function symbolic(mode: number): string {
  const bits = 'rwxrwxrwx';
  let text = '';
  for (let i = 0; i < 9; i += 1) text += mode & (0o400 >> i) ? bits[i] : '-';
  return text;
}

function longnameOf(name: string, node: FakeNode): string {
  if (node.longname !== undefined) return node.longname;
  const type = node.kind === 'dir' ? 'd' : node.kind === 'link' ? 'l' : '-';
  const links = node.links ?? (node.kind === 'dir' ? 2 : 1);
  const size = String(sizeOf(node)).padStart(8);
  return `${type}${symbolic(permissionsOf(node))}    ${links} deploy   deploy   ${size} Jan  5 10:12 ${name}`;
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

export function fakeSftp(tree: Record<string, FakeNode>, options: FakeSftpOptions = {}) {
  const nodes = new Map<string, FakeNode>(Object.entries(tree));
  const handles = new Map<string, OpenFile>();
  const closed: string[] = [];
  const ops: string[] = [];
  const hung = new Set<string>(options.hang ?? []);
  const failures: FailRule[] = [];
  if (options.failRead) failures.push({ kind: 'read', code: FAILURE });
  const extensions = options.extensions ?? ['posix-rename@openssh.com', 'fsync@openssh.com'];
  const inFlight = new Map<string, number>();
  const peaks = new Map<string, number>();
  let nextHandle = 0;
  let truncated = false;

  /** The node at `path` with every link on the way followed, or undefined. */
  const resolve = (path: string, hops = 0): FakeNode | undefined => {
    const node = nodes.get(path);
    if (node?.kind !== 'link') return node;
    if (hops >= MAX_LINK_HOPS) return undefined;
    const target = node.target.startsWith('/')
      ? node.target
      : `${parentOf(path).replace(/\/$/, '')}/${node.target}`;
    return resolve(target, hops + 1);
  };
  const extended = (name: string): void => {
    if (!extensions.includes(name)) {
      throw new Error('Server does not support this extended request');
    }
  };
  const answer = (kind: string, path: string, cb: Callback, reply: () => void): void => {
    ops.push(`${kind} ${path}`);
    options.onRequest?.(kind, path);
    if (hung.has(kind)) return;
    const busy = (inFlight.get(kind) ?? 0) + 1;
    inFlight.set(kind, busy);
    peaks.set(kind, Math.max(peaks.get(kind) ?? 0, busy));
    setImmediate(() => {
      inFlight.set(kind, (inFlight.get(kind) ?? 1) - 1);
      const rule = failures.find(
        (candidate) =>
          candidate.kind === kind && (candidate.path === undefined || candidate.path === path),
      );
      if (rule) cb(sftpError(rule.code));
      else reply();
    });
  };
  const openFile = (handle: Buffer): OpenFile | undefined => handles.get(handle.toString());
  const move = (from: string, to: string, cb: Callback): void => {
    const node = nodes.get(from);
    if (!node) return cb(sftpError(NO_SUCH_FILE));
    for (const [key, child] of [...nodes]) {
      if (!key.startsWith(`${from}/`)) continue;
      nodes.delete(key);
      nodes.set(`${to}${key.slice(from.length)}`, child);
    }
    nodes.delete(from);
    nodes.set(to, node);
    cb();
  };

  const session = {
    _extensions: Object.fromEntries(extensions.map((name) => [name, '1'])),
    readdir: (dir: string, cb: Callback) =>
      answer('readdir', dir, cb, () => {
        if (resolve(dir.replace(/(.)\/+$/, '$1'))?.kind !== 'dir') {
          return cb(sftpError(NO_SUCH_FILE));
        }
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        const list = [...nodes]
          .filter(
            ([path]) =>
              path.startsWith(prefix) &&
              path.length > prefix.length &&
              !path.slice(prefix.length).includes('/'),
          )
          .map(([path, node]) => {
            const filename = path.slice(prefix.length);
            return { filename, longname: longnameOf(filename, node), attrs: stats(node) };
          });
        cb(undefined, list);
      }),
    stat: (path: string, cb: Callback) =>
      answer('stat', path, cb, () => {
        const node = resolve(path);
        if (!node) return cb(sftpError(NO_SUCH_FILE));
        cb(undefined, stats(node));
      }),
    lstat: (path: string, cb: Callback) =>
      answer('lstat', path, cb, () => {
        const node = nodes.get(path);
        if (!node) return cb(sftpError(NO_SUCH_FILE));
        cb(undefined, stats(node));
      }),
    fstat: (handle: Buffer, cb: Callback) => {
      const open = openFile(handle);
      answer('fstat', open?.path ?? '', cb, () => {
        if (!open) return cb(sftpError(FAILURE));
        cb(undefined, stats(open.node));
      });
    },
    realpath: (path: string, cb: Callback) =>
      answer('realpath', path, cb, () => cb(undefined, path === '.' ? '/home/deploy' : path)),
    open: (path: string, flags: string, third: unknown, fourth?: Callback) => {
      const cb = (typeof third === 'function' ? third : fourth) as Callback;
      const attributes = (typeof third === 'function' ? {} : third) as { mode?: number };
      answer('open', path, cb, () => {
        let node: FakeNode | undefined;
        if (flags === 'r') {
          node = resolve(path);
          if (node?.kind !== 'file') return cb(sftpError(NO_SUCH_FILE));
        } else {
          if (resolve(parentOf(path))?.kind !== 'dir') return cb(sftpError(NO_SUCH_FILE));
          if (resolve(path)?.kind === 'dir') return cb(sftpError(FAILURE));
          node = {
            kind: 'file',
            content: Buffer.alloc(0),
            mode: attributes.mode ?? 0o644,
            mtime: 1_700_000_123,
          };
          nodes.set(path, node);
        }
        const handle = `h${nextHandle}`;
        nextHandle += 1;
        handles.set(handle, { path, node });
        cb(undefined, Buffer.from(handle));
      });
    },
    read: (
      handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: Callback,
    ) => {
      const open = openFile(handle);
      answer('read', open?.path ?? '', cb, () => {
        if (!open) return cb(sftpError(FAILURE));
        const data = bytesOf(open.node);
        const size = Math.min(length, options.maxRead ?? length);
        const chunk = data.subarray(position, position + size);
        chunk.copy(buffer, offset);
        if (options.truncateAt?.path === open.path && !truncated) {
          truncated = true;
          open.node.content = Buffer.from(data.subarray(0, options.truncateAt.size));
        }
        cb(undefined, chunk.length);
      });
    },
    write: (
      handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: Callback,
    ) => {
      const open = openFile(handle);
      answer('write', open?.path ?? '', cb, () => {
        if (!open) return cb(sftpError(FAILURE));
        const old = bytesOf(open.node);
        const data = Buffer.alloc(Math.max(old.length, position + length));
        old.copy(data);
        buffer.copy(data, position, offset, offset + length);
        open.node.content = data;
        cb();
      });
    },
    close: (handle: Buffer, cb: Callback) => {
      closed.push(handle.toString());
      answer('close', openFile(handle)?.path ?? '', cb, () => cb());
    },
    mkdir: (path: string, attributes: { mode?: number }, cb: Callback) =>
      answer('mkdir', path, cb, () => {
        if (nodes.has(path)) return cb(sftpError(FAILURE));
        if (resolve(parentOf(path))?.kind !== 'dir') return cb(sftpError(NO_SUCH_FILE));
        nodes.set(path, { kind: 'dir', mode: attributes.mode ?? 0o755, mtime: 9 });
        cb();
      }),
    rmdir: (path: string, cb: Callback) =>
      answer('rmdir', path, cb, () => {
        if (nodes.get(path)?.kind !== 'dir') return cb(sftpError(NO_SUCH_FILE));
        if ([...nodes.keys()].some((key) => key.startsWith(`${path}/`))) {
          return cb(sftpError(FAILURE));
        }
        nodes.delete(path);
        cb();
      }),
    unlink: (path: string, cb: Callback) =>
      answer('unlink', path, cb, () => {
        const node = nodes.get(path);
        if (!node) return cb(sftpError(NO_SUCH_FILE));
        if (node.kind === 'dir') return cb(sftpError(FAILURE));
        nodes.delete(path);
        cb();
      }),
    chmod: (path: string, mode: number, cb: Callback) =>
      answer('chmod', path, cb, () => {
        const node = resolve(path);
        if (!node) return cb(sftpError(NO_SUCH_FILE));
        node.mode = mode & 0o7777;
        cb();
      }),
    rename: (from: string, to: string, cb: Callback) =>
      answer('rename', `${from} -> ${to}`, cb, () => {
        // SFTP version 3 refuses to rename onto an existing name.
        if (nodes.has(to)) return cb(sftpError(FAILURE));
        move(from, to, cb);
      }),
    ext_openssh_rename: (from: string, to: string, cb: Callback) => {
      extended('posix-rename@openssh.com');
      answer('posix-rename', `${from} -> ${to}`, cb, () => {
        if (nodes.get(to)?.kind === 'dir') return cb(sftpError(FAILURE));
        move(from, to, cb);
      });
    },
    ext_openssh_fsync: (handle: Buffer, cb: Callback) => {
      extended('fsync@openssh.com');
      answer('fsync', openFile(handle)?.path ?? '', cb, () => cb());
    },
  };

  return {
    session,
    /** Handles closed, in order (`h0`, `h1`, ...). */
    closed,
    /** Every request as `<kind> <path>`, in the order sent. */
    ops,
    nodes,
    /** From now on, requests of `kind` (on `path`, or on any path) fail with SFTP status `code`. */
    failOn: (kind: string, path?: string, code = FAILURE): void => {
      failures.push({ kind, path, code });
    },
    /** From now on, requests of `kind` are never answered. */
    hang: (kind: string): void => {
      hung.add(kind);
    },
    /** The bytes of the file at `path`, links followed, or null. */
    bytes: (path: string): Buffer | null => {
      const node = resolve(path);
      return node?.kind === 'file' ? bytesOf(node) : null;
    },
    /** The most requests of `kind` that were waiting for an answer at once. */
    peak: (kind: string): number => peaks.get(kind) ?? 0,
    /** Handles opened and not closed yet. */
    openHandles: (): string[] => [...handles.keys()].filter((handle) => !closed.includes(handle)),
  };
}

/** Makes the connection's SFTP session `session`, failing the first `failures` starts. */
export function useSftp(connection: SshConnection, session: unknown, failures = 0) {
  const client = (connection as unknown as { client: { sftp: (cb: unknown) => void } }).client;
  let attempts = 0;
  return vi.spyOn(client, 'sftp').mockImplementation((cb: unknown) => {
    attempts += 1;
    const done = cb as (error: Error | undefined, session?: unknown) => void;
    if (attempts <= failures) setImmediate(() => done(new Error('Unable to start subsystem')));
    else setImmediate(() => done(undefined, session));
  });
}
