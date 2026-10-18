import { randomUUID } from 'node:crypto';
import {
  type LocalFileMap,
  planFileSync,
  type RemoteObservation,
  type SyncPlan,
  syncPathFolder,
} from '@agentmat/core';
import { filesError } from '../../../shared/deployFilesErrors';
import type { FilesPlanNotice, FilesPlanView } from '../../../shared/deployFilesTypes';
import { limiter } from '../../util/limiter';
import { type BaseTarget, baseTargetOf, type FilesBase, peekBase } from './bases';
import {
  baseWithoutLeftOut,
  type FilesLocalWalk,
  type FilesWalkOptions,
  seedHashCache,
  walkSiteFolder,
} from './localWalk';
import { joinRemote, normalizeRemote } from './transport/remotePath';
import {
  BACKUP_FILE,
  type OpenRemoteFiles,
  PART_FILE,
  type RemoteCapabilities,
  type RemoteFiles,
} from './transport/types';
import type { FilesConnectTarget, StoredFileSite } from './types';

/**
 * The plan of a deploy to an FTP or SFTP site (E23): what each path needs, judged from this
 * computer, the last deploy and the server as it is now.
 *
 * The server is read as little as possible, since an FTP listing can take a second a folder:
 * - the folder is walked and planned with the server not read, which gives every path that
 *   changed here, the deleted ones included;
 * - only the folders those paths are in get listed. A deleted path's folder is listed too, so the
 *   file is judged (a delete needs it seen unchanged) instead of left unknown. A folder that is
 *   not on the server lists as nothing, and its files count as missing there;
 * - an FTP server with LIST only carries no times, so the time of each planned file it already
 *   has is asked for one by one with MDTM, up to FILES_MDTM_CAP. Past that the plan compares
 *   sizes only and says so.
 *
 * The plan is kept here in main for ten minutes and the renderer only sees a FilesPlanView. A
 * deploy hands back the plan id, and the run takes the plan once: what it acts on is exactly what
 * the user reviewed. A run that could not connect gives it back (`giveBack`), so the same review
 * can be deployed once the key is trusted; editing the site (`forget`) drops it for good. A site keeps its last few plans, so a newer one (Deploy on save planning
 * in the background, say) does not take away a review that is still open.
 *
 * The connect target is not kept with the plan: it holds the unsealed secret, and the run builds
 * its own.
 */

export const FILES_PLAN_TTL_MS = 10 * 60 * 1000;
/** Kept plans per site. A Deploy on save plan must not drop a review the user has open. */
export const FILES_PLANS_PER_SITE = 4;
/** Listings (and MDTM asks) in flight at once. */
export const FILES_LIST_PARALLEL = 8;
/** Past this many files to ask the time of one by one, the plan compares sizes only. */
export const FILES_MDTM_CAP = 500;
/** More deletes than this, or a larger share of the base, is a mass delete. */
export const FILES_MASS_DELETE_COUNT = 20;
export const FILES_MASS_DELETE_SHARE = 0.25;
/** The share counts only from this many deletes, or one delete of a 3-file site would be mass. */
export const FILES_MASS_DELETE_SHARE_FLOOR = 5;

export interface PlannerDeps {
  getSite: (siteId: string) => Promise<StoredFileSite | null>;
  connectTarget: (site: StoredFileSite) => Promise<FilesConnectTarget>;
  walk: (options: FilesWalkOptions) => Promise<FilesLocalWalk>;
  /** Read only: the plan must not fold a journal a run may still be writing. */
  peekBase: (siteId: string, target: BaseTarget) => Promise<FilesBase>;
  openRemote: OpenRemoteFiles;
  now: () => number;
  randomId: () => string;
  mdtmCap: number;
}

/** Everything the run needs from the plan, so it does not read the server again first. */
export interface KeptFilesPlan {
  view: FilesPlanView;
  site: StoredFileSite;
  target: BaseTarget;
  /** The remote folder, normalized. */
  remoteRoot: string;
  plan: SyncPlan;
  local: LocalFileMap;
  /** The base the plan judged against, without the paths the walk left out. */
  base: FilesBase;
  /** Listed folders that are on the server, by path inside the site (`''` for the root). */
  existingDirs: string[];
  /** Part files a stopped upload left in the listed folders, absolute. */
  partFiles: string[];
  /** Old files a stopped replace moved aside in the listed folders, absolute. */
  backupFiles: string[];
  capabilities: RemoteCapabilities;
  /** The site's generation when the plan was made; see `forget`. */
  generation: number;
}

export interface FilesPlanOptions {
  signal?: AbortSignal;
  /** Planned with nobody there to look (Deploy on save); see `OpenRemoteFiles`. */
  unattended?: boolean;
}

