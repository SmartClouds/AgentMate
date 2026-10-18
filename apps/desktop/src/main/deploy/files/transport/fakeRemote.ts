import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RemoteTimeSource } from '@agentmat/core';
import { type FilesErrorCode, filesError } from '../../../../shared/deployFilesErrors';
import type { FileSiteProtocol } from '../../../../shared/deployFilesTypes';
import type { FilesConnectTarget } from '../types';
import {
  baseName,
  folderChain,
  joinRemote,
  normalizeRemote,
  parentOf,
  partPathFor,
} from './remotePath';
import type {
  OpenRemoteFiles,
  PutFileOptions,
  PutFileResult,
  RemoteCapabilities,
  RemoteEntry,
  RemoteFiles,
  RemoteStat,
} from './types';

/**
 * An in-memory server behind the `RemoteFiles` interface, for tests (E23). It passes the same
 * contract suite as the real transports (contract.ts), and its flags imitate the servers the
 * deploy run has to cope with: FTP without MLSD, no times at all, renames that refuse to replace
 * a file, uploads that break off and connections that drop.
 *
 * ```ts
 * const fake = createFakeRemote({ protocol: 'ftp', noMlsd: true });
 * fake.setFile('/srv/site/index.html', '<h1>old</h1>', { mtimeMs: 1_700_000_000_000 });
 * await deploy({ open: fake.opener, ... });
 * expect(fake.readFile('/srv/site/index.html')).toBe('<h1>new</h1>');
 * expect(fake.calls.filter((call) => call.op === 'putFile')).toHaveLength(1);
 * ```
 *
 * Uploads read the local file from disk, so tests hand it real files (a temp folder).
 */

export interface FakeRemoteOptions {
  /** Decides where times come from: `sftp` for SFTP, `mlsd` for FTP and FTPS. Default `sftp`. */
  protocol?: FileSiteProtocol;
  /** Default 4 for SFTP, 1 for FTP. */
  maxParallel?: number;
  /** The folder `realpath('.')` answers. Default `/home/deploy`. */
  home?: string;
  /** No times anywhere: listings and stat carry null, capabilities say `none`. */
  noMtime?: boolean;
  /** An FTP server without MLSD: listings carry no times, stat reads one with MDTM. */
  noMlsd?: boolean;
  /**
   * Renaming onto an existing file is refused (some FTP servers), so a replace removes the old
   * file first and reports `atomic: false`. Capabilities claim an atomic replace until that has
   * happened once, the way a real FTP transport only learns it by trying.
   */
  renameOverwriteRefused?: boolean;
  /** No posix-rename (SFTP servers other than OpenSSH): capabilities say so from the start. */
  noAtomicRename?: boolean;
  /**
   * Every upload breaks off with `unreachable` once this many of its bytes were sent, like a
   * dropped connection: the old file stays and so does the part file, and the connection is dead.
   */
  failAfterBytes?: number;
  /** Real milliseconds every call (and every 64 KB of an upload) waits, to let calls overlap. */
  latencyMs?: number;
  /**
   * The n-th call (1-based, counted over every connection) fails with `unreachable` and kills its
   * connection; later calls on it fail too. `open()` gives a working connection again.
   */
  dropConnectionAt?: number;
}

export interface FakeNode {
  kind: 'file' | 'dir';
  /** Empty for a folder. */
  content: Buffer;
  /** The exact time; what a call reports is cut to whole seconds, like the real servers. */
  mtimeMs: number;
  mode: number;
}

export interface FakeCall {
  op:
    | 'capabilities'
    | 'realpath'
    | 'list'
    | 'stat'
    | 'ensureDir'
    | 'putFile'
    | 'rename'
    | 'remove'
    | 'removeEmptyDir'
    | 'close';
  path: string | null;
  /** Which connection made the call: 1 for `remote`, then 2, 3... in `open()` order. */
  connection: number;
}

export interface FakeClock {
  now: () => number;
  set: (ms: number) => void;
  advance: (ms: number) => void;
}

export interface FakeRemote {
  /** The first connection. */
  remote: RemoteFiles;
  /** Another connection to the same server, as a reconnect would give. */
  open: () => RemoteFiles;
  /** An `OpenRemoteFiles` that hands out `open()` connections and records what it was asked. */
  opener: OpenRemoteFiles;
  /** `unattended` only when the opener was told so. */
  opened: { target: FilesConnectTarget; purpose: 'run' | 'browse'; unattended?: true }[];
  /** Every folder and file on the server by absolute path. `/` is always there. */
  nodes: Map<string, FakeNode>;
  calls: FakeCall[];
  /** The server's clock, which stamps every upload and folder made. */
  clock: FakeClock;
  /** The flags, open to change mid-test. */
  options: FakeRemoteOptions;
  /** Writes a file, making its folders. Defaults: the clock's time, mode 0644. */
  setFile: (
    path: string,
    content: string | Buffer,
    attrs?: { mtimeMs?: number; mode?: number },
  ) => void;
  setDir: (path: string, attrs?: { mtimeMs?: number; mode?: number }) => void;
  /** Removes a file or a folder with everything in it, like someone working on the server. */
  delete: (path: string) => void;
  readFile: (path: string) => string | null;
  readBytes: (path: string) => Buffer | null;
  modeOf: (path: string) => number | null;
  setMode: (path: string, mode: number) => void;
  /** Every path on the server except `/`, sorted. */
  paths: () => string[];
  /** Makes every call on `path` fail with `code`, until `failOn(path, null)`. */
  failOn: (path: string, code: FilesErrorCode | null) => void;
}

