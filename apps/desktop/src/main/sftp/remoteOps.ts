import { filesError } from '../../shared/deployFilesErrors';
import type { SftpChmodScope } from '../../shared/sftpTypes';
import { mapSftpError } from '../deploy/files/transport/errors';
import { joinRemote, normalizeRemote } from '../deploy/files/transport/remotePath';
import { limiter } from '../util/limiter';
import type { SftpDetailedEntry, SftpFileClient } from './client';
import { remoteEntryOf } from './walk';

/**
 * Recursive delete and chmod on the server (E25), the work behind the queue's delete and chmod
 * batches. Links are leaves (D12): delete unlinks a link itself and never looks inside what it
 * points at, so `ln -s /etc linkdir` leaves /etc alone, and chmod skips links (it would change
 * the target). Each entry is reported through `onItem` as it is dealt with; a failure is
 * reported and the rest carries on. An abort stops the work with `[files:cancelled]`, keeping
 * what was already done. Up to `REMOTE_OPS_IN_FLIGHT` requests run at once.
 */

export type RemoteOpOutcome = 'done' | 'failed' | 'skipped';

export interface RemoteOpEvent {
  /** Absolute path on the server. */
  path: string;
  isDirectory: boolean;
  outcome: RemoteOpOutcome;
  /** A coded error (`[files:*]`) for a failure; null otherwise. */
  error: Error | null;
}

export interface RemoteOpOptions {
  signal?: AbortSignal;
  onItem?: (event: RemoteOpEvent) => void;
}

export interface RemoteOpResult {
  done: number;
  failed: number;
  skipped: number;
  /** The first failure, coded; null when nothing failed. */
  firstError: Error | null;
}

/** How many requests a delete or chmod has in flight at once. */
export const REMOTE_OPS_IN_FLIGHT = 8;

function byName(a: SftpDetailedEntry, b: SftpDetailedEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Counts outcomes, reports them, and keeps the request limit and the abort check in one place. */
class OpRun {
  readonly result: RemoteOpResult = { done: 0, failed: 0, skipped: 0, firstError: null };
  private readonly limit = limiter(REMOTE_OPS_IN_FLIGHT);

  constructor(
    private readonly options: RemoteOpOptions,
    private readonly cancelledMessage: string,
  ) {}

  check(): void {
    if (this.options.signal?.aborted) throw filesError('cancelled', this.cancelledMessage);
  }

  /** One request, inside the limit, after the abort check. */
  call<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    return this.limit(() => {
      this.check();
      return work();
    });
  }

  report(path: string, isDirectory: boolean, outcome: RemoteOpOutcome, error?: unknown): void {
    const coded = outcome === 'failed' ? mapSftpError(error, path) : null;
    this.result[outcome] += 1;
    if (coded) this.result.firstError ??= coded;
    this.options.onItem?.({ path, isDirectory, outcome, error: coded });
  }

  /** Runs `work`, reporting its failure (but never a cancel) instead of throwing it. Answers success. */
  async attempt(path: string, isDirectory: boolean, work: () => Promise<void>): Promise<boolean> {
    try {
      await this.call(work);
      this.report(path, isDirectory, 'done');
      return true;
    } catch (error) {
      if (this.options.signal?.aborted) throw filesError('cancelled', this.cancelledMessage);
      this.report(path, isDirectory, 'failed', error);
      return false;
    }
  }

  /** A folder's entries, sorted, or null (reported) when it cannot be listed. */
  async list(client: SftpFileClient, dir: string): Promise<SftpDetailedEntry[] | null> {
    try {
      const entries = await this.call(() => client.sftpListDetailed(dir));
      return entries.sort(byName);
    } catch (error) {
      if (this.options.signal?.aborted) throw filesError('cancelled', this.cancelledMessage);
      this.report(dir, true, 'failed', error);
      return null;
    }
  }
}

async function lookUp(client: SftpFileClient, path: string): Promise<SftpDetailedEntry | null> {
  try {
    return await remoteEntryOf(client, path);
  } catch (error) {
    throw mapSftpError(error, path);
  }
}

/**
 * Deletes `path` for good, a folder with everything in it, bottom up. A path that is already gone
 * counts as done (with nothing reported); the server's root folder is refused.
 */
export async function removeRecursive(
  client: SftpFileClient,
  path: string,
  options: RemoteOpOptions,
): Promise<RemoteOpResult> {
  const target = normalizeRemote(path);
  if (target === '/') {
    throw filesError('invalidInput', "The server's root folder cannot be deleted.");
  }
  const run = new OpRun(options, `Deleting ${target} was cancelled.`);
  run.check();
  const entry = await lookUp(client, target);
  if (!entry) return run.result;

  const removeEntry = async (at: string, item: SftpDetailedEntry): Promise<boolean> => {
    if (item.isDirectory && !item.isSymlink) return removeFolder(at);
    // Files, links of every kind and anything else go with an unlink, which never follows a link.
    return run.attempt(at, false, () => client.sftpUnlink(at));
  };
  const removeFolder = async (dir: string): Promise<boolean> => {
    const children = await run.list(client, dir);
    if (!children) return false;
    const removed = await Promise.all(
      children.map((child) => removeEntry(joinRemote(dir, child.name), child)),
    );
    // A folder that still holds something it could not remove stays; the failure inside says why.
    if (removed.includes(false)) return false;
    return run.attempt(dir, true, () => client.sftpRmdir(dir));
  };
  await removeEntry(target, entry);
  return run.result;
}

/**
 * Sets the permission bits of `path`, and with a scope other than `none` of what is inside a
 * folder: everything (`all`), only the files, or only the folders. The selected path itself is
 * changed unless the scope leaves out its kind (a folder under `files`) or it is a link: links are
 * skipped everywhere. So 0o600 on the files of a folder never locks its owner out of it.
 *
 * A folder is changed before its contents are when the new mode still lets its owner list and
 * enter it (`u+rx`), and after them otherwise, so a mode like 0o600 does not lock the walk out.
 */
export async function chmodRecursive(
  client: SftpFileClient,
  path: string,
  mode: number,
  scope: SftpChmodScope,
  options: RemoteOpOptions,
): Promise<RemoteOpResult> {
  const target = normalizeRemote(path);
  const run = new OpRun(options, `Changing the permissions of ${target} was cancelled.`);
  run.check();
  const entry = await lookUp(client, target);
  if (!entry) throw filesError('remoteFolderMissing', `${target} is not on the server.`);
  const chmod = (at: string, isDirectory: boolean) =>
    run.attempt(at, isDirectory, () => client.sftpChmod(at, mode));
  const ownerCanEnter = (mode & 0o500) === 0o500;
  const filesToo = scope === 'all' || scope === 'files';
  const foldersToo = scope === 'all' || scope === 'dirs';

  const visitFolder = async (dir: string, changeSelf: boolean): Promise<void> => {
    if (changeSelf && ownerCanEnter) await chmod(dir, true);
    const children = await run.list(client, dir);
    if (children) {
      await Promise.all(
        children.map(async (child) => {
          const at = joinRemote(dir, child.name);
          if (child.isSymlink) run.report(at, child.isDirectory, 'skipped');
          else if (child.isDirectory) await visitFolder(at, foldersToo);
          else if (child.isFile && filesToo) await chmod(at, false);
        }),
      );
    }
    if (changeSelf && !ownerCanEnter) await chmod(dir, true);
  };

  if (entry.isSymlink) run.report(target, entry.isDirectory, 'skipped');
  else if (!entry.isDirectory || scope === 'none') await chmod(target, entry.isDirectory);
  else await visitFolder(target, foldersToo);
  return run.result;
}
