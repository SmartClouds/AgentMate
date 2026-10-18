import { watch as fsWatch } from 'node:fs';

/**
 * Watches an FTP or SFTP site's deploy folder (E23) and says when a burst of changes has settled,
 * so the changes list can walk the folder again. It never says what changed: the walk works that
 * out, which keeps this simple and makes a missed or doubled event harmless.
 *
 * The approach is the working tree watcher's (git/workingTreeWatcher.ts): one recursive watch,
 * version control and dependency folders skipped, a short debounce with a cap so a tool writing
 * nonstop still gets a settle now and then. Linux adds an inotify watch per folder for a recursive
 * watch, which can exhaust the system limit, so the folder is polled there instead. A watch error
 * (Windows reports an overflow when thousands of files change at once) falls back to polling for a
 * while, then watching is tried again. A deploy folder that is gone is reported once, and polling
 * goes on so the folder coming back is noticed.
 */

/** Why `onSettle` was called: changes settled, a poll tick, or the folder is not there. */
export type FolderSettleReason = 'change' | 'poll' | 'missing';

export interface WatchHandle {
  on: (event: 'error', listener: (error: Error) => void) => unknown;
  close: () => void;
}

export interface FolderWatcherDeps {
  watch: (
    root: string,
    options: { recursive: boolean },
    listener: (event: string, file: string | null) => void,
  ) => WatchHandle;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  platform: NodeJS.Platform;
}

export interface FolderWatcher {
  close: () => void;
}

/** Quiet period before a burst of writes counts as settled. */
export const FOLDER_DEBOUNCE_MS = 300;
/** A tool that writes nonstop still gets a settle this often. */
export const FOLDER_MAX_WAIT_MS = 1500;
/** How often the folder is polled where it is not watched. */
export const FOLDER_POLL_MS = 5000;
/** How long after a watch error watching is tried again. */
export const FOLDER_RETRY_WATCH_MS = 10_000;

/**
 * Only version control and dependencies are skipped. The working tree watcher's longer list
 * (dist, build, out, caches) would miss a deploy folder whose content lives in such a folder. The
 * walk's ignore rules decide what is sent; this only decides when to walk again.
 */
const SKIPPED_SEGMENTS = new Set(['.git', 'node_modules']);

function isRelevant(file: string | null): boolean {
  // Some platforms report no file name. A walk is cheaper than missing a change.
  if (!file) return true;
  return !String(file)
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => SKIPPED_SEGMENTS.has(segment));
}

const defaultDeps: FolderWatcherDeps = {
  watch: (root, options, listener) =>
    fsWatch(root, options, (event, file) => listener(event, file === null ? null : String(file))),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
  platform: process.platform,
};

/**
 * Starts watching `root`. `onSettle` runs after changes settle, on every poll tick where the
 * folder is polled, and once when the folder is found missing. Call `close` to stop all of it.
 */
export function createFolderWatcher(
  root: string,
  onSettle: (reason: FolderSettleReason) => void,
  overrides: Partial<FolderWatcherDeps> = {},
): FolderWatcher {
  const deps: FolderWatcherDeps = { ...defaultDeps, ...overrides };
  let closed = false;
  let watcher: WatchHandle | null = null;
  let debounce: unknown = null;
  let firstEventAt: number | null = null;
  let polling = false;
  let pollTimer: unknown = null;
  let retryTimer: unknown = null;
  let missingTimer: unknown = null;
  /** The folder was last found missing; cleared when watching it works again. */
  let missing = false;

  function settle(reason: FolderSettleReason): void {
    if (closed) return;
    try {
      onSettle(reason);
    } catch {
      // The caller's walk failing must not stop the watching.
    }
  }

  function schedule(): void {
    const now = deps.now();
    firstEventAt ??= now;
    if (debounce !== null) deps.clearTimeout(debounce);
    const waited = now - firstEventAt;
    const delay =
      waited >= FOLDER_MAX_WAIT_MS ? 0 : Math.min(FOLDER_DEBOUNCE_MS, FOLDER_MAX_WAIT_MS - waited);
    debounce = deps.setTimeout(() => {
      debounce = null;
      firstEventAt = null;
      settle('change');
    }, delay);
  }

  function tick(): void {
    pollTimer = null;
    if (closed || !polling) return;
    settle('poll');
    if (polling && !closed) pollTimer = deps.setTimeout(tick, FOLDER_POLL_MS);
  }

  function startPolling(): void {
    if (polling || closed) return;
    polling = true;
    pollTimer = deps.setTimeout(tick, FOLDER_POLL_MS);
  }

  function stopPolling(): void {
    polling = false;
    if (pollTimer !== null) deps.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function fallBack(folderMissing: boolean): void {
    if (closed) return;
    watcher?.close();
    watcher = null;
    if (folderMissing && !missing) {
      missing = true;
      if (starting) {
        // The caller is still setting up on the first try, so say it right after.
        missingTimer = deps.setTimeout(() => {
          missingTimer = null;
          settle('missing');
        }, 0);
      } else {
        settle('missing');
      }
    }
    startPolling();
    retryTimer ??= deps.setTimeout(() => {
      retryTimer = null;
      startWatching();
    }, FOLDER_RETRY_WATCH_MS);
  }

  function startWatching(): void {
    if (closed) return;
    if (deps.platform === 'linux') {
      startPolling();
      return;
    }
    let handle: WatchHandle;
    try {
      handle = deps.watch(root, { recursive: true }, (_event, file) => {
        if (!closed && isRelevant(file)) schedule();
      });
    } catch (error) {
      fallBack((error as NodeJS.ErrnoException)?.code === 'ENOENT');
      return;
    }
    watcher = handle;
    handle.on('error', () => fallBack(false));
    stopPolling();
    if (missing) {
      missing = false;
      settle('change');
    }
  }

  let starting = true;
  startWatching();
  starting = false;

  return {
    close: () => {
      if (closed) return;
      closed = true;
      stopPolling();
      for (const timer of [debounce, retryTimer, missingTimer]) {
        if (timer !== null) deps.clearTimeout(timer);
      }
      debounce = null;
      retryTimer = null;
      missingTimer = null;
      watcher?.close();
      watcher = null;
    },
  };
}
