import type { GithubRunJob, GithubWorkflowRunInfo } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { isLiveRun } from './runStatus';

/** How often a run that is still going is read again, so its steps move along on screen. */
export const LIVE_REFETCH_MS = 10_000;

/**
 * The jobs and steps of one run. Only the run that is being looked at is read (`enabled`), a live
 * run is polled, and a finished one is read once and kept.
 *
 * The key includes whether the run is live, so a run that finishes is read once more instead of
 * staying frozen on its last half-done state, and the old jobs stay up while that read lands.
 */
export function useRunDetails(
  repo: string,
  run: Pick<GithubWorkflowRunInfo, 'id' | 'status' | 'runAttempt'> | null,
  enabled: boolean,
) {
  const live = run ? isLiveRun(run) : false;
  return useQuery({
    queryKey: queryKeys.runDetails(repo, run?.id ?? 0, run?.runAttempt ?? 1, live),
    queryFn: async (): Promise<GithubRunJob[]> => {
      const result = await window.agentmat.pipelines.runDetails({
        repo,
        runId: run?.id ?? 0,
      });
      if (!result.ok) throw new Error(result.error);
      return result.jobs;
    },
    enabled: enabled && run !== null,
    refetchInterval: live ? LIVE_REFETCH_MS : false,
    staleTime: live ? 0 : Number.POSITIVE_INFINITY,
    retry: false,
    // Carry the jobs over only for the same run, never another run's while this one loads.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === repo && previousQuery.queryKey[2] === run?.id
        ? previous
        : undefined,
    meta: { silentLoading: true },
  });
}
