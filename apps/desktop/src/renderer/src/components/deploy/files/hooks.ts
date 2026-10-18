import type {
  FileSite,
  FilesChangesSnapshot,
  FilesHistoryEntry,
  FilesRunResult,
} from '@shared/deployFilesTypes';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { runCountsText } from './copy';
import { filesProblemText } from './messages';

/**
 * Reads for FTP and SFTP sites in Deploy (E23). Everything sits under `['deploy', 'files']`, so
 * unlocking the Servers vault refreshes it with the rest of Deploy. The list of sites and each
 * site's pending changes are kept fresh by events from main, not by asking again.
 */

/** Background reads that should never raise the app's loading overlay. */
export const QUIET = { silentLoading: true } as const;

export function useFileSites() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.agentmat.deployFiles.onSitesChanged((event) => {
        queryClient.setQueryData<FileSite[]>(queryKeys.deployFilesSites, event.sites);
      }),
    [queryClient],
  );
  return useQuery({
    queryKey: queryKeys.deployFilesSites,
    queryFn: async (): Promise<FileSite[]> => (await window.agentmat.deployFiles.list()) ?? [],
  });
}

/** Puts a saved site into the cached list right away, then has the list read again. */
export function useFileSiteListUpdate() {
  const queryClient = useQueryClient();
  return useCallback(
    (site: FileSite) => {
      queryClient.setQueryData<FileSite[]>(queryKeys.deployFilesSites, (sites) =>
        sites?.some((one) => one.id === site.id)
          ? sites.map((one) => (one.id === site.id ? site : one))
          : [...(sites ?? []), site],
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployFilesSites });
    },
    [queryClient],
  );
}

/** Writes a snapshot unless the cache already holds a newer one (events and calls can cross). */
export function writeSnapshot(queryClient: QueryClient, snapshot: FilesChangesSnapshot): void {
  queryClient.setQueryData<FilesChangesSnapshot | null>(
    queryKeys.deployFilesChanges(snapshot.siteId),
    (current) => (current && current.computedAt > snapshot.computedAt ? current : snapshot),
  );
}

/** Asks main for a snapshot, keeping the cached one when it is newer. */
export async function readChanges(
  queryClient: QueryClient,
  siteId: string,
): Promise<FilesChangesSnapshot | null> {
  const fresh = (await window.agentmat.deployFiles.changes(siteId)) ?? null;
  const current = queryClient.getQueryData<FilesChangesSnapshot | null>(
    queryKeys.deployFilesChanges(siteId),
  );
  if (current && (!fresh || current.computedAt > fresh.computedAt)) return current;
  return fresh;
}

/**
 * The live list of a site's pending changes. Mounting it asks main to watch the deploy folder,
 * and unmounting lets go of that again; null until main has a first snapshot.
 */
export function useFileSiteChanges(siteId: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    let live = true;
    const api = window.agentmat.deployFiles;
    const stop = api.onChanges((snapshot) => {
      if (snapshot.siteId === siteId) writeSnapshot(queryClient, snapshot);
    });
    Promise.resolve(api.subscribe(siteId))
      .then((snapshot) => {
        if (live && snapshot) writeSnapshot(queryClient, snapshot);
      })
      // The read below says why, if the site cannot be watched.
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
      Promise.resolve(api.unsubscribe(siteId)).catch(() => undefined);
    };
  }, [siteId, queryClient]);
  return useQuery({
    queryKey: queryKeys.deployFilesChanges(siteId),
    queryFn: () => readChanges(queryClient, siteId),
    // Events keep it fresh; asking again would only scan the folder twice.
    staleTime: Number.POSITIVE_INFINITY,
    meta: QUIET,
  });
}

/** The cached snapshot, for places that only show a count and must not start a watch. */
export function useCachedFileSiteChanges(siteId: string): FilesChangesSnapshot | null {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.deployFilesChanges(siteId),
    queryFn: () => readChanges(queryClient, siteId),
    enabled: false,
    meta: QUIET,
  });
  return query.data ?? null;
}

export function useFileSiteHistory(siteId: string) {
  return useQuery({
    queryKey: queryKeys.deployFilesHistory(siteId),
    queryFn: async (): Promise<FilesHistoryEntry[]> =>
      (await window.agentmat.deployFiles.history(siteId)) ?? [],
    meta: QUIET,
  });
}

/** Saved server nicknames by id, for the address of a site that logs in through one. */
export function useSavedServerNames(): Map<string, string> {
  const query = useQuery({
    queryKey: queryKeys.sshServers,
    queryFn: async () => (await window.agentmat.ssh.listServers()) ?? [],
    meta: QUIET,
  });
  return useMemo(
    () => new Map((query.data ?? []).map((server) => [server.id, server.nickname])),
    [query.data],
  );
}

/**
 * Takes a run's outcome into the store, once, whether it came from the event or the deploy call,
 * says how it went, and refreshes what the run changed.
 */
export function finishRun(queryClient: QueryClient, result: FilesRunResult): void {
  if (!useDeployFilesRunStore.getState().finish(result)) return;
  const sites = queryClient.getQueryData<FileSite[]>(queryKeys.deployFilesSites) ?? [];
  const label = sites.find((site) => site.id === result.siteId)?.label;
  const counts = runCountsText(result);
  if (result.state === 'done') {
    toast.success(label ? `Deployed ${label}: ${counts}.` : `Deployed: ${counts}.`);
  } else if (result.state === 'partial') {
    toast.warning(`Part of the site was deployed: ${counts}. The rest stays in the list.`);
  } else if (result.state === 'failed') {
    toast.error(
      result.error
        ? `The deploy failed. ${filesProblemText(result.error.code, result.error.message)}`
        : 'The deploy failed.',
    );
  } else {
    toast.info(
      result.uploaded + result.deleted > 0
        ? `Deploy cancelled after ${counts}. What was not sent stays in the list.`
        : 'Deploy cancelled. Nothing was sent.',
    );
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.deployFilesHistory(result.siteId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.deployFilesSites, exact: true });
  const changesKey = queryKeys.deployFilesChanges(result.siteId);
  const changes = queryClient.getQueryCache().find({ queryKey: changesKey, exact: true });
  if (changes && !changes.isActive()) {
    // Nobody watches the folder, so nothing would read it again and the rail would keep counting
    // what was just sent. Marked stale below, so the next watch or reader (the project badge)
    // asks afresh.
    queryClient.setQueryData<FilesChangesSnapshot | null>(changesKey, null);
  }
  void queryClient.invalidateQueries({ queryKey: changesKey });
}

/**
 * Listens for runs, needs-review changes and snapshots from main. The app shell mounts it once, so
 * a run that goes on (or finishes) while the user is on another page still reaches the run store,
 * its toast and the cached counts.
 */
export function useFilesRunEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const api = window.agentmat.deployFiles;
    const stops = [
      api.onProgress((event) => useDeployFilesRunStore.getState().progress(event)),
      api.onRunFinished((result) => finishRun(queryClient, result)),
      api.onChanges((snapshot) => writeSnapshot(queryClient, snapshot)),
      api.onNeedsReview((event) => {
        queryClient.setQueryData<FileSite[]>(queryKeys.deployFilesSites, (sites) =>
          sites?.map((site) =>
            site.id === event.siteId ? { ...site, needsReview: event.needsReview } : site,
          ),
        );
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [queryClient]);
}
