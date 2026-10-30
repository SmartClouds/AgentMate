import { sortCategories, type VaultCategory } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/** The vault's categories in the user's order. Empty while they load. */
export function useVaultCategories(): { categories: VaultCategory[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: queryKeys.vaultCategories,
    queryFn: () => window.runova.vault.listCategories(),
    meta: { silentLoading: true },
  });
  const categories = useMemo(() => sortCategories(query.data ?? []), [query.data]);
  return { categories, isLoading: query.isLoading };
}
