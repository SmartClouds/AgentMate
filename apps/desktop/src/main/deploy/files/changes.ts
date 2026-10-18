import { createHash } from 'node:crypto';
import { type LocalFileMap, planFileSync } from '@agentmat/core';
import { filesError, filesErrorCode, filesErrorMessage } from '../../../shared/deployFilesErrors';
import type { FilesChangesSnapshot, FilesPendingFile } from '../../../shared/deployFilesTypes';
import type { HashCache } from '../hashFile';
import { type BaseTarget, baseTargetOf, type FilesBase, peekBase } from './bases';
import {
  baseWithoutLeftOut,
  type FilesLocalWalk,
  type FilesWalkOptions,
  seedHashCache,
  walkSiteFolder,
} from './localWalk';
import { createFolderWatcher, type FolderSettleReason, type FolderWatcher } from './siteWatcher';
import type { StoredFileSite } from './types';

/**
 * The live list of what changed in each FTP or SFTP site's deploy folder since the last deploy
 * (E23). A site is watched while a window shows it (a subscriber) or Deploy on save is on
 * (keepWatching); when neither holds, its watcher stops and its snapshot is dropped, since nothing
 * would keep it current.
 *
 * Each walk reads the base again (a deploy changes it), walks the folder with a hash cache kept
 * per site (seeded once from the base, so files unchanged since the deploy are not read), and
 * plans with the server not read: every local change is an upload or a delete, the real plan
 * judges the server later. One walk per site runs at a time; a settle during a walk walks once
 * more after it, so the last change is never missed.
 *
 * A deploy folder that is gone lists nothing: an unplugged drive is not a reason to show every
 * deployed file as deleted.
 */

export interface ChangesDeps {
  getSite: (siteId: string) => Promise<StoredFileSite | null>;
  walk: (options: FilesWalkOptions) => Promise<FilesLocalWalk>;
  readBase: (siteId: string, target: BaseTarget) => Promise<FilesBase>;
  watch: (root: string, onSettle: (reason: FolderSettleReason) => void) => FolderWatcher;
  now: () => number;
  /** Sends a snapshot to the windows; called only when what they show changed. */
  publish: (siteId: string, snapshot: FilesChangesSnapshot) => void;
}

/**
 * Called after a walk that found the pending changes different from the walk before (the bytes
 * of a pending file included, so a second edit of the same size counts), and after the first walk
 * of a watched site. A poll that found nothing new does not call it, so a quiet timer keyed on it
 * (Deploy on save) is not reset every five seconds on Linux.
 */
export type ChangesSettledListener = (siteId: string, snapshot: FilesChangesSnapshot) => void;

export interface ChangesService {
  /** Starts watching for this window if needed; answers from the cache while it is current. */
  subscribe: (siteId: string, subscriberId: string) => Promise<FilesChangesSnapshot>;
  unsubscribe: (siteId: string, subscriberId: string) => void;
  /** Walks now, watched or not. A refresh during a walk answers with the walk after it. */
  refresh: (siteId: string) => Promise<FilesChangesSnapshot>;
  /** The last snapshot of a watched site, null when the site is not watched or not walked yet. */
  snapshot: (siteId: string) => FilesChangesSnapshot | null;
  /** Deploy on save: keeps the site watched with no window open. */
  keepWatching: (siteId: string, on: boolean) => Promise<void>;
  onSettled: (listener: ChangesSettledListener) => () => void;
  siteRemoved: (siteId: string) => void;
  /** The folder or the ignore patterns changed: watch the new folder and walk again. */
  siteUpdated: (siteId: string) => Promise<void>;
  closeAll: () => void;
}

/** The snapshot carries at most this many left-out paths; the rest are only counted as more. */
export const CHANGES_LEFT_OUT_MAX = 500;

interface Tracker {
  siteId: string;
  subscribers: Set<string>;
  keep: boolean;
  watcher: FolderWatcher | null;
  /** Seeded from the base on the first walk; dropped when the folder may have changed. */
  hashes: HashCache | null;
  snapshot: FilesChangesSnapshot | null;
  /** What the windows were last sent. */
  viewKey: string | null;
  /** What settle listeners were last told about. */
  settledKey: string | null;
  running: Promise<FilesChangesSnapshot> | null;
  dirty: boolean;
  /** Bumped when the site's settings change, so a walk started before is not published. */
  generation: number;
}

interface WalkOutcome {
  snapshot: FilesChangesSnapshot;
  /** The local hashes of the pending files, for the settle key. */
  pendingHashes: string[];
}