export interface FilesPlanner {
  plan: (siteId: string, options?: FilesPlanOptions) => Promise<FilesPlanView>;
  /** The kept plan, handed out once. `planExpired` when it is gone, too old or another site's. */
  take: (siteId: string, planId: string) => KeptFilesPlan;
  /**
   * Keeps a taken plan again under its id and expiry, for a run that could not connect. Ignored
   * once it expired or the site was forgotten since it was made.
   */
  giveBack: (entry: KeptFilesPlan) => void;
  /** Drops the site's kept plans and any plan under way (the site was edited or removed). */
  forget: (siteId: string) => void;
}

const defaultDeps: PlannerDeps = {
  // Loaded on first use: the store and the transports pull in the vault and the SSH pool.
  getSite: async (siteId) => (await import('./store')).getFileSite(siteId),
  connectTarget: async (site) => (await import('./target')).connectTargetOf(site),
  walk: walkSiteFolder,
  peekBase,
  openRemote: async (target, options) =>
    (await import('./connect')).openRemoteFiles(target, options),
  now: () => Date.now(),
  randomId: () => randomUUID(),
  mdtmCap: FILES_MDTM_CAP,
};

/** The absolute path on the server of a path inside the site. */
export function remotePathOf(remoteRoot: string, path: string): string {
  return path === '' ? remoteRoot : joinRemote(remoteRoot, path);
}

interface ServerView {
  listedDirs: Set<string>;
  existingDirs: Set<string>;
  entries: Record<string, RemoteObservation>;
  partFiles: string[];
  backupFiles: string[];
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw filesError('cancelled', 'Checking the server was cancelled.');
}

