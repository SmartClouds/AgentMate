import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  type FilesErrorCode,
  filesError,
  filesErrorCode,
  filesErrorMessage,
} from '../../shared/deployFilesErrors';
import { nextFreeName } from '../../shared/sftpNames';
import {
  SFTP_FAILURES_PER_BATCH,
  SFTP_MAX_ITEMS_PER_BATCH,
  SFTP_TRANSFER_CONCURRENCY,
  type SftpBatchFinished,
  type SftpBatchState,
  type SftpBatchView,
  type SftpChmodInput,
  type SftpChmodScope,
  type SftpConflict,
  type SftpConflictAction,
  type SftpConflictDecision,
  type SftpConflictPolicy,
  type SftpDownloadInput,
  type SftpItemState,
  type SftpItemView,
  type SftpJobKind,
  type SftpQueueSnapshot,
  type SftpTarget,
  type SftpUploadInput,
} from '../../shared/sftpTypes';
import { sshErrorCode, sshErrorMessage } from '../../shared/sshErrors';
import { mapSftpError, mapSshConnectError } from '../deploy/files/transport/errors';
import {
  baseName,
  joinRemote,
  normalizeRemote,
  parentOf,
} from '../deploy/files/transport/remotePath';
import type { FileUploadOptions, SftpFileClient } from './client';
import { assertContained, safeLocalName } from './localNames';
import { RateMeter } from './rate';
import { chmodRecursive, type RemoteOpResult, removeRecursive } from './remoteOps';
import {
  type RemoteListingCache,
  remoteEntryOf,
  type WalkResult,
  walkLocal,
  walkRemote,
} from './walk';

/**
 * The transfer queue of one SFTP session (E25): uploads, downloads, deletes and chmods, each
 * request a batch of items, run at most `concurrency` items at a time across every batch.
 *
 * Batches. An upload or download first walks the selected folders (state `expanding`, totals
 * null) into one item per file and folder, pre-order, so a folder is made before anything goes
 * into it; an empty folder is made too, a folder already at the target is merged into, and a
 * file standing where a folder is needed fails that folder and everything under it with
 * `exists`. Links to folders and broken links are never followed (D12): they become `skipped`
 * items. Delete and chmod batches have one item per selected path, done with remoteOps.
 *
 * Conflicts (D9). Right before a file transfers its target is looked at. When something is
 * there, the item's own answer applies, else its batch's policy:
 * - `overwrite` sends it (a folder at the target cannot be overwritten: the item fails with
 *   `invalidInput`), `skip` leaves it (`skipped`), `rename` sends it under the next free
 *   `name (N).ext`, found by listing the target folder;
 * - `ask` parks the item (state `conflict`) and gives up its slot. Its batch shows `waiting` and
 *   starts nothing new until every conflict of it is answered; other batches carry on.
 * Parked conflicts queue up oldest first; the snapshot shows only the first (`conflict`) and
 * counts the rest (`pendingConflicts`). `resolveConflict` answers one: overwrite and rename put the
 * item back in the queue with that answer (it is looked at again when it runs), skip ends it.
 * `applyToAll` makes the answer the batch's policy, so the batch's other parked conflicts are
 * released under it now and its later ones never ask. Overwrite is refused (`invalidInput`, the
 * conflict stays) when the target is a folder. Cancelling a batch drops its conflicts.
 *
 * Connection (D1). Transfers use a connection of their own, `deps.transferClient()`, opened on
 * first use and kept while the queue works. Once nothing has moved for `idleReleaseMs` it is
 * handed back with `deps.releaseTransferClient()`. An item that fails because the connection
 * dropped (`unreachable`) is put back once and runs again on a fresh connection; a connection
 * that cannot be opened fails every queued item with that error, rather than trying again for
 * each of them.
 *
 * Reporting. Snapshots go out through `deps.emit` at most once every `coalesceMs`, and only after
 * something changed. `deps.finished` fires once for every batch that ends (again after a retry
 * ends it again), right away. `deps.busy` says when items start moving or walks start (true) and
 * when the last one settles (false); a batch only waiting on a conflict is not busy. Errors in
 * item views are the `[files:*]` code and its message without the tag; SFTP statuses and Node
 * file errors are coded first.
 */

export interface LocalFileStat {
  size: number;
  mtimeMs: number;
}

export interface TransferEngineDeps {
  /** Carried by every snapshot and finished event. */
  sessionId: string;
  /** Opens the connection transfers use (the pool's `openSeparate`). Called again after a release. */
  transferClient(): Promise<SftpFileClient>;
  /** Gives back the connection `transferClient` answered. */
  releaseTransferClient(): void;
  emit(snapshot: SftpQueueSnapshot): void;
  finished(event: SftpBatchFinished): void;
  /** True when work starts moving, false when it has all settled. */
  busy(running: boolean): void;
  now?: () => number;
  /** Items running at once across all batches. Default `SFTP_TRANSFER_CONCURRENCY`. */
  concurrency?: number;
  /** Least time between two snapshots. Default 100 ms. */
  coalesceMs?: number;
  /** How long the transfer connection is kept with nothing to do. Default 30 s. */
  idleReleaseMs?: number;
  /** Size and mtime of a local file, read before and after it is sent. Default `fs.stat`. */
  localStat?: (path: string) => Promise<LocalFileStat>;
  /** Decides whether uploads carry the local mode (not on Windows). Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Most items one batch may expand to. Default `SFTP_MAX_ITEMS_PER_BATCH`. */
  maxItems?: number;
  /** Batch and conflict ids. Default `randomUUID`. */
  randomId?: () => string;
}

export interface TransferEngine {
  /** Queues local files and folders for `remoteDir`; answers the batch id. */
  enqueueUpload(input: SftpUploadInput): string;
  /** Queues remote files and folders for `localDir`, which the caller has already checked. */
  enqueueDownload(input: SftpDownloadInput): string;
  enqueueDelete(paths: string[]): string;
  enqueueChmod(input: SftpChmodInput): string;
  /** Answers a parked conflict. `[files:invalidInput]` for an unknown id or overwriting a folder. */
  resolveConflict(conflictId: string, decision: SftpConflictDecision): void;
  /** Cancels an item (and what is under it), a batch, or everything. Cancelled is not failed. */
  cancel(target?: SftpTarget): void;
  /** Queues failed and cancelled items again: of an item (with what is above and under it), a batch, or all. */
  retry(target?: SftpTarget): void;
  /** Drops the batches that are over. */
  clearFinished(): void;
  snapshot(): SftpQueueSnapshot;
  /** Batches not over yet, waiting ones included. */
  activeCount(): number;
  /** Stops everything, waits for it to settle and gives the connection back. Nothing is sent after. */
  dispose(): Promise<void>;
}

