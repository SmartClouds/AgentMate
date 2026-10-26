import type { DeployRegistryPlanInput } from '@shared/deployRegistryTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/** What the registry screens read (E08): this computer's sign-ins, a server's, and an app's plan. */

export function useLocalRegistries() {
  return useQuery({
    queryKey: queryKeys.deployRegistryLocal,
    queryFn: async () => (await window.runova.deployRegistry.list()) ?? [],
    retry: false,
  });
}

export function useServerRegistries(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.deployRegistryServer(serverId),
    queryFn: async () => (await window.runova.deployRegistry.serverList(serverId)) ?? [],
    enabled,
    retry: false,
  });
}

export function useRegistryPlan(input: DeployRegistryPlanInput, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deployRegistryPlan(input),
    queryFn: () => window.runova.deployRegistry.plan(input),
    enabled,
    retry: false,
  });
}

/** After any change, every registry read is asked again: a plan depends on all of them. */
export function useRefreshRegistries(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.deployRegistries }),
    [queryClient],
  );
}
