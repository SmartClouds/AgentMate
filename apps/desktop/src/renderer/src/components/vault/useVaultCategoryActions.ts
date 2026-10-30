import type { VaultCategory, VaultEntrySummary } from '@runova/core';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { Trash2 } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { useVaultStore } from '@/stores/vaultStore';

function entriesText(count: number): string {
  return `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

/** Deleting, reordering and filing into categories, with the cache kept in step and a toast. */
export function useVaultCategoryActions() {
  const queryClient = useQueryClient();

  return useMemo(() => {
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vaultEntries });
      void queryClient.invalidateQueries({ queryKey: queryKeys.vaultCategories });
    };
    const categoryName = (id: string | null): string =>
      (id &&
        queryClient
          .getQueryData<VaultCategory[]>(queryKeys.vaultCategories)
          ?.find((c) => c.id === id)?.name) ||
      'Uncategorized';

    return {
      async remove(category: VaultCategory, count: number): Promise<void> {
        const ok = await confirmDialog({
          title: `Delete "${category.name}"?`,
          description:
            count === 0
              ? 'The category is empty, so nothing else changes.'
              : `Its ${entriesText(count)} stay in the vault and move to Uncategorized.`,
          icon: Trash2,
          confirmLabel: 'Delete category',
          variant: 'destructive',
        });
        if (!ok) return;
        try {
          await window.runova.vault.deleteCategory(category.id);
          queryClient.setQueryData<VaultCategory[]>(queryKeys.vaultCategories, (list) =>
            list?.filter((c) => c.id !== category.id),
          );
          if (useVaultStore.getState().categoryFilter === category.id) {
            useVaultStore.getState().setCategoryFilter('all');
          }
          toast.success(`Deleted "${category.name}"`);
        } catch (error) {
          toast.error('Could not delete the category', { description: vaultErrorMessage(error) });
        } finally {
          refresh();
        }
      },

      async reorder(ids: string[]): Promise<void> {
        // Shown in the new order at once; put back by the refetch if main refuses.
        queryClient.setQueryData<VaultCategory[]>(queryKeys.vaultCategories, (list) =>
          list?.map((c) => ({
            ...c,
            order: ids.indexOf(c.id) === -1 ? ids.length : ids.indexOf(c.id),
          })),
        );
        try {
          await window.runova.vault.reorderCategories(ids);
        } catch (error) {
          toast.error('Could not reorder the categories', {
            description: vaultErrorMessage(error),
          });
          refresh();
        }
      },

      async move(ids: string[], categoryId: string | null): Promise<void> {
        const entries = queryClient.getQueryData<VaultEntrySummary[]>(queryKeys.vaultEntries) ?? [];
        const titles = entries.filter((e) => ids.includes(e.id)).map((e) => e.title);
        try {
          const moved = await window.runova.vault.moveEntries(ids, categoryId);
          if (moved === 0) return;
          queryClient.setQueryData<VaultEntrySummary[]>(queryKeys.vaultEntries, (list) =>
            list?.map((e) => (ids.includes(e.id) ? { ...e, categoryId } : e)),
          );
          toast.success(`Moved to ${categoryName(categoryId)}`, {
            description: titles.length === 1 ? titles[0] : entriesText(moved),
          });
        } catch (error) {
          toast.error('Could not move the entry', { description: vaultErrorMessage(error) });
        } finally {
          refresh();
        }
      },
    };
  }, [queryClient]);
}
