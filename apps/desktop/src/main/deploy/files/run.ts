import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BaseEntry,
  type LocalFileEntry,
  type PlannedChange,
  type RemoteObservation,
  syncPathFolder,
} from '@runova/core';
import {
  type FilesErrorCode,
  filesError,
  filesErrorCode,
  filesErrorMessage,
} from '../../../shared/deployFilesErrors';
import type {
  FilesConflictChoice,
  FilesDeployInput,
  FilesProgressEvent,
  FilesRunFailure,
  FilesRunPhase,
  FilesRunResult,
  FilesRunState,
  FilesRunTrigger,
} from '../../../shared/deployFilesTypes';
import { limiter } from '../../util/limiter';
import { hashFile } from '../hashFile';
import {
  type BaseTarget,
  baseTargetOf,
  type FilesBase,
  type FilesJournal,
  foldJournal,
  openJournal,
  readBase,
  sameTarget,
} from './bases';
import { appendHistory } from './history';
import { type KeptFilesPlan, remotePathOf } from './plan';
import {
  backupTargetOf,
  type OpenRemoteFiles,
  type RemoteFiles,
  type RemoteStat,
} from './transport/types';
import type { FilesConnectTarget, StoredFileSite } from './types';

/**
 * A deploy run of an FTP or SFTP site (E23): it acts on a plan the user reviewed, taken from the
 * planner by its id, and only on the paths the user picked. In order:
 * 1. part files a stopped upload left in the listed folders are removed, an old file a stopped
 *    replace moved aside is deleted (or put back, when its file is gone), and paths deleted here
 *    and already gone from the server leave the base;
 * 2. the folders the uploads need are made, top down, and each one Runova made is recorded,
 *    since those are the only folders it may remove again;
 * 3. uploads, as many at once as the connection allows (4 on SFTP, 1 on FTP). Each file is
 *    checked against the plan first (size and time, then the hash), and one edited since the
 *    plan is skipped and stays pending. The server copy is looked at once too: one changed there
 *    since the plan is left alone and listed as a `conflict` failure;
 * 4. deletes, only of files the plan saw on the server as the last deploy left them, or that the
 *    review chose to delete;
 * 5. folders Runova made and that are now empty are removed. The server refuses a folder that
 *    still holds anything, so someone else's file keeps its folder;
 * 6. on FTP, the time of each file the upload could not report is read once more.
 *
 * A change on the server is never written over without a choice: a conflict is sent only with an
 * explicit `overwrite` (or the first deploy choice, for files already there on a first deploy),
 * and is skipped otherwise. A file deleted here whose server copy changed is deleted on the
 * server only with an explicit `overwrite` (the review's Delete); otherwise it is kept and stays
 * pending.
 *
 * Every finished file is written to the journal at once, and the journal is folded into the base
 * when the run ends, however it ends. A run that fails or is cancelled therefore keeps what it
 * finished, and the plan after it only has the rest.
 */

export interface RunnerDeps {
  takePlan: (siteId: string, planId: string) => KeptFilesPlan;
  /**
   * Hands a plan back when the run could not connect, so nothing was sent: the user can trust
   * the host key or unlock the vault and deploy the same review again.
   */
  giveBackPlan: (kept: KeptFilesPlan) => void;
  getSite: (siteId: string) => Promise<StoredFileSite | null>;
  connectTarget: (site: StoredFileSite) => Promise<FilesConnectTarget>;
  openRemote: OpenRemoteFiles;
  readBase: (siteId: string, target: BaseTarget) => Promise<FilesBase>;
  openJournal: (siteId: string) => Promise<FilesJournal>;
  foldJournal: (siteId: string) => Promise<FilesBase | null>;
  appendHistory: (siteId: string, entry: FilesRunResult) => Promise<void>;
  now: () => number;
  randomId: () => string;
  onProgress: (event: FilesProgressEvent) => void;
}

export interface FilesRunner {
  run: (
    input: FilesDeployInput,
    trigger: FilesRunTrigger,
    signal?: AbortSignal,
  ) => Promise<FilesRunResult>;
}

/** Progress updates within one phase are at least this far apart (10 a second at most). */
export const FILES_PROGRESS_GAP_MS = 100;

const defaultDeps: Omit<RunnerDeps, 'takePlan'> = {
  // Loaded on first use: the store and the transports pull in the vault and the SSH pool.
  getSite: async (siteId) => (await import('./store')).getFileSite(siteId),
  connectTarget: async (site) => (await import('./target')).connectTargetOf(site),
  openRemote: async (target, options) =>
    (await import('./connect')).openRemoteFiles(target, options),
  readBase,
  openJournal,
  foldJournal,
  appendHistory,
  now: () => Date.now(),
  randomId: () => randomUUID(),
  onProgress: () => undefined,
  giveBackPlan: () => undefined,
};

