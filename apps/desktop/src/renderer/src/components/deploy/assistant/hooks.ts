import { coreErrorCode } from '@shared/coreErrors';
import type { AssistantModeInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { useDeployAssistantStore } from '@/stores/deployAssistantStore';

/**
 * The Deploy AI's live state in the renderer (E09 T8): the main process's progress and output
 * events go into the store once, for every server, on every page (the app shell listens, so a run
 * that goes on while the user is elsewhere is where it is when they come back); the drawer reads
 * the session's mode from the core (Admins only, so others see the drawer explain that).
 */

export function useDeployAssistantEvents(): void {
  useEffect(() => {
    const { progress, output } = useDeployAssistantStore.getState();
    const offProgress = window.runova.deployAssistant.onProgress((event) => progress(event));
    const offOutput = window.runova.deployAssistant.onOutput((event) => output(event));
    return () => {
      offProgress();
      offOutput();
    };
  }, []);
}

export interface AssistantModeQuery {
  info: AssistantModeInfo | undefined;
  loading: boolean;
  /** True when the signed-in role cannot use the AI at all. */
  forbidden: boolean;
  error: unknown;
}

export function useAssistantMode(serverId: string, enabled: boolean): AssistantModeQuery {
  const query = useQuery({
    queryKey: queryKeys.deployAssistantMode(serverId),
    queryFn: () => window.runova.deployAssistant.getMode(serverId),
    enabled,
    retry: false,
    meta: { silentLoading: true },
  });
  return {
    info: query.data ?? undefined,
    loading: query.isLoading,
    forbidden: coreErrorCode(query.error) === 'forbidden',
    error: query.error,
  };
}
