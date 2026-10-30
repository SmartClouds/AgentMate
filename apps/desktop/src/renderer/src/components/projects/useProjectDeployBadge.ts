import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { QUIET, readChanges, useFileSites } from '@/components/deploy/files/hooks';
import type { SectionBadge } from '@/components/projects/ProjectDetailChrome';
import { queryKeys } from '@/lib/queryKeys';

/** A count read on the project page is fresh enough for half a minute; watches keep it live. */
const BADGE_STALE_MS = 30_000;

/**
 * The Deploy tab's badge on a project page (E23): the changes waiting across the FTP and SFTP
 * sites attached to the project. It asks for attention when one of them needs review or its last
 * deploy failed, or when one of the project's Runova apps failed or runs degraded, with a count
 * of those when nothing is pending, so the badge still shows.
 */
export function useProjectDeployBadge(projectId: string | undefined): SectionBadge | undefined {
  const queryClient = useQueryClient();
  const sites = useFileSites();
  const attached = useMemo(
    () =>
      projectId ? (sites.data ?? []).filter((site) => site.projectIds.includes(projectId)) : [],
    [sites.data, projectId],
  );
  const changes = useQueries({
    queries: attached.map((site) => ({
      queryKey: queryKeys.deployFilesChanges(site.id),
      queryFn: () => readChanges(queryClient, site.id),
      staleTime: BADGE_STALE_MS,
      meta: QUIET,
    })),
  });
  // The apps only as the cache has them: the badge never reaches out to a server's core itself.
  const servers = useQuery({
    queryKey: queryKeys.deployServers,
    queryFn: () => window.runova.deploy.listServers(),
    meta: QUIET,
  });
  const appLists = useQueries({
    queries: (servers.data ?? []).map((server) => ({
      queryKey: queryKeys.deployAppsList(server.id),
      queryFn: async () => (await window.runova.deployStacks.list(server.id)) ?? [],
      enabled: false,
      meta: QUIET,
    })),
  });
  const troubledApps = appLists
    .flatMap((query) => query.data ?? [])
    .filter(
      (app) =>
        projectId !== undefined &&
        app.source?.projectId === projectId &&
        (app.status === 'failed' || app.status === 'degraded'),
    ).length;
  const pending = changes.reduce(
    (sum, query) => sum + (query.data?.state === 'ready' ? query.data.files.length : 0),
    0,
  );
  const troubled =
    attached.filter((site) => site.needsReview !== null || site.lastDeploy?.state === 'failed')
      .length + troubledApps;
  return useMemo(() => {
    if (pending === 0 && troubled === 0) return undefined;
    return { count: pending > 0 ? pending : troubled, attention: troubled > 0 };
  }, [pending, troubled]);
}
