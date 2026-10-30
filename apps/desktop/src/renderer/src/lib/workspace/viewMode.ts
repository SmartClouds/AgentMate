import type { AgentTabMode } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';

/** The view agent tabs open in until the user switches one, from Settings. CLI until it loads. */
export function useDefaultAgentTabMode(): AgentTabMode {
  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    meta: { silentLoading: true },
  });
  return settings.data?.defaultAgentTabMode ?? 'cli';
}
