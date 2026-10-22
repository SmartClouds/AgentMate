import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/** The Backups section's reads (E28). Each card shimmers on its own while its read is pending. */

const RUNS = 25;

export function useBackupSecret(serverId: string) {
  return useQuery({
    queryKey: queryKeys.deployBackupSecret(serverId),
    queryFn: () => window.agentmat.deployServerBackups.getSecret(serverId),
    retry: false,
  });
}

export function useBackupDestinations(serverId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deployBackupDestinations(serverId),
    queryFn: async () =>
      (await window.agentmat.deployServerBackups.listDestinations(serverId)) ?? [],
    retry: false,
    enabled,
  });
}

export function useBackupPlans(serverId: string) {
  return useQuery({
    queryKey: queryKeys.deployBackupPlans(serverId),
    queryFn: async () => (await window.agentmat.deployServerBackups.listPlans(serverId)) ?? [],
    retry: false,
  });
}

export function useBackupRuns(serverId: string) {
  return useQuery({
    queryKey: queryKeys.deployBackupRuns(serverId),
    queryFn: async () => (await window.agentmat.deployServerBackups.listRuns(serverId, RUNS)) ?? [],
    retry: false,
  });
}

export function useStoredBackups(serverId: string, destinationId: string | null) {
  return useQuery({
    queryKey: queryKeys.deployStoredBackups(serverId, destinationId ?? ''),
    queryFn: async () =>
      (await window.agentmat.deployServerBackups.listStored({
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
    queryFn: async () =>
      (await window.agentmat.deployServerBackups.pendingRestore(serverId)) ?? null,
    enabled,
    retry: false,
  });
}

export function useDeployServers() {
  return useQuery({
    queryKey: queryKeys.deployServers,
    queryFn: () => window.agentmat.deploy.listServers(),
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
