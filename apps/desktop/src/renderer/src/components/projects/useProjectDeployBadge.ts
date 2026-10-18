import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { QUIET, readChanges, useFileSites } from '@/components/deploy/files/hooks';
import type { SectionBadge } from '@/components/projects/ProjectDetailChrome';
import { queryKeys } from '@/lib/queryKeys';

/** A count read on the project page is fresh enough for half a minute; watches keep it live. */
const BADGE_STALE_MS = 30_000;

/**
 * The Deploy tab's badge on a project page (E23): the changes waiting across the FTP and SFTP
 * sites attached to the project. It asks for attention when one of them needs review or its last
 * deploy failed, with a count of those sites when nothing is pending, so the badge still shows.
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
  const pending = changes.reduce(
    (sum, query) => sum + (query.data?.state === 'ready' ? query.data.files.length : 0),
    0,
  );
  const troubled = attached.filter(
    (site) => site.needsReview !== null || site.lastDeploy?.state === 'failed',
  ).length;
  return useMemo(() => {
    if (pending === 0 && troubled === 0) return undefined;
    return { count: pending > 0 ? pending : troubled, attention: troubled > 0 };
  }, [pending, troubled]);
}
