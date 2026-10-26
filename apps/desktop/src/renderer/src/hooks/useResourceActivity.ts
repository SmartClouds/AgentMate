import type { ResourceActivitySnapshot } from '@runova/core';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The main process only takes a new reading every half minute, so asking more often than this
 * would just return the same numbers. The answer is read from memory, so it costs nothing.
 */
export const RESOURCE_ACTIVITY_REFRESH_MS = 10_000;

/**
 * The Docker and emulator usage history plus what has gone idle. Both Dashboard cards read it,
 * and React Query shares one request between them. It does not poll while the window is hidden.
 */
export function useResourceActivity(): UseQueryResult<ResourceActivitySnapshot> {
  return useQuery({
    queryKey: queryKeys.resourceActivity,
    queryFn: () => window.runova.resourceActivity.snapshot(),
    refetchInterval: RESOURCE_ACTIVITY_REFRESH_MS,
    // Keeps the Dashboard from counting this toward the one-time loading overlay.
    meta: { silentLoading: true },
  });
}
