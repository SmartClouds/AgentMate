import type { DevArch, DevOs } from '@runova/core';
import type { CancelToken } from '../../process/spawnStreaming';
import type { RunHooks } from './packageManagerRunner';

/**
 * What the installers that fetch and unpack things themselves (Flutter, the Android tools) need
 * from the machine. They take these as injected functions so the order of the steps, the checks
 * and the messages can be tested with fakes; `managedSystem.ts` supplies the real ones.
 */

export interface DownloadRequest {
  url: string;
  destPath: string;
  /** Bytes, when the publisher says. Lets a finished partial file be recognised as complete. */
  expectedSize: number | null;
}

export interface DownloadHooks {
  onProgress: (transferred: number, total: number) => void;
  /** Gives the installer a way to stop the download if the run is cancelled. */
  registerAbort: (abort: () => void) => void;
  /**
   * The connection dropped and the download is about to try again from where it got to.
   * `transferred` is how many bytes are on disk. Left out, retries happen silently.
   */
  onReconnect?: (attempt: number, transferred: number) => void;
}

export interface ExtractResult {
  ok: boolean;
  message?: string;
}

export interface CommandResult {
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
  notFound: boolean;
}

/** The few file operations the installers use, so tests can run on a made-up disk. */
export interface ManagedFs {
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<void>;
  /** Removes a file or folder; a path that is not there is not an error. */
  rm: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  /** True for a folder with nothing in it. */
  isEmptyDir: (path: string) => Promise<boolean>;
}

export interface ManagedEnvironment {
  os: DevOs;
  arch: DevArch;
  home: string;
  /** Where downloads are kept while they are fetched and checked. */
  workDir: string;
}

export interface ManagedKit extends ManagedEnvironment {
  fetchText: (url: string) => Promise<string>;
  download: (request: DownloadRequest, hooks: DownloadHooks) => Promise<void>;
  hashFile: (path: string, algorithm: 'sha1' | 'sha256') => Promise<string>;
  /** Unpacks a zip or tarball into `destDir`. */
  extract: (
    archive: string,
    destDir: string,
    options: { token: CancelToken; onLine: (line: string) => void },
  ) => Promise<ExtractResult>;
  fs: ManagedFs;
  /** A short unique string for temporary folder names. */
  randomId: () => string;
}

/** "312 of 780 MB", for the line under a download's progress bar. */
export function describeTransfer(transferred: number, total: number): string {
  const megabytes = (bytes: number): string =>
    (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
  return `${megabytes(transferred)} of ${megabytes(total)} MB`;
}

/**
 * How many times in a row a download may lose its connection without getting any further before
 * it is given up on. A drop that was followed by more bytes does not count, so a long download on
 * a shaky connection is not cut off, but one that never connects at all ends in a message.
 */
const MAX_STALLED_RECONNECTS = 6;

/**
 * What the installers hand a download: the progress line under the bar, a note on that line while
 * the connection is being re-made, and the way to stop it. The download itself retries for ever, so
 * `gaveUp` is how an installer finds out that this stopped it for a dead connection, as opposed
 * to the person cancelling.
 */
export function createDownloadHooks(
  run: RunHooks,
  /**
   * For one file of several: the bytes of the files before it and of all of them, so the bar and
   * the line under it count the whole set instead of starting again for each file.
   */
  batch?: { before: number; total: number },
): {
  hooks: DownloadHooks;
  gaveUp: () => boolean;
} {
  let stop: (() => void) | null = null;
  let gaveUp = false;
  let lastTransferred = -1;
  let stalled = 0;
  return {
    hooks: {
      onProgress: (transferred, total) => {
        const done = (batch?.before ?? 0) + transferred;
        const all = batch?.total ?? total;
        run.onProgress({
          phase: 'downloading',
          fraction: all > 0 ? Math.min(1, done / all) : null,
          detail: describeTransfer(done, all),
        });
      },
      registerAbort: (abort) => {
        stop = abort;
        run.onCancel?.(abort);
      },
      onReconnect: (_attempt, transferred) => {
        stalled = transferred > lastTransferred ? 1 : stalled + 1;
        lastTransferred = transferred;
        if (stalled >= MAX_STALLED_RECONNECTS) {
          gaveUp = true;
          stop?.();
          return;
        }
        // No fraction, so the bar stays where it was. The next progress report replaces this.
        run.onProgress({ phase: 'downloading', detail: 'Connection lost, retrying' });
      },
    },
    gaveUp: () => gaveUp,
  };
}