const defaultDeps: Omit<ChangesDeps, 'publish'> = {
  // Loaded on first use: the store pulls in the vault and the whole Servers graph.
  getSite: async (siteId) => (await import('./store')).getFileSite(siteId),
  walk: walkSiteFolder,
  // Read only: folding the journal while a run appends to it would lose what the run finished.
  readBase: peekBase,
  watch: (root, onSettle) => createFolderWatcher(root, onSettle),
  now: () => Date.now(),
};

function keyOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function viewKeyOf(snapshot: FilesChangesSnapshot): string {
  const { siteId: _siteId, computedAt: _computedAt, ...content } = snapshot;
  return keyOf(content);
}

function emptyTotals(): FilesChangesSnapshot['totals'] {
  return { added: 0, modified: 0, deleted: 0, bytes: 0 };
}

export function createChangesService(
  overrides: Partial<ChangesDeps> & Pick<ChangesDeps, 'publish'>,
): ChangesService {
  const deps: ChangesDeps = { ...defaultDeps, ...overrides };
  const trackers = new Map<string, Tracker>();
  const listeners = new Set<ChangesSettledListener>();

  function trackerOf(siteId: string): Tracker {
    let tracker = trackers.get(siteId);
    if (!tracker) {
      tracker = {
        siteId,
        subscribers: new Set(),
        keep: false,
        watcher: null,
        hashes: null,
        snapshot: null,
        viewKey: null,
        settledKey: null,
        running: null,
        dirty: false,
        generation: 0,
      };
      trackers.set(siteId, tracker);
    }
    return tracker;
  }

  function isActive(tracker: Tracker): boolean {
    return tracker.subscribers.size > 0 || tracker.keep;
  }

  /** Still the tracker for its site: siteRemoved or closeAll did not forget it meanwhile. */
  function isLive(tracker: Tracker): boolean {
    return trackers.get(tracker.siteId) === tracker;
  }

  async function siteOrThrow(siteId: string): Promise<StoredFileSite> {
    const site = await deps.getSite(siteId);
    if (!site) throw filesError('siteUnknown', 'That site is no longer saved.');
    return site;
  }

  function startWatching(tracker: Tracker, site: StoredFileSite): void {
    if (tracker.watcher || !isLive(tracker)) return;
    tracker.watcher = deps.watch(site.localFolder, () => {
      // A failed walk is already a snapshot; anything else (the site gone) waits for the next.
      walkSoon(tracker).catch(() => undefined);
    });
  }

  /** Stops the watcher and drops what would go stale; the hash cache stays for the next walk. */
  function stopWatching(tracker: Tracker): void {
    tracker.watcher?.close();
    tracker.watcher = null;
    tracker.snapshot = null;
    tracker.viewKey = null;
    tracker.settledKey = null;
  }

  async function walkOnce(tracker: Tracker): Promise<WalkOutcome> {
    const site = await siteOrThrow(tracker.siteId);
    let baseFiles: FilesBase['files'] = {};
    let baseError: unknown = null;
    try {
      baseFiles = (await deps.readBase(site.id, baseTargetOf(site))).files;
    } catch (error) {
      baseError = error;
    }
    const baseFileCount = Object.keys(baseFiles).length;
    const outcome = (state: FilesChangesSnapshot['state'], error: string | null): WalkOutcome => ({
      snapshot: {
        siteId: site.id,
        computedAt: deps.now(),
        state,
        error,
        files: [],
        totals: emptyTotals(),
        leftOut: [],
        leftOutTruncated: false,
        localFileCount: 0,
        baseFileCount,
        firstDeploy: baseFileCount === 0,
      },
      pendingHashes: [],
    });

    if (baseError) return outcome('error', filesErrorMessage(baseError));

    tracker.hashes ??= seedHashCache(baseFiles);
    let walk: FilesLocalWalk;
    try {
      walk = await deps.walk({
        root: site.localFolder,
        ignorePatterns: site.ignorePatterns,
        tracked: new Set(Object.keys(baseFiles)),
        hashes: tracker.hashes,
      });
    } catch (error) {
      const code = filesErrorCode(error);
      return outcome(code === 'tooManyFiles' ? 'tooManyFiles' : 'error', filesErrorMessage(error));
    }
    // Never plan against a folder that is not there: it would list every deployed file as deleted.
    if (!walk.exists) return outcome('folderMissing', null);

    const local: LocalFileMap = walk.files;
    const plan = planFileSync({
      local,
      base: baseWithoutLeftOut(baseFiles, walk.leftOut),
      remote: null,
    });
    const files: FilesPendingFile[] = [];
    const pendingHashes: string[] = [];
    const totals = emptyTotals();
    for (const change of plan.changes) {
      const here = local[change.path];
      const size =
        change.local === 'deleted' ? (baseFiles[change.path]?.size ?? 0) : (here?.size ?? 0);
      files.push({ path: change.path, change: change.local, size });
      pendingHashes.push(here?.sha256 ?? '');
      totals[change.local] += 1;
    }
    totals.bytes = plan.uploadBytes;
    const result = outcome('ready', null);
    result.snapshot.files = files;
    result.snapshot.totals = totals;
    result.snapshot.leftOut = walk.leftOut.slice(0, CHANGES_LEFT_OUT_MAX);
    result.snapshot.leftOutTruncated = walk.leftOut.length > CHANGES_LEFT_OUT_MAX;
    result.snapshot.localFileCount = Object.keys(local).length;
    result.pendingHashes = pendingHashes;
    return result;
  }

  /** Keeps the snapshot of a watched site and tells whoever needs to know that it changed. */
  function deliver(tracker: Tracker, outcome: WalkOutcome): void {
    if (!isLive(tracker) || !isActive(tracker)) return;
    const { snapshot } = outcome;
    tracker.snapshot = snapshot;
    const viewKey = viewKeyOf(snapshot);
    if (viewKey !== tracker.viewKey) {
      tracker.viewKey = viewKey;
      try {
        deps.publish(tracker.siteId, snapshot);
      } catch {
        // A window that just closed must not fail the walk someone else is waiting on.
      }
    }
    const settledKey = keyOf([viewKey, outcome.pendingHashes]);
    if (settledKey !== tracker.settledKey) {
      tracker.settledKey = settledKey;
      for (const listener of listeners) {
        try {
          listener(tracker.siteId, snapshot);
        } catch {
          // One listener failing must not keep the others from hearing.
        }
      }
    }
  }

  function forget(siteId: string): void {
    const tracker = trackers.get(siteId);
    if (!tracker) return;
    trackers.delete(siteId);
    stopWatching(tracker);
  }

  /**
   * Walks the site, or, when a walk is running, marks it dirty and answers with the walk that
   * follows. The promise settles once no walk is left to do.
   */
  function walkSoon(tracker: Tracker): Promise<FilesChangesSnapshot> {
    if (tracker.running) {
      tracker.dirty = true;
      return tracker.running;
    }
    const running = (async () => {
      try {
        let snapshot: FilesChangesSnapshot;
        do {
          tracker.dirty = false;
          const generation = tracker.generation;
          const outcome = await walkOnce(tracker);
          snapshot = outcome.snapshot;
          if (generation === tracker.generation) deliver(tracker, outcome);
          else tracker.dirty = true;
        } while (tracker.dirty && isLive(tracker));
        return snapshot;
      } catch (error) {
        // Removed from the store without siteRemoved: stop watching a site that is not there.
        if (filesErrorCode(error) === 'siteUnknown') forget(tracker.siteId);
        throw error;
      } finally {
        tracker.running = null;
      }
    })();
    tracker.running = running;
    return running;
  }

  return {
    async subscribe(siteId, subscriberId) {
      const site = await siteOrThrow(siteId);
      const tracker = trackerOf(siteId);
      tracker.subscribers.add(subscriberId);
      if (tracker.watcher) {
        // Watched: the cache is current, or the walk that will fill it is under way.
        if (tracker.snapshot) return tracker.snapshot;
        if (tracker.running) return tracker.running;
      }
      startWatching(tracker, site);
      return walkSoon(tracker);
    },

    unsubscribe(siteId, subscriberId) {
      const tracker = trackers.get(siteId);
      if (!tracker) return;
      tracker.subscribers.delete(subscriberId);
      if (!isActive(tracker)) stopWatching(tracker);
    },

    async refresh(siteId) {
      await siteOrThrow(siteId);
      return walkSoon(trackerOf(siteId));
    },

    snapshot(siteId) {
      return trackers.get(siteId)?.snapshot ?? null;
    },

    async keepWatching(siteId, on) {
      if (!on) {
        const tracker = trackers.get(siteId);
        if (!tracker) return;
        tracker.keep = false;
        if (!isActive(tracker)) stopWatching(tracker);
        return;
      }
      const site = await siteOrThrow(siteId);
      const tracker = trackerOf(siteId);
      tracker.keep = true;
      if (tracker.watcher) return;
      startWatching(tracker, site);
      await walkSoon(tracker);
    },

    onSettled(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    siteRemoved: forget,

    async siteUpdated(siteId) {
      const tracker = trackers.get(siteId);
      if (!tracker || !isActive(tracker)) return;
      tracker.generation += 1;
      tracker.hashes = null;
      tracker.watcher?.close();
      tracker.watcher = null;
      const site = await deps.getSite(siteId);
      if (!site) {
        forget(siteId);
        return;
      }
      if (!isLive(tracker) || !isActive(tracker)) return;
      startWatching(tracker, site);
      await walkSoon(tracker);
    },

    closeAll() {
      for (const tracker of trackers.values()) stopWatching(tracker);
      trackers.clear();
    },
  };
}
