import type { SymbolIndex } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { type SymbolView, splitSymbolIndex } from '@/lib/workspaceSearch/symbols';

/** While the dialog is open it asks this often whether the index moved on. */
const POLL_MS = 4000;

/**
 * The project's declarations, for `t:` and `m:`. The main process answers "unchanged" when the
 * version the window holds is still current, so polling while the dialog is open costs a
 * round trip and nothing more.
 */
export function useSymbolIndex(projectId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const key = queryKeys.workspaceSymbols(projectId);
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: async (): Promise<SymbolIndex> => {
      const held = queryClient.getQueryData<SymbolIndex>(key);
      const payload = await window.runova.workspaceSearch.symbols(projectId, held?.version);
      if ('unchanged' in payload) {
        if (held) return held;
        // The cache was dropped between asking and answering; ask for the whole thing.
        const full = await window.runova.workspaceSearch.symbols(projectId);
        if ('unchanged' in full) throw new Error('The symbol index could not be read.');
        return full;
      }
      return payload;
    },
    meta: { silentLoading: true },
    refetchInterval: enabled ? POLL_MS : false,
    // A big project's index is a few large arrays; comparing them field by field on every
    // answer would cost more than it saves.
    structuralSharing: false,
  });

  const views = useMemo<{ types: SymbolView; members: SymbolView } | null>(
    () => (query.data ? splitSymbolIndex(query.data) : null),
    [query.data],
  );

  return {
    index: query.data ?? null,
    views,
    isPending: enabled && query.isPending,
    isError: query.isError,
  };
}
