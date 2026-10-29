import type { GithubRunJob, GithubStepLog } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';

/**
 * One job's log, split by step. GitHub only hands a log out once the job has finished, and after
 * that it never changes, so it is read once (when the job is opened) and kept.
 */
export function useJobLog(repo: string, job: GithubRunJob, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.jobLog(repo, job.id),
    queryFn: async (): Promise<GithubStepLog[]> => {
      const result = await window.runova.pipelines.jobLog({
        repo,
        jobId: job.id,
        steps: job.steps.map(({ number, conclusion, startedAt, completedAt }) => ({
          number,
          conclusion,
          startedAt,
          completedAt,
        })),
      });
      if (!result?.ok) throw new Error(result?.error ?? 'The log could not be read.');
      return result.steps;
    },
    enabled: enabled && job.status === 'completed',
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: { silentLoading: true },
  });
}
