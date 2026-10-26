import { useQuery } from '@tanstack/react-query';
import { type DailySplit, mergeProjectDaily } from '@/lib/projectWeekday';
import { queryKeys } from '@/lib/queryKeys';

export interface ProjectDailyResult {
  /** No usage has arrived yet, so the card shows its loading state. */
  isPending: boolean;
  /** The usage could not be read, and no earlier reading is on screen. */
  isError: boolean;
  /** Null when no source reports a split: nothing is tracked yet, or the split could not be built. */
  split: DailySplit | null;
  isFetching: boolean;
  retry: () => void;
}

/**
 * The per-project split from the same usage list the page reads, so the chart and the cards cannot
 * disagree and no second scan is started. The page owns the polling; this only reads the cache.
 */
export function useProjectDaily(): ProjectDailyResult {
  const query = useQuery({
    queryKey: queryKeys.usageList,
    queryFn: () => window.runova.usage.list(),
    select: mergeProjectDaily,
  });
  return {
    isPending: query.isPending,
    isError: query.isError && query.data === undefined,
    split: query.data ?? null,
    isFetching: query.isFetching,
    retry: () => {
      void query.refetch();
    },
  };
}
