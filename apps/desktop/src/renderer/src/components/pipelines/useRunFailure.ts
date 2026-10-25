import type { GithubActionsRunErrorInput } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The failure text of one run (failed jobs, annotations, the tail of the logs). Read once per run
 * and kept, so Fix with AI and the run details share one answer instead of asking GitHub twice.
 */
export function useRunFailure(run: GithubActionsRunErrorInput, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.runFailure(run.repo, run.runId),
    queryFn: async () => {
      const result = await window.agentmat.pipelines.runError(run);
      if (!result.ok) throw new Error(result.error);
      return result.text;
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: { silentLoading: true },
  });
}