const DEFAULT_COALESCE_MS = 100;
const DEFAULT_IDLE_RELEASE_MS = 30_000;
/** How far past the first queued item of a batch the scheduler looks for one it can start. */
const SCAN_LIMIT = 512;
/** How often Keep both lists a folder again when the names it remembered keep turning out taken. */
const FREE_NAME_ATTEMPTS = 3;

const ABANDONED: ReadonlySet<SftpItemState> = new Set<SftpItemState>([
  'skipped',
  'failed',
  'cancelled',
]);

type Outcome = 'done' | 'skipped' | 'parked';

interface Item {
  id: string;
  batch: Batch;
  /** Position in `batch.items`, set whenever the list is rebuilt. */
  index: number;
  /** Below the batch's source, `/` between the parts. */
  relPath: string;
  /** The name at the target; Keep both changes it. */
  name: string;
  originalName: string;
  /** Absolute path of what is sent (local for an upload, remote otherwise). */
  source: string;
  /** The folder it goes into (remote for an upload, local for a download). */
  targetDir: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  mode: number | null;
  /** The folder item that has to be made first. */
  parent: Item | null;
  /** For a root: the items its walk found. */
  descendants: Item[];
  state: SftpItemState;
  transferred: number;
  /** Bytes this item will no longer send, counted while it is skipped, failed or cancelled. */
  abandoned: number;
  error: string | null;
  errorCode: FilesErrorCode | null;
  /** A link the walk did not follow. */
  linkSkip: boolean;
  /** A root whose walk has not finished yet; it is walked again when it is retried. */
  unexpanded: boolean;
  decision: SftpConflictAction | null;
  conflict: SftpConflict | null;
  /** Already put back once after the connection dropped. */
  retried: boolean;
  /** Aborts the item while it runs, or a root's walk while it is walked. */
  abort: AbortController | null;
  /** The target this item holds in `Engine.claims` while it runs. */
  claimKey: string | null;
}

/** What a batch has let go of once it ended, counted here so totals and labels stay right. */
interface Dropped {
  items: number;
  counts: Record<SftpItemState, number>;
  fileCount: number;
  totalBytes: number;
  transferredBytes: number;
  abandonedBytes: number;
}

interface Batch {
  id: string;
  kind: SftpJobKind;
  source: string;
  /** Upload: the remote folder. Download: the local folder. Null for delete and chmod. */
  target: string | null;
  /** The folder `finished` names for the pane to refresh. */
  refresh: string | null;
  policy: SftpConflictPolicy;
  chmod: { mode: number; scope: SftpChmodScope } | null;
  createdAt: number;
  finishedAt: number | null;
  roots: Item[];
  items: Item[];
  /** No queued item comes before this index. */
  cursor: number;
  nextItemId: number;
  expanding: boolean;
  expandAbort: AbortController | null;
  /** An item has started at least once. */
  started: boolean;
  reported: boolean;
  rate: RateMeter;
  counts: Record<SftpItemState, number>;
  running: Set<Item>;
  /** Failed items in the order they failed, so a snapshot never walks the whole batch. */
  failed: Set<Item>;
  /** Local targets this batch's downloads wrote, keyed like `claims`. */
  written: Map<string, { size: number; mtimeMs: number }>;
  /** Names in a target folder, listed once per batch for Keep both (case-folded where it does not count). */
  names: Map<string, Promise<Set<string>>>;
  dropped: Dropped;
  fileCount: number;
  totalBytes: number;
  transferredBytes: number;
  abandonedBytes: number;
}

function emptyDropped(): Dropped {
  return {
    items: 0,
    counts: emptyCounts(),
    fileCount: 0,
    totalBytes: 0,
    transferredBytes: 0,
    abandonedBytes: 0,
  };
}

function emptyCounts(): Record<SftpItemState, number> {
  return { queued: 0, running: 0, conflict: 0, done: 0, skipped: 0, failed: 0, cancelled: 0 };
}

function carriesBytes(item: Item): boolean {
  return !item.isDirectory && !item.linkSkip;
}

function isGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** An error from Node's file system calls, which name the system call they failed in. */
function isLocalFsError(error: unknown): error is NodeJS.ErrnoException {
  const fields = error as { code?: unknown; syscall?: unknown } | null;
  return typeof fields?.code === 'string' && typeof fields.syscall === 'string';
}

function localError(error: NodeJS.ErrnoException, path: string): Error {
  switch (error.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return filesError('folderMissing', `${path} is not on this computer any more.`);
    case 'EACCES':
    case 'EPERM':
      return filesError('permissionDenied', `This computer refused access to ${path}.`);
    case 'ENOSPC':
      return filesError('diskFull', `This computer has no room left for ${path}.`);
    case 'EEXIST':
      return filesError('exists', `${path} is already there.`);
    case 'EBUSY':
      return filesError('server', `${path} is in use by another program.`);
    default:
      return filesError('server', `${path} could not be used here: ${error.message}`);
  }
}

/** Any failure as a `[files:*]` error: SFTP statuses, dropped connections and local file errors. */
function codedError(error: unknown, path: string): Error {
  if (filesErrorCode(error)) return error as Error;
  const ssh = sshErrorCode(error);
  if (ssh === 'vault-locked') return filesError('vaultLocked', sshErrorMessage(error));
  if (ssh === 'host-key-changed') return filesError('hostKeyChanged', sshErrorMessage(error));
  if (ssh) return filesError('auth', sshErrorMessage(error));
  if (isLocalFsError(error)) return localError(error, path);
  return mapSftpError(error, path);
}

/** A failure to open the transfer connection, coded the way a login failure is. */
function openError(error: unknown): Error {
  if (filesErrorCode(error) || sshErrorCode(error)) return codedError(error, '');
  return mapSshConnectError(error);
}

function cancelledError(): Error {
  return filesError('cancelled', 'The transfer was cancelled.');
}

