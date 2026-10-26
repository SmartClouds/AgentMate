import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/** The Backups section's reads (E28). Each card shimmers on its own while its read is pending. */

const RUNS = 25;
/** How often a run that is still going is read again, so its destinations move on screen. */
const RUNNING_POLL_MS = 2_000;

export function useBackupSecret(serverId: string) {
  return useQuery({
    queryKey: queryKeys.deployBackupSecret(serverId),
    queryFn: () => window.runova.deployServerBackups.getSecret(serverId),
    retry: false,
  });
}

export function useBackupDestinations(serverId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deployBackupDestinations(serverId),
    queryFn: async () => (await window.runova.deployServerBackups.listDestinations(serverId)) ?? [],
    retry: false,
    enabled,
  });
}

export function useBackupPlans(serverId: string) {
  return useQuery({
    queryKey: queryKeys.deployBackupPlans(serverId),
    queryFn: async () => (await window.runova.deployServerBackups.listPlans(serverId)) ?? [],
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((plan) => plan.lastRun?.state === 'running') ? RUNNING_POLL_MS : false,
  });
}

export function useBackupRuns(serverId: string) {
  return useQuery({
    queryKey: queryKeys.deployBackupRuns(serverId),
    queryFn: async () => (await window.runova.deployServerBackups.listRuns(serverId, RUNS)) ?? [],
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.state === 'running') ? RUNNING_POLL_MS : false,
  });
}

export function useStoredBackups(serverId: string, destinationId: string | null) {
  return useQuery({
    queryKey: queryKeys.deployStoredBackups(serverId, destinationId ?? ''),
    queryFn: async () =>
      (await window.runova.deployServerBackups.listStored({
        serverId,
        id: destinationId ?? '',
      })) ?? [],
    enabled: destinationId !== null,
    retry: false,
  });
}

export function usePendingRestore(serverId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deployPendingRestore(serverId),
    queryFn: async () => (await window.runova.deployServerBackups.pendingRestore(serverId)) ?? null,
    enabled,
    retry: false,
  });
}

export function useDeployServers() {
  return useQuery({
    queryKey: queryKeys.deployServers,
    queryFn: () => window.runova.deploy.listServers(),
    retry: false,
  });
}

/** Reads the whole section again, after a change. */
export function useRefreshBackups(serverId: string): () => void {
  const queryClient = useQueryClient();
  return useCallback(
    () => void queryClient.invalidateQueries({ queryKey: queryKeys.deployServerBackups(serverId) }),
    [queryClient, serverId],
  );
}