const DEFAULT_START_MS = 1_700_000_000_000;
const CHUNK_BYTES = 64 * 1024;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createFakeRemote(initial: FakeRemoteOptions = {}): FakeRemote {
  const options: FakeRemoteOptions = { ...initial };
  const protocol = options.protocol ?? 'sftp';
  const home = options.home ?? '/home/deploy';
  let now = DEFAULT_START_MS;
  let callCount = 0;
  let connections = 0;
  let learnedNotAtomic = false;
  const nodes = new Map<string, FakeNode>();
  const calls: FakeCall[] = [];
  const failures = new Map<string, FilesErrorCode>();
  const opened: FakeRemote['opened'] = [];
  nodes.set('/', { kind: 'dir', content: Buffer.alloc(0), mtimeMs: now, mode: 0o755 });

  const clock: FakeClock = {
    now: () => now,
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };

  const reported = (mtimeMs: number): number => Math.floor(mtimeMs / 1000) * 1000;
  const listVia = (): RemoteTimeSource | null => {
    if (options.noMtime || options.noMlsd) return null;
    return protocol === 'sftp' ? 'sftp' : 'mlsd';
  };
  const statVia = (): RemoteTimeSource | null => {
    if (options.noMtime) return null;
    return options.noMlsd ? 'mdtm' : listVia();
  };

  function makeDirs(path: string, attrs: { mtimeMs?: number; mode?: number } = {}): boolean {
    let made = false;
    for (const dir of folderChain(path)) {
      const node = nodes.get(dir);
      if (node?.kind === 'file') throw filesError('server', `${dir} is a file, not a folder.`);
      if (node) continue;
      nodes.set(dir, {
        kind: 'dir',
        content: Buffer.alloc(0),
        mtimeMs: attrs.mtimeMs ?? now,
        mode: attrs.mode ?? 0o755,
      });
      made = dir === normalizeRemote(path);
    }
    return made;
  }

  function childrenOf(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    return [...nodes.keys()].filter(
      (path) => path !== dir && path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    );
  }

  function statOf(path: string, via: RemoteTimeSource | null): RemoteStat | null {
    const node = nodes.get(normalizeRemote(path));
    if (!node) return null;
    return {
      isDirectory: node.kind === 'dir',
      size: node.kind === 'dir' ? 0 : node.content.length,
      mtimeMs: via ? reported(node.mtimeMs) : null,
      via,
    };
  }

  function connection(): RemoteFiles {
    connections += 1;
    const id = connections;
    let closed = false;
    let dropped = false;

    async function begin(op: FakeCall['op'], path: string | null): Promise<void> {
      calls.push({ op, path, connection: id });
      if (closed) throw filesError('unreachable', 'The connection is closed.');
      if (dropped) throw filesError('unreachable', 'The connection dropped.');
      callCount += 1;
      if (options.dropConnectionAt !== undefined && callCount === options.dropConnectionAt) {
        dropped = true;
        throw filesError('unreachable', 'The connection dropped.');
      }
      if (options.latencyMs) await delay(options.latencyMs);
      const failure = path === null ? undefined : failures.get(normalizeRemote(path));
      if (failure) throw filesError(failure, `The server refused ${path}.`);
    }

    async function putFile(
      localPath: string,
      remotePath: string,
      put: PutFileOptions,
    ): Promise<PutFileResult> {
      await begin('putFile', remotePath);
      const target = normalizeRemote(remotePath);
      const folder = parentOf(target) ?? '/';
      if (nodes.get(folder)?.kind !== 'dir') {
        throw filesError('remoteFolderMissing', `The folder ${folder} is not on the server.`);
      }
      const existing = nodes.get(target);
      if (existing?.kind === 'dir') throw filesError('server', `${target} is a folder.`);

      const bytes = await readFile(localPath);
      const part = partPathFor(target);
      const partNode: FakeNode = {
        kind: 'file',
        content: Buffer.alloc(0),
        mtimeMs: now,
        mode: 0o644,
      };
      nodes.set(part, partNode);
      const hash = createHash('sha256');
      let sent = 0;
      while (sent < bytes.length || sent === 0) {
        if (put.signal?.aborted) {
          nodes.delete(part);
          throw filesError('cancelled', 'The upload was cancelled.');
        }
        const chunk = bytes.subarray(sent, sent + CHUNK_BYTES);
        if (options.failAfterBytes !== undefined && sent + chunk.length > options.failAfterBytes) {
          partNode.content = Buffer.concat([
            partNode.content,
            chunk.subarray(0, Math.max(0, options.failAfterBytes - sent)),
          ]);
          dropped = true;
          throw filesError('unreachable', 'The connection dropped during the upload.');
        }
        if (options.latencyMs) await delay(options.latencyMs);
        hash.update(chunk);
        partNode.content = Buffer.concat([partNode.content, chunk]);
        sent += chunk.length;
        put.onBytes?.(sent);
        if (bytes.length === 0) break;
      }
      if (put.signal?.aborted) {
        nodes.delete(part);
        throw filesError('cancelled', 'The upload was cancelled.');
      }
      if (hash.digest('hex') !== put.sha256) {
        nodes.delete(part);
        throw filesError('localChanged', `${localPath} changed after the plan was made.`);
      }

      let atomic = true;
      if (existing && (options.noAtomicRename || options.renameOverwriteRefused)) {
        atomic = false;
        if (options.renameOverwriteRefused) learnedNotAtomic = true;
        nodes.delete(target);
      }
      nodes.delete(part);
      nodes.set(target, { ...partNode, mtimeMs: now, mode: existing?.mode ?? 0o644 });
      return { stat: statOf(target, statVia()) as RemoteStat, atomic };
    }

    return {
      protocol,
      maxParallel: options.maxParallel ?? (protocol === 'sftp' ? 4 : 1),
      async capabilities(): Promise<RemoteCapabilities> {
        await begin('capabilities', null);
        return {
          atomicReplace: !options.noAtomicRename && !learnedNotAtomic,
          mtime: options.noMtime ? 'none' : options.noMlsd ? 'mdtm' : 'exact',
        };
      },
      async realpath(path) {
        await begin('realpath', path);
        return path.startsWith('/') ? normalizeRemote(path) : joinRemote(home, path);
      },
      async list(dir): Promise<RemoteEntry[] | null> {
        await begin('list', dir);
        const folder = normalizeRemote(dir);
        if (nodes.get(folder)?.kind !== 'dir') return null;
        return childrenOf(folder).map((path) => ({
          name: baseName(path),
          path,
          ...(statOf(path, listVia()) as RemoteStat),
        }));
      },
      async stat(path) {
        await begin('stat', path);
        return statOf(path, statVia());
      },
      async ensureDir(path) {
        await begin('ensureDir', path);
        return makeDirs(path);
      },
      putFile,
      async rename(from, to) {
        await begin('rename', from);
        const source = normalizeRemote(from);
        const target = normalizeRemote(to);
        const node = nodes.get(source);
        if (node?.kind !== 'file') throw filesError('server', `${from} is not a file.`);
        if (nodes.has(target)) throw filesError('server', `${to} is already there.`);
        nodes.delete(source);
        nodes.set(target, node);
      },
      async remove(path) {
        await begin('remove', path);
        const node = nodes.get(normalizeRemote(path));
        if (node?.kind === 'dir') throw filesError('server', `${path} is a folder.`);
        nodes.delete(normalizeRemote(path));
      },
      async removeEmptyDir(path) {
        await begin('removeEmptyDir', path);
        const folder = normalizeRemote(path);
        if (nodes.get(folder)?.kind !== 'dir' || childrenOf(folder).length > 0) return false;
        nodes.delete(folder);
        return true;
      },
      async close() {
        calls.push({ op: 'close', path: null, connection: id });
        closed = true;
      },
    };
  }

  const remote = connection();

  return {
    remote,
    open: connection,
    opener: async (target, openOptions) => {
      opened.push({
        target,
        purpose: openOptions.purpose,
        ...(openOptions.unattended ? { unattended: true as const } : {}),
      });
      return connection();
    },
    opened,
    nodes,
    calls,
    clock,
    options,
    setFile: (path, content, attrs = {}) => {
      const target = normalizeRemote(path);
      makeDirs(parentOf(target) ?? '/');
      nodes.set(target, {
        kind: 'file',
        content: typeof content === 'string' ? Buffer.from(content) : content,
        mtimeMs: attrs.mtimeMs ?? now,
        mode: attrs.mode ?? 0o644,
      });
    },
    setDir: (path, attrs) => {
      makeDirs(path, attrs);
    },
    delete: (path) => {
      const target = normalizeRemote(path);
      for (const key of [...nodes.keys()]) {
        if (key === target || key.startsWith(`${target}/`)) nodes.delete(key);
      }
    },
    readFile: (path) => {
      const node = nodes.get(normalizeRemote(path));
      return node?.kind === 'file' ? node.content.toString('utf8') : null;
    },
    readBytes: (path) => {
      const node = nodes.get(normalizeRemote(path));
      return node?.kind === 'file' ? node.content : null;
    },
    modeOf: (path) => nodes.get(normalizeRemote(path))?.mode ?? null,
    setMode: (path, mode) => {
      const node = nodes.get(normalizeRemote(path));
      if (node) node.mode = mode;
    },
    paths: () => [...nodes.keys()].filter((path) => path !== '/').sort(),
    failOn: (path, code) => {
      if (code) failures.set(normalizeRemote(path), code);
      else failures.delete(normalizeRemote(path));
    },
  };
}