/** One error for a delete or chmod with failures inside: the first, and how many more. */
function opFailure(result: RemoteOpResult, verb: string): Error {
  const first = result.firstError;
  const more = result.failed - 1;
  const message = `${filesErrorMessage(first)}${more > 0 ? ` ${more} more could not be ${verb} either.` : ''}`;
  return filesError(filesErrorCode(first) ?? 'server', message);
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

class Engine implements TransferEngine {
  private readonly batches: Batch[] = [];
  /** Conflicts waiting for an answer, oldest first. */
  private readonly parked: Item[] = [];
  /**
   * Targets of the files being sent right now, across batches, keyed by `targetKey`. Two items
   * whose names meet at the target (`a:b` and `a_b` downloaded to Windows, `README` and `Readme`
   * where case does not count) cannot both find the target empty before either has written it.
   */
  private readonly claims = new Map<string, Item>();
  private readonly inFlight = new Set<Promise<void>>();
  private active = 0;
  private current: SftpFileClient | null = null;
  private opening: Promise<SftpFileClient> | null = null;
  private busyNow = false;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly coalesceMs: number;
  private readonly idleReleaseMs: number;
  private readonly localStat: (path: string) => Promise<LocalFileStat>;
  private readonly platform: NodeJS.Platform;
  private readonly maxItems: number;
  private readonly randomId: () => string;

  constructor(private readonly deps: TransferEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.concurrency = Math.max(1, deps.concurrency ?? SFTP_TRANSFER_CONCURRENCY);
    this.coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.idleReleaseMs = deps.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
    this.localStat =
      deps.localStat ??
      (async (path) => {
        const info = await stat(path);
        return { size: info.size, mtimeMs: info.mtimeMs };
      });
    this.platform = deps.platform ?? process.platform;
    this.maxItems = deps.maxItems ?? SFTP_MAX_ITEMS_PER_BATCH;
    this.randomId = deps.randomId ?? randomUUID;
  }

  // Queueing.

  enqueueUpload(input: SftpUploadInput): string {
    const paths = this.checkPaths(input.localPaths, (path) => basename(path));
    const remoteDir = normalizeRemote(input.remoteDir);
    const batch = this.addBatch('upload', {
      source: dirname(paths[0]),
      target: remoteDir,
      refresh: remoteDir,
      policy: input.policy ?? 'ask',
    });
    for (const path of paths) {
      const name = basename(path);
      this.addRoot(batch, { relPath: name, name, source: path, targetDir: remoteDir });
    }
    this.expand(batch);
    return batch.id;
  }

  enqueueDownload(input: SftpDownloadInput): string {
    const paths = this.checkPaths(input.remotePaths.map(normalizeRemote), baseName);
    const batch = this.addBatch('download', {
      source: parentOf(paths[0]) ?? '/',
      target: input.localDir,
      refresh: input.localDir,
      policy: input.policy ?? 'ask',
    });
    for (const path of paths) {
      const name = baseName(path);
      this.addRoot(batch, {
        relPath: name,
        name: safeLocalName(name, this.platform).name,
        source: path,
        targetDir: input.localDir,
      });
    }
    this.expand(batch);
    return batch.id;
  }

  enqueueDelete(paths: string[]): string {
    return this.enqueueRemoteOp('delete', paths, null);
  }

  enqueueChmod(input: SftpChmodInput): string {
    return this.enqueueRemoteOp('chmod', input.paths, { mode: input.mode, scope: input.recursive });
  }

  private enqueueRemoteOp(
    kind: 'delete' | 'chmod',
    rawPaths: string[],
    chmod: Batch['chmod'],
  ): string {
    const paths = this.checkPaths(rawPaths.map(normalizeRemote), () => 'ok');
    const folders = new Set(paths.map((path) => parentOf(path) ?? '/'));
    const batch = this.addBatch(kind, {
      source: parentOf(paths[0]) ?? '/',
      target: null,
      refresh: folders.size === 1 ? [...folders][0] : null,
      policy: 'ask',
    });
    batch.chmod = chmod;
    for (const path of paths) {
      const name = baseName(path) || path;
      const root = this.addRoot(batch, { relPath: name, name, source: path, targetDir: '' });
      root.unexpanded = false;
    }
    this.rebuild(batch);
    this.pump();
    return batch.id;
  }

  private checkPaths(paths: string[], nameOf: (path: string) => string): string[] {
    this.checkOpen();
    if (paths.length === 0) throw filesError('invalidInput', 'Nothing was selected.');
    if (paths.some((path) => !nameOf(path))) {
      throw filesError('invalidInput', 'A whole drive or the root folder cannot be transferred.');
    }
    return paths;
  }

  private checkOpen(): void {
    if (this.disposed) throw filesError('invalidInput', 'This SFTP session is closed.');
  }

  private addBatch(
    kind: SftpJobKind,
    fields: Pick<Batch, 'source' | 'target' | 'refresh' | 'policy'>,
  ): Batch {
    const batch: Batch = {
      id: this.randomId(),
      kind,
      ...fields,
      chmod: null,
      createdAt: this.now(),
      finishedAt: null,
      roots: [],
      items: [],
      cursor: 0,
      nextItemId: 1,
      expanding: false,
      expandAbort: null,
      started: false,
      reported: false,
      rate: new RateMeter(this.now),
      counts: emptyCounts(),
      running: new Set(),
      failed: new Set(),
      written: new Map(),
      names: new Map(),
      dropped: emptyDropped(),
      fileCount: 0,
      totalBytes: 0,
      transferredBytes: 0,
      abandonedBytes: 0,
    };
    this.batches.push(batch);
    this.markDirty();
    return batch;
  }

  private newItem(
    batch: Batch,
    fields: Pick<Item, 'relPath' | 'name' | 'source' | 'targetDir'> & Partial<Item>,
  ): Item {
    const item: Item = {
      id: String(batch.nextItemId),
      batch,
      index: 0,
      originalName: fields.name,
      isDirectory: false,
      size: 0,
      mtimeMs: 0,
      mode: null,
      parent: null,
      descendants: [],
      state: 'queued',
      transferred: 0,
      abandoned: 0,
      error: null,
      errorCode: null,
      linkSkip: false,
      unexpanded: false,
      decision: null,
      conflict: null,
      retried: false,
      abort: null,
      claimKey: null,
      ...fields,
    };
    batch.nextItemId += 1;
    return item;
  }

  private addRoot(
    batch: Batch,
    fields: Pick<Item, 'relPath' | 'name' | 'source' | 'targetDir'>,
  ): Item {
    const root = this.newItem(batch, { ...fields, unexpanded: true });
    batch.roots.push(root);
    return root;
  }

  /**
   * Lays the roots and what their walks found out in order, and recounts everything, adding what
   * the batch already let go of.
   */
  private rebuild(batch: Batch): void {
    const { dropped } = batch;
    batch.items = batch.roots.flatMap((root) => [root, ...root.descendants]);
    batch.counts = { ...dropped.counts };
    batch.running.clear();
    batch.failed.clear();
    batch.fileCount = dropped.fileCount;
    batch.totalBytes = dropped.totalBytes;
    batch.transferredBytes = dropped.transferredBytes;
    batch.abandonedBytes = dropped.abandonedBytes;
    batch.cursor = 0;
    for (const [index, item] of batch.items.entries()) {
      item.index = index;
      batch.counts[item.state] += 1;
      if (item.state === 'running') batch.running.add(item);
      if (item.state === 'failed') batch.failed.add(item);
      if (!carriesBytes(item)) continue;
      batch.fileCount += 1;
      batch.totalBytes += item.size;
      batch.transferredBytes += item.transferred;
      if (ABANDONED.has(item.state)) {
        item.abandoned = Math.max(0, item.size - item.transferred);
        batch.abandonedBytes += item.abandoned;
      }
    }
  }

  /**
   * Once a batch is over, keeps only what a retry needs: its roots and its failed and cancelled
   * items (a failed folder's contents failed with it, and the folders above an item stay
   * reachable through `parent`). Everything else is counted in `dropped` and let go of.
   */
  private compact(batch: Batch): void {
    const { dropped } = batch;
    for (const root of batch.roots) {
      const kept: Item[] = [];
      for (const item of root.descendants) {
        if (item.state === 'failed' || item.state === 'cancelled') {
          kept.push(item);
          continue;
        }
        dropped.items += 1;
        dropped.counts[item.state] += 1;
        if (!carriesBytes(item)) continue;
        dropped.fileCount += 1;
        dropped.totalBytes += item.size;
        dropped.transferredBytes += item.transferred;
        if (ABANDONED.has(item.state)) dropped.abandonedBytes += item.abandoned;
      }
      root.descendants = kept;
    }
    batch.written.clear();
    batch.names.clear();
    this.rebuild(batch);
  }

  // Expansion: walking the selected folders into items.

  /**
   * Walks the roots of `batch` that have not been walked yet, then lets the batch run. While a
   * walk is already going, the roots queued meanwhile (a retry) are walked when it ends.
   */
  private expand(batch: Batch): void {
    if (batch.expanding) return;
    this.rebuild(batch);
    const roots = batch.roots.filter((root) => root.unexpanded && root.state === 'queued');
    if (roots.length === 0) {
      this.pump();
      return;
    }
    const controller = new AbortController();
    batch.expanding = true;
    batch.expandAbort = controller;
    this.markDirty();
    this.updateBusy();
    const work = this.expandRoots(batch, roots, controller.signal).finally(() => {
      batch.expanding = false;
      batch.expandAbort = null;
      this.rebuild(batch);
      this.inFlight.delete(work);
      const waiting = batch.roots.some((root) => root.unexpanded && root.state === 'queued');
      if (waiting && !this.disposed) this.expand(batch);
      this.settled(batch);
    });
    this.inFlight.add(work);
  }

  private async expandRoots(batch: Batch, roots: Item[], signal: AbortSignal): Promise<void> {
    let client: SftpFileClient | null = null;
    if (batch.kind === 'download') {
      try {
        client = await this.client();
      } catch (error) {
        const coded = openError(error);
        for (const root of roots) if (root.state === 'queued') this.setFailed(root, coded);
        return;
      }
    }
    const cache: RemoteListingCache = new Map();
    for (const root of roots) {
      if (signal.aborted || root.state !== 'queued') continue;
      // Its own abort, so cancelling this root stops its walk and lets the next root's start.
      const walk = new AbortController();
      const abortWalk = (): void => walk.abort();
      signal.addEventListener('abort', abortWalk, { once: true });
      root.abort = walk;
      try {
        // What the walk may add once the rest of the batch and the root itself are counted.
        const budget = this.maxItems - this.itemsBesides(batch, root);
        const descendants = client
          ? await this.expandRemote(batch, root, client, cache, walk.signal, budget)
          : await this.expandLocal(batch, root, walk.signal, budget);
        if (root.state !== 'queued') continue;
        root.descendants = descendants;
        root.unexpanded = false;
      } catch (error) {
        // An abort comes from cancel, which already set the root's state; a root queued again
        // since (a retry) stays queued and is walked once this walk ends.
        if (root.state !== 'queued' || walk.signal.aborted) continue;
        this.setFailed(root, codedError(error, root.source));
      } finally {
        signal.removeEventListener('abort', abortWalk);
        root.abort = null;
      }
    }
  }

  /** Items the batch holds outside `root`'s walk, `root` itself included. */
  private itemsBesides(batch: Batch, root: Item): number {
    let count = 0;
    for (const other of batch.roots) count += other === root ? 1 : 1 + other.descendants.length;
    return count;
  }

  private skipLink(root: Item, isDirectory: boolean): Item[] {
    root.linkSkip = true;
    root.isDirectory = isDirectory;
    root.unexpanded = false;
    this.setState(root, 'skipped');
    return [];
  }

  private async expandLocal(
    batch: Batch,
    root: Item,
    signal: AbortSignal,
    budget: number,
  ): Promise<Item[]> {
    let info: Stats;
    try {
      info = await lstat(root.source);
    } catch (error) {
      if (isGone(error)) {
        throw filesError('folderMissing', `${root.source} is not on this computer any more.`);
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      const target = await stat(root.source).catch(() => null);
      if (!target?.isFile()) return this.skipLink(root, target?.isDirectory() ?? false);
      info = target;
    }
    root.mtimeMs = info.mtimeMs;
    root.mode = info.mode & 0o7777;
    if (info.isFile()) {
      root.size = info.size;
      return [];
    }
    if (!info.isDirectory()) {
      throw filesError('invalidInput', `${root.source} is neither a file nor a folder.`);
    }
    root.isDirectory = true;
    const walk = await walkLocal(root.source, { signal, maxItems: budget });
    return this.itemsOfWalk(batch, root, walk, (relPath) =>
      join(root.source, ...relPath.split('/')),
    );
  }

  private async expandRemote(
    batch: Batch,
    root: Item,
    client: SftpFileClient,
    cache: RemoteListingCache,
    signal: AbortSignal,
    budget: number,
  ): Promise<Item[]> {
    const entry = await remoteEntryOf(client, root.source, cache);
    if (!entry) throw filesError('remoteFolderMissing', `${root.source} is not on the server.`);
    if (entry.isSymlink && (entry.brokenLink || entry.isDirectory)) {
      return this.skipLink(root, entry.isDirectory);
    }
    root.mtimeMs = entry.mtimeMs;
    root.mode = entry.mode;
    if (entry.isFile) {
      root.size = entry.size;
      return [];
    }
    if (!entry.isDirectory) {
      throw filesError('invalidInput', `${root.source} is neither a file nor a folder.`);
    }
    root.isDirectory = true;
    const walk = await walkRemote(client, root.source, { signal, maxItems: budget });
    return this.itemsOfWalk(batch, root, walk, (relPath) => joinRemote(root.source, relPath));
  }

  /** One item per walked entry, each tied to the folder item it goes into. */
  private itemsOfWalk(
    batch: Batch,
    root: Item,
    walk: WalkResult,
    sourceOf: (relPath: string) => string,
  ): Item[] {
    const folders = new Map<string, Item>([['', root]]);
    const items: Item[] = [];
    const add = (relPath: string, fields: Partial<Item>): Item => {
      const cut = relPath.lastIndexOf('/');
      const parent = folders.get(cut < 0 ? '' : relPath.slice(0, cut)) ?? root;
      const segment = relPath.slice(cut + 1);
      const name = batch.kind === 'download' ? safeLocalName(segment, this.platform).name : segment;
      const item = this.newItem(batch, {
        relPath: `${root.relPath}/${relPath}`,
        name,
        source: sourceOf(relPath),
        targetDir: this.targetPath(parent),
        parent,
        ...fields,
      });
      items.push(item);
      return item;
    };
    for (const entry of walk.items) {
      const item = add(entry.relPath, {
        isDirectory: entry.isDirectory,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        mode: entry.mode,
      });
      if (entry.isDirectory) folders.set(entry.relPath, item);
    }
    for (const relPath of walk.skippedLinks) add(relPath, { linkSkip: true, state: 'skipped' });
    return items;
  }

  /** Where an item ends up: its target folder and its (possibly renamed) name. */
  private targetPath(item: Item): string {
    return item.batch.kind === 'upload'
      ? joinRemote(item.targetDir, item.name)
      : join(item.targetDir, item.name);
  }

  // Scheduling.

  private pump(): void {
    if (this.disposed) return;
    while (this.active < this.concurrency) {
      const next = this.nextRunnable();
      if (!next) break;
      this.start(next);
    }
    this.updateBusy();
  }

  private nextRunnable(): Item | null {
    for (const batch of this.batches) {
      if (batch.expanding || batch.counts.conflict > 0 || batch.counts.queued === 0) continue;
      const item = this.nextInBatch(batch);
      if (item) return item;
    }
    return null;
  }

  /** The first queued item whose folder has been made, looking a little past any that wait on theirs. */
  private nextInBatch(batch: Batch): Item | null {
    const { items } = batch;
    while (batch.cursor < items.length && items[batch.cursor].state !== 'queued') batch.cursor += 1;
    const end = Math.min(items.length, batch.cursor + SCAN_LIMIT);
    for (let index = batch.cursor; index < end; index += 1) {
      const item = items[index];
      if (item.state !== 'queued' || item.unexpanded) continue;
      if (!item.parent || item.parent.state === 'done') return item;
    }
    return null;
  }

  private start(item: Item): void {
    const { batch } = item;
    if (!batch.started) {
      batch.started = true;
      batch.rate.reset();
    }
    this.setState(item, 'running');
    item.abort = new AbortController();
    this.active += 1;
    const work = this.run(item).finally(() => {
      this.active -= 1;
      item.abort = null;
      this.inFlight.delete(work);
      this.settled(batch);
    });
    this.inFlight.add(work);
  }

  /** After anything settles: report, maybe finish the batch, and start what can start. */
  private settled(batch: Batch): void {
    this.markDirty();
    this.checkFinished(batch);
    this.pump();
  }

  private checkFinished(batch: Batch): void {
    if (this.disposed || batch.reported || batch.expanding) return;
    const { counts } = batch;
    if (counts.queued + counts.running + counts.conflict > 0) return;
    batch.reported = true;
    batch.finishedAt = this.now();
    this.deps.finished({
      sessionId: this.deps.sessionId,
      batchId: batch.id,
      kind: batch.kind,
      side: batch.kind === 'download' ? 'local' : 'remote',
      target: batch.refresh,
      ok: counts.failed === 0,
      failed: counts.failed,
    });
    this.compact(batch);
  }

  // Running one item.

  private async run(item: Item): Promise<void> {
    let client: SftpFileClient;
    try {
      client = await this.client();
    } catch (error) {
      if (this.wasCancelled(item, error)) this.setState(item, 'cancelled');
      else this.failQueue(item, openError(error));
      return;
    }
    try {
      this.throwIfCancelled(item);
      const outcome = await this.perform(item, client);
      if (outcome !== 'parked') this.setState(item, outcome);
    } catch (error) {
      this.failed(item, error, client);
    }
  }

  private perform(item: Item, client: SftpFileClient): Promise<Outcome> {
    switch (item.batch.kind) {
      case 'upload':
        return item.isDirectory ? this.makeRemoteFolder(item, client) : this.upload(item, client);
      case 'download':
        return item.isDirectory ? this.makeLocalFolder(item) : this.download(item, client);
      case 'delete':
        return this.remove(item, client);
      case 'chmod':
        return this.chmod(item, client);
    }
  }

  private async makeRemoteFolder(item: Item, client: SftpFileClient): Promise<Outcome> {
    const path = this.targetPath(item);
    const existing = await client.sftpStat(path);
    if (existing?.isDirectory) return 'done';
    if (existing) {
      throw filesError(
        'exists',
        `${path} is a file on the server, so the folder ${item.relPath} cannot be made there.`,
      );
    }
    await client.sftpMkdir(path);
    return 'done';
  }

  private async makeLocalFolder(item: Item): Promise<Outcome> {
    const path = this.localTarget(item);
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(path);
      // A link the user made here is not followed: a name from the server must not lead outside.
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw filesError(
          'exists',
          `${path} is a file or a link on this computer, so the folder ${item.relPath} cannot be made there.`,
        );
      }
    }
    return 'done';
  }

  private async upload(item: Item, client: SftpFileClient): Promise<Outcome> {
    const before = await this.localStat(item.source);
    this.setSize(item, before.size);
    item.mtimeMs = before.mtimeMs;
    this.throwIfCancelled(item);
    const check = await this.checkConflict(item, client);
    if (check !== 'go') return check;
    const options: FileUploadOptions = {
      signal: item.abort?.signal,
      onProgress: (sent) => this.progress(item, sent),
    };
    if (this.platform !== 'win32' && item.mode !== null) options.mode = item.mode;
    await client.uploadFile(item.source, this.targetPath(item), options);
    const after = await this.localStat(item.source);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw filesError(
        'localChanged',
        `${item.source} changed while it was being sent, so the copy on the server may be incomplete. Retry to send it again.`,
      );
    }
    this.progress(item, before.size);
    return 'done';
  }

  private async download(item: Item, client: SftpFileClient): Promise<Outcome> {
    this.localTarget(item);
    const check = await this.checkConflict(item, client);
    if (check !== 'go') return check;
    await client.downloadFile(item.source, this.localTarget(item), {
      signal: item.abort?.signal,
      onProgress: (received, total) => {
        this.setSize(item, total);
        this.progress(item, received);
      },
    });
    this.progress(item, item.size);
    return 'done';
  }

  /** The local path a download item writes, refused when it would land outside the chosen folder. */
  private localTarget(item: Item): string {
    return assertContained(this.targetPath(item), item.batch.target ?? '');
  }

  private async remove(item: Item, client: SftpFileClient): Promise<Outcome> {
    const result = await removeRecursive(client, item.source, { signal: item.abort?.signal });
    if (result.failed > 0) throw opFailure(result, 'deleted');
    return 'done';
  }

  private async chmod(item: Item, client: SftpFileClient): Promise<Outcome> {
    const { mode, scope } = item.batch.chmod ?? { mode: 0, scope: 'none' };
    const result = await chmodRecursive(client, item.source, mode, scope, {
      signal: item.abort?.signal,
    });
    if (result.failed > 0) throw opFailure(result, 'changed');
    return result.done === 0 && result.skipped > 0 ? 'skipped' : 'done';
  }

  // Conflicts.

  /**
   * Looks at the target right before a file is sent; see the conflict notes at the top. What is
   * there counts, and so does a file another item is sending to the same target or this batch
   * already wrote there. An item that goes ahead claims its target before anything else can
   * look, so of two items meeting at one target only the first goes without asking.
   */
  private async checkConflict(item: Item, client: SftpFileClient): Promise<'go' | Outcome> {
    const onDisk = await this.targetInfo(item, client);
    const existing = this.claimedInfo(item, item.name) ?? onDisk;
    if (!existing) {
      this.claim(item);
      return 'go';
    }
    const action = item.decision ?? item.batch.policy;
    if (action === 'skip') return 'skipped';
    if (action === 'overwrite') {
      if (existing.isDirectory) {
        throw filesError(
          'invalidInput',
          `A folder named ${item.name} is at the target, and a file cannot replace a folder.`,
        );
      }
      this.claim(item);
      return 'go';
    }
    if (action === 'rename') {
      await this.renameToFree(item, client);
      return 'go';
    }
    const renameTo = this.pickFreeName(item, await this.takenNames(item, client));
    this.throwIfCancelled(item);
    this.park(item, existing, renameTo);
    return 'parked';
  }

  /** Whether case counts in names on the side an item writes to (not on Windows and macOS). */
  private fold(item: Item, name: string): string {
    const ignoresCase =
      item.batch.kind === 'download' && (this.platform === 'win32' || this.platform === 'darwin');
    return ignoresCase ? name.toLowerCase() : name;
  }

  /** What two items must not share: the remote path as it is, or the local one resolved and folded. */
  private targetKey(item: Item, name: string): string {
    if (item.batch.kind === 'upload') return `remote:${joinRemote(item.targetDir, name)}`;
    return `local:${this.fold(item, resolve(item.targetDir, name))}`;
  }

  /** The file another item is sending to `name`, or that this batch wrote there; null when neither. */
  private claimedInfo(item: Item, name: string): SftpConflict['target'] | null {
    const key = this.targetKey(item, name);
    const owner = this.claims.get(key);
    if (owner && owner !== item) {
      return { size: owner.size, mtimeMs: owner.mtimeMs, isDirectory: false };
    }
    const written = item.batch.written.get(key);
    return written ? { ...written, isDirectory: false } : null;
  }

  private claim(item: Item): void {
    this.unclaim(item);
    const key = this.targetKey(item, item.name);
    this.claims.set(key, item);
    item.claimKey = key;
  }

  private unclaim(item: Item): void {
    if (item.claimKey && this.claims.get(item.claimKey) === item) this.claims.delete(item.claimKey);
    item.claimKey = null;
  }

  private async targetInfo(
    item: Item,
    client: SftpFileClient,
  ): Promise<SftpConflict['target'] | null> {
    if (item.batch.kind === 'upload') {
      const info = await client.sftpStat(this.targetPath(item));
      return info && { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory };
    }
    try {
      const info = await stat(this.localTarget(item));
      return { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() };
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  }

  /**
   * The names in the item's target folder, listed once per batch and folder (`fresh` lists it
   * again) and folded where case does not count. Keep both adds the names it hands out.
   */
  private takenNames(item: Item, client: SftpFileClient, fresh = false): Promise<Set<string>> {
    const { names } = item.batch;
    const cached = fresh ? undefined : names.get(item.targetDir);
    if (cached) return cached;
    const listing = (async () => {
      const listed =
        item.batch.kind === 'upload'
          ? (await client.sftpListDetailed(item.targetDir)).map((entry) => entry.name)
          : await readdir(item.targetDir);
      return new Set(listed.map((name) => this.fold(item, name)));
    })();
    names.set(item.targetDir, listing);
    // A listing that failed is not kept, so the next Keep both lists again.
    listing.catch(() => {
      if (names.get(item.targetDir) === listing) names.delete(item.targetDir);
    });
    return listing;
  }

  /** The first `name (N).ext` that is neither in the folder nor claimed by another item. */
  private pickFreeName(item: Item, taken: Set<string>): string {
    return nextFreeName(
      item.name,
      (candidate) =>
        taken.has(this.fold(item, candidate)) || this.claimedInfo(item, candidate) !== null,
    );
  }

  /**
   * Keep both: gives the item the next free name and claims it. The remembered names can be out
   * of date, so the new target is looked at once more, and the folder listed again when the name
   * turns out taken after all.
   */
  private async renameToFree(item: Item, client: SftpFileClient): Promise<void> {
    const original = item.name;
    let taken = await this.takenNames(item, client);
    for (let attempt = 1; ; attempt += 1) {
      item.name = this.pickFreeName(item, taken);
      taken.add(this.fold(item, item.name));
      this.claim(item);
      if (!(await this.targetInfo(item, client))) return;
      this.unclaim(item);
      if (attempt === FREE_NAME_ATTEMPTS) {
        throw filesError(
          'exists',
          `No free name like ${original} stayed free in ${item.targetDir}.`,
        );
      }
      item.name = original;
      taken = await this.takenNames(item, client, true);
    }
  }

  private park(item: Item, existing: SftpConflict['target'], renameTo: string): void {
    const { batch } = item;
    item.conflict = {
      conflictId: this.randomId(),
      batchId: batch.id,
      itemId: item.id,
      direction: batch.kind === 'download' ? 'download' : 'upload',
      name: item.name,
      relPath: item.relPath,
      targetDir: item.targetDir,
      source: { size: item.size, mtimeMs: item.mtimeMs },
      target: existing,
      renameTo,
      remainingInBatch: 0,
    };
    this.parked.push(item);
    this.setState(item, 'conflict');
  }

  private unpark(item: Item): void {
    const index = this.parked.indexOf(item);
    if (index >= 0) this.parked.splice(index, 1);
    item.conflict = null;
  }

  /** Lets a parked item go under `action`, or under its batch's policy when that is null. */
  private releaseParked(item: Item, action: SftpConflictAction | null): void {
    this.unpark(item);
    if ((action ?? item.batch.policy) === 'skip') {
      this.setState(item, 'skipped');
      return;
    }
    item.decision = action;
    this.requeue(item);
  }

  resolveConflict(conflictId: string, decision: SftpConflictDecision): void {
    this.checkOpen();
    const item = this.parked.find((parked) => parked.conflict?.conflictId === conflictId);
    if (!item?.conflict) {
      throw filesError('invalidInput', 'That conflict is no longer waiting for an answer.');
    }
    if (decision.action === 'overwrite' && item.conflict.target.isDirectory) {
      throw filesError(
        'invalidInput',
        `A folder named ${item.name} is at the target, and a file cannot replace a folder. Keep both or skip.`,
      );
    }
    const { batch } = item;
    this.releaseParked(item, decision.action);
    if (decision.applyToAll) {
      batch.policy = decision.action;
      for (const other of this.parked.filter((parked) => parked.batch === batch)) {
        this.releaseParked(other, null);
      }
    }
    this.settled(batch);
  }

  // Outcomes.

  private setState(item: Item, next: SftpItemState): void {
    const prev = item.state;
    if (prev === next) return;
    const { batch } = item;
    batch.counts[prev] -= 1;
    batch.counts[next] += 1;
    if (prev === 'running') batch.running.delete(item);
    if (next === 'running') batch.running.add(item);
    if (prev === 'failed') batch.failed.delete(item);
    if (next === 'failed') batch.failed.add(item);
    if (item.claimKey && prev === 'running') {
      // A download that got there stays taken for the rest of its batch, so a later name that
      // meets it still asks, even where the disk cannot tell the two apart.
      if (next === 'done' && batch.kind === 'download') {
        batch.written.set(item.claimKey, { size: item.size, mtimeMs: item.mtimeMs });
      }
      this.unclaim(item);
    }
    if (carriesBytes(item)) {
      if (ABANDONED.has(prev)) batch.abandonedBytes -= item.abandoned;
      if (ABANDONED.has(next)) {
        item.abandoned = Math.max(0, item.size - item.transferred);
        batch.abandonedBytes += item.abandoned;
      }
    }
    item.state = next;
    this.markDirty();
  }

  private setSize(item: Item, size: number): void {
    if (carriesBytes(item)) item.batch.totalBytes += size - item.size;
    item.size = size;
  }

  private progress(item: Item, transferred: number): void {
    const delta = transferred - item.transferred;
    if (delta === 0) return;
    item.transferred = transferred;
    item.batch.transferredBytes += delta;
    if (delta > 0) item.batch.rate.add(delta);
    this.markDirty();
  }

  private setFailed(item: Item, error: Error): void {
    item.error = filesErrorMessage(error);
    item.errorCode = filesErrorCode(error);
    this.setState(item, 'failed');
  }

  private wasCancelled(item: Item, error: unknown): boolean {
    return (
      this.disposed || item.abort?.signal.aborted === true || filesErrorCode(error) === 'cancelled'
    );
  }

  private throwIfCancelled(item: Item): void {
    if (this.disposed || item.abort?.signal.aborted) throw cancelledError();
  }

  private failed(item: Item, error: unknown, client: SftpFileClient): void {
    if (this.wasCancelled(item, error)) {
      this.setState(item, 'cancelled');
      this.forSubtree(item, (child) => this.setState(child, 'cancelled'));
      return;
    }
    // A download fails on the server (name the remote path) or on this computer (the local one).
    const local = item.batch.kind === 'download' && isLocalFsError(error);
    const coded = codedError(error, local ? this.targetPath(item) : item.source);
    if (filesErrorCode(coded) === 'unreachable' && !item.retried) {
      item.retried = true;
      this.dropClient(client);
      this.requeue(item);
      return;
    }
    this.setFailed(item, coded);
    this.forSubtree(item, (child) => this.setFailed(child, coded));
  }

  /** The connection could not be opened: this item and everything queued fail with that. */
  private failQueue(item: Item, error: Error): void {
    this.setFailed(item, error);
    this.forSubtree(item, (child) => this.setFailed(child, error));
    for (const batch of this.batches) {
      let changed = false;
      for (const queued of batch.items) {
        if (queued.state !== 'queued' || queued.unexpanded) continue;
        this.setFailed(queued, error);
        changed = true;
      }
      if (changed && batch !== item.batch) this.checkFinished(batch);
    }
  }

  /** Runs `change` on every queued item under a folder item. */
  private forSubtree(item: Item, change: (child: Item) => void): void {
    if (!item.isDirectory) return;
    for (const child of this.descendantsOf(item)) if (child.state === 'queued') change(child);
  }

  /** The items under a folder item: they follow it in the list, pre-order. */
  private descendantsOf(item: Item): Item[] {
    const { items } = item.batch;
    const found: Item[] = [];
    if (items[item.index] !== item) return found;
    for (let index = item.index + 1; index < items.length; index += 1) {
      let ancestor = items[index].parent;
      while (ancestor && ancestor !== item) ancestor = ancestor.parent;
      if (!ancestor) break;
      found.push(items[index]);
    }
    return found;
  }

  private ancestorsOf(item: Item): Item[] {
    const found: Item[] = [];
    for (let parent = item.parent; parent; parent = parent.parent) found.push(parent);
    return found;
  }

  /** Back in the queue, keeping its answer, for another go. */
  private requeue(item: Item): void {
    this.setState(item, 'queued');
    this.progress(item, 0);
    item.batch.cursor = Math.min(item.batch.cursor, item.index);
  }

  // Cancel, retry, clear.

  private select(target: SftpTarget): Batch[] {
    if (target.itemId !== undefined && target.batchId === undefined) {
      throw filesError('invalidInput', 'An item can only be named with its batch.');
    }
    if (target.batchId === undefined) return [...this.batches];
    const batch = this.batches.find((candidate) => candidate.id === target.batchId);
    if (!batch) throw filesError('invalidInput', 'That transfer is no longer in the queue.');
    return [batch];
  }

  private itemOf(batch: Batch, itemId: string): Item {
    const item = batch.items.find((candidate) => candidate.id === itemId);
    if (!item) throw filesError('invalidInput', 'That item is no longer in the queue.');
    return item;
  }

  private cancelItem(item: Item): void {
    if (item.state === 'queued') {
      // A root being walked: its walk stops too.
      item.abort?.abort();
      this.setState(item, 'cancelled');
    } else if (item.state === 'conflict') {
      this.unpark(item);
      this.setState(item, 'cancelled');
    } else if (item.state === 'running') item.abort?.abort();
  }

  cancel(target: SftpTarget = {}): void {
    if (this.disposed) return;
    for (const batch of this.select(target)) {
      if (target.itemId !== undefined) {
        const item = this.itemOf(batch, target.itemId);
        this.cancelItem(item);
        if (item.isDirectory) for (const child of this.descendantsOf(item)) this.cancelItem(child);
      } else {
        batch.expandAbort?.abort();
        for (const item of batch.items) this.cancelItem(item);
      }
      this.markDirty();
      this.checkFinished(batch);
    }
    this.pump();
  }

  retry(target: SftpTarget = {}): void {
    if (this.disposed) return;
    for (const batch of this.select(target)) {
      let items = batch.items;
      if (target.itemId !== undefined) {
        const item = this.itemOf(batch, target.itemId);
        items = [...this.ancestorsOf(item), item, ...this.descendantsOf(item)];
      }
      let any = false;
      for (const item of items) {
        if (item.state !== 'failed' && item.state !== 'cancelled') continue;
        item.error = null;
        item.errorCode = null;
        item.decision = null;
        item.name = item.originalName;
        item.retried = false;
        this.requeue(item);
        any = true;
      }
      if (!any) continue;
      batch.reported = false;
      batch.finishedAt = null;
      batch.cursor = 0;
      this.expand(batch);
    }
    this.pump();
  }

  clearFinished(): void {
    const kept = this.batches.filter((batch) => !this.isOver(batch));
    if (kept.length === this.batches.length) return;
    this.batches.splice(0, this.batches.length, ...kept);
    this.markDirty();
  }

  private isOver(batch: Batch): boolean {
    const { counts } = batch;
    return !batch.expanding && counts.queued + counts.running + counts.conflict === 0;
  }

  activeCount(): number {
    return this.batches.filter((batch) => !this.isOver(batch)).length;
  }

  // The transfer connection.

  private client(): Promise<SftpFileClient> {
    if (this.current?.isOpen) return Promise.resolve(this.current);
    if (this.current) this.dropClient(this.current);
    if (!this.opening) {
      this.opening = Promise.resolve()
        .then(() => this.deps.transferClient())
        .then((client) => {
          if (this.disposed) {
            this.deps.releaseTransferClient();
            throw cancelledError();
          }
          this.current = client;
          return client;
        })
        .finally(() => {
          this.opening = null;
        });
    }
    return this.opening;
  }

  private dropClient(client: SftpFileClient): void {
    if (this.current !== client) return;
    this.current = null;
    this.deps.releaseTransferClient();
  }

  private updateBusy(): void {
    const busy =
      !this.disposed && (this.active > 0 || this.batches.some((batch) => batch.expanding));
    if (busy !== this.busyNow) {
      this.busyNow = busy;
      this.deps.busy(busy);
    }
    if (busy || this.disposed) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
    } else if (this.current && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.busyNow && this.current) this.dropClient(this.current);
      }, this.idleReleaseMs);
    }
  }

  // Snapshots.

  private markDirty(): void {
    if (this.disposed) return;
    this.dirty = true;
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      if (!this.dirty || this.disposed) return;
      this.dirty = false;
      this.deps.emit(this.snapshot());
    }, this.coalesceMs);
  }

  snapshot(): SftpQueueSnapshot {
    const first = this.parked[0];
    let conflict: SftpConflict | null = null;
    if (first?.conflict) {
      const { counts } = first.batch;
      conflict = { ...first.conflict, remainingInBatch: counts.queued + counts.conflict - 1 };
    }
    return {
      sessionId: this.deps.sessionId,
      batches: this.batches.map((batch) => this.view(batch)),
      conflict,
      pendingConflicts: Math.max(0, this.parked.length - 1),
    };
  }

  private itemView(item: Item): SftpItemView {
    return {
      itemId: item.id,
      relPath: item.relPath,
      size: carriesBytes(item) ? item.size : 0,
      transferred: item.transferred,
      state: item.state,
      error: item.error,
      errorCode: item.errorCode,
    };
  }

  private stateOf(batch: Batch): SftpBatchState {
    const { counts } = batch;
    if (batch.expanding) return 'expanding';
    if (counts.queued + counts.running + counts.conflict > 0) {
      if (counts.conflict > 0) return 'waiting';
      return batch.started ? 'running' : 'queued';
    }
    if (counts.failed > 0) return 'failed';
    return counts.cancelled > 0 ? 'cancelled' : 'done';
  }

  private label(batch: Batch): string {
    const { roots } = batch;
    const single = roots.length === 1 ? roots[0] : null;
    if (batch.kind === 'delete') {
      return single ? `Delete ${single.relPath}` : `Delete ${roots.length} items`;
    }
    if (batch.kind === 'chmod') {
      return single ? `Permissions for ${single.relPath}` : `Permissions for ${roots.length} items`;
    }
    const files = plural(batch.fileCount, 'file');
    if (single) {
      return single.isDirectory && !single.linkSkip && !single.unexpanded && !batch.expanding
        ? `${single.relPath} (${files})`
        : single.relPath;
    }
    return batch.expanding ? `${roots.length} items` : `${roots.length} items (${files})`;
  }

  private view(batch: Batch): SftpBatchView {
    const state = this.stateOf(batch);
    const { counts } = batch;
    const moving = state === 'running' || (state === 'waiting' && counts.running > 0);
    const bytesPerSecond = moving ? batch.rate.bytesPerSecond() : null;
    const remaining = batch.totalBytes - batch.transferredBytes - batch.abandonedBytes;
    const failures: SftpItemView[] = [];
    for (const item of batch.failed) {
      if (failures.length === SFTP_FAILURES_PER_BATCH) break;
      failures.push(this.itemView(item));
    }
    return {
      batchId: batch.id,
      kind: batch.kind,
      label: this.label(batch),
      source: batch.source,
      target: batch.kind === 'upload' || batch.kind === 'download' ? batch.target : null,
      state,
      totalItems: batch.expanding ? null : batch.items.length + batch.dropped.items,
      doneItems: counts.done,
      failedItems: counts.failed,
      skippedItems: counts.skipped,
      totalBytes: batch.expanding ? null : batch.totalBytes,
      transferredBytes: batch.transferredBytes,
      bytesPerSecond,
      etaSeconds: bytesPerSecond ? batch.rate.eta(remaining) : null,
      running: [...batch.running].map((item) => this.itemView(item)),
      failures,
      failuresTruncated: counts.failed > SFTP_FAILURES_PER_BATCH,
      createdAt: batch.createdAt,
      finishedAt: batch.finishedAt,
    };
  }

  // Shutting down.

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      for (const batch of this.batches) {
        batch.expandAbort?.abort();
        for (const item of batch.running) item.abort?.abort();
      }
    }
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
    this.parked.length = 0;
    if (this.current) {
      this.current = null;
      this.deps.releaseTransferClient();
    }
    this.updateBusy();
    if (this.busyNow) {
      this.busyNow = false;
      this.deps.busy(false);
    }
  }
}

export function createTransferEngine(deps: TransferEngineDeps): TransferEngine {
  return new Engine(deps);
}
