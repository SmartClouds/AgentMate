import type {
  HealthCreateResult,
  HealthSecretReveal,
  HealthTargetDetail,
  HealthTargetInput,
  HealthTargetSummary,
} from '@shared/healthTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { useLastGoodData } from '@/hooks/useLastGoodData';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The Health page's reads and writes (E22). The main process pushes `onChanged` after every
 * probe and edit, so the lists and the open panel refresh on that instead of polling.
 *
 * A new key or password never goes near the query or mutation cache: `create` and `rotateSecret`
 * are plain calls, and their result is handed straight to the one-time reveal, which keeps it
 * in its own state and drops it on close.
 */

/** Health reads report progress on their own cards, so they never raise the page overlay. */
const QUIET = { silentLoading: true } as const;

/** Refreshes the health reads whenever the main process reports a change. */
export function useHealthChanges(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    return window.runova.health.onChanged((event) => {
      // `cancelRefetch: false` lets a second listener (the menu badge) join the same fetch.
      void queryClient.invalidateQueries(
        { queryKey: queryKeys.healthList() },
        { cancelRefetch: false },
      );
      for (const id of event?.targetIds ?? []) {
        void queryClient.invalidateQueries(
          { queryKey: queryKeys.healthTarget(id) },
          { cancelRefetch: false },
        );
      }
    });
  }, [queryClient]);
}

export function useHealthTargets(projectId?: string) {
  useHealthChanges();
  const query = useQuery({
    queryKey: queryKeys.healthList(projectId),
    queryFn: async (): Promise<HealthTargetSummary[]> =>
      (await window.runova.health.list(projectId ? { projectId } : undefined)) ?? [],
    meta: QUIET,
  });
  const lastGood = useLastGoodData({
    storageKey: `health-list:${projectId ?? 'all'}`,
    query,
    failureOf: () => null,
    title: 'Could not refresh health checks',
  });
  return {
    targets: lastGood.data,
    isLoading: query.isLoading && lastGood.data === undefined,
    isFetching: query.isFetching,
    error: lastGood.data === undefined && query.error ? query.error : null,
    failure: lastGood.failure,
    refresh: lastGood.refresh,
  };
}

export function useHealthTarget(targetId: string | null) {
  return useQuery({
    queryKey: queryKeys.healthTarget(targetId ?? ''),
    queryFn: async (): Promise<HealthTargetDetail | null> =>
      (await window.runova.health.get(targetId ?? '')) ?? null,
    enabled: targetId !== null,
    meta: QUIET,
  });
}

/** A clock for "checked 2 min ago" labels, so they move without a refetch. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function failed(title: string) {
  return (error: unknown): void => {
    toast.error(title, { description: ipcErrorMessage(error, 'Something went wrong.') });
  };
}

export function useHealthActions() {
  const queryClient = useQueryClient();

  const refreshAll = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.health }),
    [queryClient],
  );

  /** Not a mutation: the result carries the plaintext secret, which must not be cached. */
  const create = useCallback(
    async (input: HealthTargetInput): Promise<HealthCreateResult> => {
      const result = await window.runova.health.create(input);
      void refreshAll();
      return result;
    },
    [refreshAll],
  );

  /** Not a mutation, for the same reason as `create`. */
  const rotateSecret = useCallback(
    async (targetId: string): Promise<HealthSecretReveal> => {
      const result = await window.runova.health.rotateSecret(targetId);
      void refreshAll();
      return result;
    },
    [refreshAll],
  );

  const update = useMutation({
    mutationFn: ({ targetId, patch }: { targetId: string; patch: Partial<HealthTargetInput> }) =>
      window.runova.health.update(targetId, patch),
    meta: QUIET,
    onSuccess: () => {
      toast.success('Target saved');
      void refreshAll();
    },
    onError: failed('Could not save the target'),
  });

  const remove = useMutation({
    mutationFn: (targetId: string) => window.runova.health.remove(targetId),
    meta: QUIET,
    onSuccess: (_result, targetId) => {
      toast.success('Target removed');
      queryClient.removeQueries({ queryKey: queryKeys.healthTarget(targetId) });
      void refreshAll();
    },
    onError: failed('Could not remove the target'),
  });

  const setPaused = useMutation({
    mutationFn: ({ targetId, paused }: { targetId: string; paused: boolean }) =>
      window.runova.health.setPaused(targetId, paused),
    meta: QUIET,
    onSuccess: (_result, { paused }) => {
      toast.success(paused ? 'Checks paused' : 'Checks resumed');
      void refreshAll();
    },
    onError: failed('Could not change the schedule'),
  });

  const checkNow = useMutation({
    mutationFn: (targetId: string) => window.runova.health.checkNow(targetId),
    meta: QUIET,
    onSuccess: (result, targetId) => {
      if (result) queryClient.setQueryData(queryKeys.healthTarget(targetId), result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.healthList() });
    },
    onError: failed('Could not run the check'),
  });

  const diagnose = useMutation({
    mutationFn: (targetId: string) => window.runova.health.diagnoseNow(targetId),
    meta: QUIET,
    onSuccess: (_result, targetId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.healthTarget(targetId) });
    },
    onError: failed('Could not start the diagnosis'),
  });

  const cancelDiagnose = useMutation({
    mutationFn: (targetId: string) => window.runova.health.cancelDiagnose(targetId),
    meta: QUIET,
    onSuccess: (_result, targetId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.healthTarget(targetId) });
    },
    onError: failed('Could not stop the diagnosis'),
  });

  return {
    create,
    rotateSecret,
    update,
    remove,
    setPaused,
    checkNow,
    diagnose,
    cancelDiagnose,
  };
}