/** Runs every task, then throws the first failure, so nothing is still running afterwards. */
async function settleAll(tasks: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

async function listFolders(
  remote: RemoteFiles,
  remoteRoot: string,
  folders: Iterable<string>,
  limit: <T>(work: () => Promise<T>) => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<ServerView> {
  const view: ServerView = {
    listedDirs: new Set(),
    existingDirs: new Set(),
    entries: {},
    partFiles: [],
    backupFiles: [],
  };
  await settleAll(
    [...folders].map((folder) =>
      limit(async () => {
        throwIfCancelled(signal);
        const listing = await remote.list(remotePathOf(remoteRoot, folder));
        // A folder that is not there counts as listed: none of its files are on the server.
        view.listedDirs.add(folder);
        if (!listing) return;
        view.existingDirs.add(folder);
        for (const entry of listing) {
          if (entry.isDirectory) continue;
          if (PART_FILE.test(entry.name)) {
            view.partFiles.push(entry.path);
            continue;
          }
          if (BACKUP_FILE.test(entry.name)) {
            view.backupFiles.push(entry.path);
            continue;
          }
          const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
          view.entries[path] = { size: entry.size, mtimeMs: entry.mtimeMs, via: entry.via };
        }
      }),
    ),
  );
  view.partFiles.sort();
  view.backupFiles.sort();
  return view;
}

export function createPlanner(overrides: Partial<PlannerDeps> = {}): FilesPlanner {
  const deps: PlannerDeps = { ...defaultDeps, ...overrides };
  const kept = new Map<string, KeptFilesPlan>();
  /** Bumped by forget, so a plan under way when the site changed is never kept. */
  const generations = new Map<string, number>();

  function expired(): Error {
    return filesError(
      'planExpired',
      'This plan is no longer current. Check the server again and review the changes.',
    );
  }

  function prune(): void {
    const now = deps.now();
    for (const [planId, entry] of kept) {
      if (now > entry.view.expiresAt) kept.delete(planId);
    }
  }

  function forget(siteId: string): void {
    generations.set(siteId, (generations.get(siteId) ?? 0) + 1);
    for (const [planId, entry] of kept) {
      if (entry.site.id === siteId) kept.delete(planId);
    }
  }

  async function plan(siteId: string, options: FilesPlanOptions = {}): Promise<FilesPlanView> {
    const { signal } = options;
    const generation = generations.get(siteId) ?? 0;
    prune();
    const site = await deps.getSite(siteId);
    if (!site) throw filesError('siteUnknown', 'That site is no longer saved.');
    const target = baseTargetOf(site);
    const base = await deps.peekBase(site.id, target);
    const walk = await deps.walk({
      root: site.localFolder,
      ignorePatterns: site.ignorePatterns,
      tracked: new Set(Object.keys(base.files)),
      hashes: seedHashCache(base.files),
      signal,
    });
    // Never plan against a folder that is not there: every deployed file would read as deleted.
    if (!walk.exists) {
      throw filesError(
        'folderMissing',
        `The deploy folder ${site.localFolder} is not there. Check that it was not moved or renamed, and that its drive is connected.`,
      );
    }
    throwIfCancelled(signal);

    const local = walk.files;
    // A deployed file the walk now leaves out (ignored, say) is not a delete; it stays in the base.
    const baseFiles = baseWithoutLeftOut(base.files, walk.leftOut);
    const blind = planFileSync({ local, base: baseFiles, remote: null });
    const folders = new Set(blind.changes.map((change) => syncPathFolder(change.path)));
    const remoteRoot = normalizeRemote(site.remoteRoot);
    const remote = await deps.openRemote(await deps.connectTarget(site), {
      purpose: 'browse',
      signal,
      unattended: options.unattended === true,
    });
    let capabilities: RemoteCapabilities;
    let server: ServerView;
    let mdtmCapped = false;
    try {
      capabilities = await remote.capabilities();
      const limit = limiter(FILES_LIST_PARALLEL);
      server = await listFolders(remote, remoteRoot, folders, limit, signal);

      if (capabilities.mtime === 'mdtm') {
        // Only a file the base knows is judged by its time; a new one only needs to exist.
        const asks = blind.changes
          .map((change) => change.path)
          .filter((path) => baseFiles[path] && server.entries[path]);
        if (asks.length > deps.mdtmCap) {
          mdtmCapped = true;
        } else {
          await settleAll(
            asks.map((path) =>
              limit(async () => {
                throwIfCancelled(signal);
                const stat = await remote.stat(remotePathOf(remoteRoot, path));
                server.listedDirs.add(syncPathFolder(path));
                if (!stat || stat.isDirectory) {
                  delete server.entries[path];
                  return;
                }
                server.entries[path] = { size: stat.size, mtimeMs: stat.mtimeMs, via: stat.via };
              }),
            ),
          );
        }
      }
    } finally {
      await remote.close().catch(() => undefined);
    }

    const result = planFileSync({
      local,
      base: baseFiles,
      remote: { listedDirs: server.listedDirs, entries: server.entries },
    });
    const baseCount = Object.keys(baseFiles).length;
    const massDelete =
      result.deleteCount > FILES_MASS_DELETE_COUNT ||
      (result.deleteCount >= FILES_MASS_DELETE_SHARE_FLOOR &&
        result.deleteCount > baseCount * FILES_MASS_DELETE_SHARE) ||
      (baseCount > 0 && Object.keys(local).length === 0);
    const notices: FilesPlanNotice[] = [];
    if (capabilities.mtime === 'none') notices.push('sizeOnly');
    if (mdtmCapped) notices.push('mdtmCapped');
    if (!capabilities.atomicReplace) notices.push('notAtomic');
    if (result.clockShiftHours !== null) notices.push('clockShift');

    const createdAt = deps.now();
    const view: FilesPlanView = {
      planId: deps.randomId(),
      siteId: site.id,
      createdAt,
      expiresAt: createdAt + FILES_PLAN_TTL_MS,
      changes: result.changes.map((change) => ({ ...change })),
      uploadBytes: result.uploadBytes,
      deleteCount: result.deleteCount,
      serverOnlyDrift: [...result.serverOnlyDrift],
      missingOnServer: [...result.missingOnServer],
      // Only a first deploy that would write over files already there needs a choice. The
      // planner also reports one when the folder holds nothing but files this site never sends,
      // and Deploy on save stops on any first deploy, so that one is left out here.
      firstDeploy:
        result.firstDeploy && result.firstDeploy.existing > 0 ? result.firstDeploy : null,
      clockShiftHours: result.clockShiftHours,
      massDelete,
      notices,
    };
    // Edited or forgotten while this plan read: it may hold an ignored file, or the old base.
    if ((generations.get(siteId) ?? 0) !== generation) throw expired();
    kept.set(view.planId, {
      view,
      site,
      target,
      remoteRoot,
      plan: result,
      local,
      base: { ...base, files: baseFiles },
      existingDirs: [...server.existingDirs].sort(),
      partFiles: server.partFiles,
      backupFiles: server.backupFiles,
      capabilities,
      generation,
    });
    trim(site.id);
    return view;
  }

  /** Keeps the site's newest plans only; the map keeps insertion order, oldest first. */
  function trim(siteId: string): void {
    const ofSite = [...kept].filter(([, entry]) => entry.site.id === siteId);
    for (const [planId] of ofSite.slice(0, Math.max(0, ofSite.length - FILES_PLANS_PER_SITE))) {
      kept.delete(planId);
    }
  }

  function giveBack(entry: KeptFilesPlan): void {
    const siteId = entry.site.id;
    if (deps.now() > entry.view.expiresAt) return;
    if ((generations.get(siteId) ?? 0) !== entry.generation) return;
    kept.set(entry.view.planId, entry);
    trim(siteId);
  }

  function take(siteId: string, planId: string): KeptFilesPlan {
    const entry = kept.get(planId);
    if (!entry || entry.site.id !== siteId) throw expired();
    kept.delete(planId);
    if (deps.now() > entry.view.expiresAt) throw expired();
    return entry;
  }

  return { plan, take, giveBack, forget };
}