/** Failures that end the run: the connection or the login is gone, or the server is full. */
const BREAKS_OFF: ReadonlySet<FilesErrorCode> = new Set<FilesErrorCode>([
  'unreachable',
  'timeout',
  'auth',
  'vaultLocked',
  'hostKeyUnknown',
  'hostKeyChanged',
  'tlsUntrusted',
  'tlsNameMismatch',
  'tlsUnavailable',
  'diskFull',
]);

interface Upload {
  path: string;
  local: LocalFileEntry;
  /** What the plan saw on the server at the path, or null for nothing there. */
  server: RemoteObservation | null;
}

interface Delete {
  path: string;
  server: RemoteObservation | null;
}

interface Adopt {
  path: string;
  local: LocalFileEntry;
  server: RemoteObservation | null;
}

interface Work {
  uploads: Upload[];
  adopts: Adopt[];
  deletes: Delete[];
  /** Leave the base without anything sent. */
  drops: string[];
  skipped: number;
}

/** The paths that reach the root from a folder inside the site: `a/b` gives `a` and `a/b`. */
function folderChain(folder: string): string[] {
  const chain: string[] = [];
  for (let current = folder; current !== ''; current = syncPathFolder(current)) {
    chain.unshift(current);
  }
  return chain;
}

function depth(folder: string): number {
  return folder.split('/').length;
}

function observationOf(stat: RemoteStat): RemoteObservation {
  return { size: stat.size, mtimeMs: stat.mtimeMs, via: stat.via };
}

/**
 * Whether the server's copy is no longer the one the plan saw: something turned up where it saw
 * nothing, or the size changed, or the time did when both came from the same source. Nothing
 * there now is not a change worth stopping for: there is nothing to write over or lose.
 */
function changedSincePlan(seen: RemoteObservation | null, now: RemoteStat | null): boolean {
  if (!now) return false;
  if (now.isDirectory || !seen) return true;
  if (now.size !== seen.size) return true;
  return (
    seen.mtimeMs !== null &&
    now.mtimeMs !== null &&
    seen.via === now.via &&
    seen.mtimeMs !== now.mtimeMs
  );
}

function changedOnServer(path: string): Error {
  return filesError(
    'conflict',
    `${path} changed on the server after the plan was made, so it was left as it is. Check the server again to review it.`,
  );
}

/** What the run does with each picked path. */
function workOf(kept: KeptFilesPlan, input: FilesDeployInput): Work {
  const work: Work = { uploads: [], adopts: [], deletes: [], drops: [], skipped: 0 };
  const picked = new Set(input.paths);
  const conflicts = input.conflicts ?? {};
  const upload = (change: PlannedChange) => {
    const local = kept.local[change.path];
    if (local) work.uploads.push({ path: change.path, local, server: change.server });
    else work.skipped += 1;
  };
  const adopt = (change: PlannedChange) => {
    const local = kept.local[change.path];
    if (local) work.adopts.push({ path: change.path, local, server: change.server });
    else work.skipped += 1;
  };

  for (const change of kept.plan.changes) {
    if (!picked.has(change.path)) {
      work.skipped += 1;
      continue;
    }
    switch (change.action) {
      case 'upload':
        upload(change);
        break;
      case 'adopt':
        adopt(change);
        break;
      case 'deleteRemote':
        // The planner only plans these, but a delete is the one step that cannot be undone.
        if (change.remote === 'unchanged' || change.remote === 'sizeOnly') {
          work.deletes.push({ path: change.path, server: change.server });
        } else {
          work.skipped += 1;
        }
        break;
      case 'conflict': {
        // Not every conflict has a choice, whatever the record type says.
        const chosen = conflicts[change.path] as FilesConflictChoice | undefined;
        const choice = chosen ?? firstDeployChoice(kept, input, change);
        if (change.local === 'deleted') {
          // The server's copy changed, so only the review's own Delete removes it.
          if (chosen === 'overwrite')
            work.deletes.push({ path: change.path, server: change.server });
          else work.skipped += 1;
        } else if (choice === 'overwrite') upload(change);
        else if (choice === 'adopt') adopt(change);
        else work.skipped += 1;
        break;
      }
    }
  }

  const missing = new Set(kept.plan.missingOnServer);
  for (const path of new Set(input.reupload ?? [])) {
    const local = kept.local[path];
    if (missing.has(path) && local) work.uploads.push({ path, local, server: null });
  }
  work.drops.push(...kept.plan.dropFromBase);

  // A rename in case only (a.txt to A.txt) is a delete and an upload of one file on a server that
  // does not tell them apart, where the delete would take the new file. The old name only leaves
  // the base, and the upload is held to the file the plan saw under the old name.
  const sent = new Map(work.uploads.map((item) => [item.path.toLowerCase(), item]));
  work.deletes = work.deletes.filter((item) => {
    const upload = sent.get(item.path.toLowerCase());
    if (!upload) return true;
    work.drops.push(item.path);
    upload.server ??= item.server;
    return false;
  });
  return work;
}

/**
 * The first deploy choice for a file the server already has: send it, or, with `adoptSameSize`,
 * take a file of the local size as sent. Null outside a first deploy, so the conflict is skipped.
 */
function firstDeployChoice(
  kept: KeptFilesPlan,
  input: FilesDeployInput,
  change: PlannedChange,
): 'overwrite' | 'adopt' | null {
  if (change.conflict !== 'existsOnServer' || !kept.plan.firstDeploy || !input.firstDeploy) {
    return null;
  }
  if (input.firstDeploy === 'overwrite') return 'overwrite';
  const local = kept.local[change.path];
  return local && change.server && change.server.size === local.size ? 'adopt' : 'overwrite';
}

export function createRunner(
  overrides: Partial<RunnerDeps> & Pick<RunnerDeps, 'takePlan'>,
): FilesRunner {
  const deps: RunnerDeps = { ...defaultDeps, ...overrides };

  async function run(
    input: FilesDeployInput,
    trigger: FilesRunTrigger,
    signal?: AbortSignal,
  ): Promise<FilesRunResult> {
    const kept = deps.takePlan(input.siteId, input.planId);
    const site = await deps.getSite(input.siteId);
    if (!site) throw filesError('siteUnknown', 'That site is no longer saved.');
    // Pointed somewhere else since the plan, or edited (an ignore line, say): what the plan says
    // no longer applies. Only an edit by a person moves updatedAt; a deploy's own writes do not.
    if (!sameTarget(baseTargetOf(site), kept.target) || site.updatedAt !== kept.site.updatedAt) {
      throw filesError(
        'planExpired',
        'The site was changed after the plan was made. Check the server again and review the changes.',
      );
    }

    const work = workOf(kept, input);
    const { remoteRoot } = kept;
    const runId = deps.randomId();
    const startedAt = deps.now();
    const failed: FilesRunFailure[] = [];
    let uploaded = 0;
    let deleted = 0;
    let adopted = 0;
    let skipped = work.skipped;
    let bytes = 0;
    let atomic = true;
    let filesDone = 0;
    let cancelled = false;
    let error: FilesRunResult['error'] = null;
    const sending = new Map<string, number>();
    const filesTotal = work.uploads.length + work.adopts.length + work.deletes.length;
    const bytesTotal = work.uploads.reduce((sum, item) => sum + item.local.size, 0);

    let phase: FilesRunPhase = 'connecting';
    let currentPath: string | null = null;
    let lastAt = Number.NEGATIVE_INFINITY;
    let lastPhase: FilesRunPhase | null = null;
    const emit = (force = false) => {
      const at = deps.now();
      if (!force && phase === lastPhase && at - lastAt < FILES_PROGRESS_GAP_MS) return;
      lastAt = at;
      lastPhase = phase;
      let inFlight = 0;
      for (const sent of sending.values()) inFlight += sent;
      try {
        deps.onProgress({
          siteId: site.id,
          runId,
          trigger,
          phase,
          filesDone,
          filesTotal,
          bytesDone: bytes + inFlight,
          bytesTotal,
          currentPath,
        });
      } catch {
        // A window that just closed must not stop the run.
      }
    };
    const enter = (next: FilesRunPhase) => {
      phase = next;
      currentPath = null;
      emit(true);
    };
    const stopped = () => cancelled || error !== null || signal?.aborted === true;

    /** Records a failure on one path; true when it ends the run. */
    const fail = (path: string, failure: unknown): void => {
      const code = filesErrorCode(failure);
      if (signal?.aborted || code === 'cancelled') {
        cancelled = true;
        return;
      }
      const coded = { code: code ?? 'server', message: filesErrorMessage(failure) };
      failed.push({ path, ...coded });
      if (BREAKS_OFF.has(coded.code)) error ??= coded;
    };

    /** The local file as the plan saw it, with its time now; null when it changed since. */
    const localNow = async (path: string, planned: LocalFileEntry) => {
      const absolute = join(site.localFolder, ...path.split('/'));
      const info = await lstat(absolute).catch(() => null);
      if (!info?.isFile() || info.size !== planned.size) return null;
      if (info.mtimeMs === planned.mtimeMs) return planned;
      const sha256 = await hashFile(absolute, info.size, info.mtimeMs);
      return sha256 === planned.sha256 ? { ...planned, mtimeMs: info.mtimeMs } : null;
    };

    let remote: RemoteFiles | null = null;
    let journal: FilesJournal | null = null;
    let connected = false;
    try {
      enter('connecting');
      remote = await deps.openRemote(await deps.connectTarget(site), {
        purpose: 'run',
        signal,
        unattended: trigger === 'deployOnSave',
      });
      connected = true;
      // The base file must exist for this target before the journal, or the fold drops it.
      const base = await deps.readBase(site.id, kept.target);
      journal = await deps.openJournal(site.id);
      const open = remote;
      const log = journal;
      const createdDirs = new Set(base.createdDirs);
      /** Folders this run made: nothing in them can have changed since the plan. */
      const madeNow = new Set<string>();

      enter('checking');
      for (const part of kept.partFiles) {
        if (stopped()) break;
        try {
          await open.remove(part);
        } catch (failure) {
          // Only ours and harmless to leave; the next run tries again.
          if (BREAKS_OFF.has(filesErrorCode(failure) as FilesErrorCode)) throw failure;
        }
      }
      // A replace that stopped with the old file moved aside: the file is either in place (the
      // backup is only ours to delete) or gone, and then the backup is all there is of it.
      for (const backup of kept.backupFiles) {
        if (stopped()) break;
        try {
          const real = backupTargetOf(backup);
          if (await open.stat(real)) await open.remove(backup);
          else await open.rename(backup, real);
        } catch (failure) {
          if (BREAKS_OFF.has(filesErrorCode(failure) as FilesErrorCode)) throw failure;
        }
      }
      for (const path of work.drops) await log.append({ t: 'drop', path });

      if (!stopped()) {
        enter('folders');
        // Folders the plan saw on the server, and so every folder above them.
        const known = new Set<string>();
        for (const dir of kept.existingDirs) {
          known.add('');
          for (const folder of folderChain(dir)) known.add(folder);
        }
        const needed = new Set<string>();
        for (const item of work.uploads) {
          for (const folder of folderChain(syncPathFolder(item.path))) needed.add(folder);
        }
        if (!known.has('') && work.uploads.length > 0) {
          // The remote folder itself is the user's: made when missing, never recorded or removed.
          if (await open.ensureDir(remoteRoot)) madeNow.add('');
        }
        // Top down, one folder per call: ensureDir only says whether it made the one it was asked.
        for (const folder of [...needed].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1))) {
          if (stopped()) break;
          if (known.has(folder)) continue;
          currentPath = folder;
          try {
            if (await open.ensureDir(remotePathOf(remoteRoot, folder))) {
              await log.append({ t: 'dir', path: folder });
              createdDirs.add(folder);
              madeNow.add(folder);
            }
          } catch (failure) {
            // The uploads into it fail on their own and are listed; a dead connection ends here.
            if (BREAKS_OFF.has(filesErrorCode(failure) as FilesErrorCode)) throw failure;
          }
        }
      }

      const rereads: { path: string; entry: BaseEntry }[] = [];
      if (!stopped()) {
        enter('uploading');
        for (const item of work.adopts) {
          if (stopped()) break;
          currentPath = item.path;
          try {
            const local = await localNow(item.path, item.local);
            if (!local) skipped += 1;
            else {
              await log.append({
                t: 'put',
                path: item.path,
                entry: {
                  sha256: local.sha256,
                  size: local.size,
                  localMtimeMs: local.mtimeMs,
                  remote: item.server,
                },
              });
              adopted += 1;
            }
          } catch (failure) {
            // A local file that cannot be read now fails on its own, like an upload would.
            fail(item.path, failure);
          }
          filesDone += 1;
          emit();
        }

        const limit = limiter(Math.max(1, open.maxParallel));
        const refreshTimes = open.protocol !== 'sftp' && kept.capabilities.mtime !== 'none';
        await Promise.all(
          work.uploads.map((item) =>
            limit(async () => {
              if (stopped()) return;
              currentPath = item.path;
              try {
                const local = await localNow(item.path, item.local);
                if (!local) {
                  skipped += 1;
                  return;
                }
                const target = remotePathOf(remoteRoot, item.path);
                // The plan may be minutes old: one look first, so a change made on the server
                // since is never written over.
                if (
                  !madeNow.has(syncPathFolder(item.path)) &&
                  changedSincePlan(item.server, await open.stat(target))
                ) {
                  fail(item.path, changedOnServer(item.path));
                  return;
                }
                sending.set(item.path, 0);
                const done = await open.putFile(
                  join(site.localFolder, ...item.path.split('/')),
                  target,
                  {
                    sha256: local.sha256,
                    size: local.size,
                    signal,
                    onBytes: (sent) => {
                      sending.set(item.path, sent);
                      emit();
                    },
                  },
                );
                const entry: BaseEntry = {
                  sha256: local.sha256,
                  size: local.size,
                  localMtimeMs: local.mtimeMs,
                  remote: observationOf(done.stat),
                };
                await log.append({ t: 'put', path: item.path, entry });
                uploaded += 1;
                bytes += local.size;
                atomic &&= done.atomic;
                if (refreshTimes && done.stat.mtimeMs === null) {
                  rereads.push({ path: item.path, entry });
                }
              } catch (failure) {
                // Changed while it was sent: the server keeps the old file, and it stays pending.
                if (filesErrorCode(failure) === 'localChanged') skipped += 1;
                else fail(item.path, failure);
              } finally {
                sending.delete(item.path);
                filesDone += 1;
                emit();
              }
            }),
          ),
        );
      }

      const removedFrom = new Set<string>();
      if (!stopped()) {
        enter('deleting');
        for (const { path, server } of work.deletes) {
          if (stopped()) break;
          currentPath = path;
          // Back here since the plan: deleting the server's copy now would be a step backwards.
          const back = await lstat(join(site.localFolder, ...path.split('/'))).catch(() => null);
          if (back) skipped += 1;
          else {
            try {
              const target = remotePathOf(remoteRoot, path);
              // Changed on the server since the plan: what would be deleted is not what it saw.
              if (changedSincePlan(server, await open.stat(target))) throw changedOnServer(path);
              await open.remove(target);
              await log.append({ t: 'del', path });
              deleted += 1;
              for (const folder of folderChain(syncPathFolder(path))) removedFrom.add(folder);
            } catch (failure) {
              fail(path, failure);
            }
          }
          filesDone += 1;
          emit();
        }
      }

      if (!stopped()) {
        enter('cleaning');
        const emptied = [...removedFrom]
          .filter((folder) => createdDirs.has(folder))
          .sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1));
        for (const folder of emptied) {
          if (stopped()) break;
          currentPath = folder;
          try {
            if (await open.removeEmptyDir(remotePathOf(remoteRoot, folder))) {
              await log.append({ t: 'rmdir', path: folder });
            }
          } catch (failure) {
            if (BREAKS_OFF.has(filesErrorCode(failure) as FilesErrorCode)) throw failure;
          }
        }
        for (const { path, entry } of rereads) {
          if (stopped()) break;
          try {
            const stat = await open.stat(remotePathOf(remoteRoot, path));
            if (stat && !stat.isDirectory && stat.mtimeMs !== null) {
              await log.append({
                t: 'put',
                path,
                entry: { ...entry, remote: observationOf(stat) },
              });
            }
          } catch (failure) {
            // The upload stands; without its time the next plan compares sizes only.
            if (BREAKS_OFF.has(filesErrorCode(failure) as FilesErrorCode)) throw failure;
          }
        }
      }
    } catch (failure) {
      const code = filesErrorCode(failure);
      if (signal?.aborted || code === 'cancelled') cancelled = true;
      else error ??= { code: code ?? 'server', message: filesErrorMessage(failure) };
    } finally {
      await journal?.close().catch(() => undefined);
      await deps.foldJournal(site.id).catch(() => undefined);
      await remote?.close().catch(() => undefined);
    }
    // Nothing reached the server, so what the user reviewed still holds.
    if (!connected) deps.giveBackPlan(kept);

    if (signal?.aborted) cancelled = true;
    const finished = uploaded + deleted + adopted;
    let state: FilesRunState;
    if (cancelled) state = 'cancelled';
    else if (error || failed.length > 0) state = finished > 0 ? 'partial' : 'failed';
    else state = 'done';

    const result: FilesRunResult = {
      runId,
      siteId: site.id,
      trigger,
      state,
      startedAt,
      finishedAt: deps.now(),
      uploaded,
      deleted,
      adopted,
      skipped,
      bytes,
      failed,
      atomic,
      error: cancelled ? null : error,
    };
    // History is a record for the user; a run that did its work does not fail over it.
    await deps.appendHistory(site.id, result).catch(() => undefined);
    enter('done');
    return result;
  }

  return { run };
}
