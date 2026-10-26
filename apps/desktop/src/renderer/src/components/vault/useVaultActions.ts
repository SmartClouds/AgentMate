import type { VaultEntrySummary, VaultFieldRef } from '@runova/core';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { showCopiedToast } from '@/lib/vault/clipboardToast';
import { confirmDialog } from '@/stores/confirmStore';
import { useVaultStore } from '@/stores/vaultStore';

/** The entry actions shared by the list rows, the detail pane and the keyboard shortcuts. */
export function useVaultActions() {
  const queryClient = useQueryClient();

  const patchCache = useCallback(
    (id: string, change: Partial<VaultEntrySummary>) =>
      queryClient.setQueryData<VaultEntrySummary[]>(queryKeys.vaultEntries, (list) =>
        list?.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)),
      ),
    [queryClient],
  );

  return useMemo(
    () => ({
      async copy(id: string, ref: VaultFieldRef, label: string): Promise<void> {
        try {
          const { clearsAt } = await window.runova.vault.copy(id, ref);
          patchCache(id, { lastUsedAt: Date.now() });
          showCopiedToast(label, clearsAt);
        } catch (error) {
          toast.error(`Could not copy the ${label.toLowerCase()}`, {
            description: vaultErrorMessage(error),
          });
        }
      },

      async setFavorite(id: string, favorite: boolean): Promise<void> {
        patchCache(id, { favorite });
        try {
          await window.runova.vault.patch(id, { favorite });
        } catch (error) {
          patchCache(id, { favorite: !favorite });
          toast.error('Could not update favorites', { description: vaultErrorMessage(error) });
        }
      },

      async duplicate(id: string): Promise<void> {
        try {
          const copy = await window.runova.vault.duplicate(id);
          await queryClient.invalidateQueries({ queryKey: queryKeys.vaultEntries });
          useVaultStore.getState().select(copy.id);
          toast.success('Entry duplicated');
        } catch (error) {
          toast.error('Could not duplicate the entry', { description: vaultErrorMessage(error) });
        }
      },

      async remove(entry: VaultEntrySummary): Promise<void> {
        const ok = await confirmDialog({
          title: `Delete "${entry.title}"?`,
          description: 'It is removed from the vault for good. This cannot be undone.',
          confirmLabel: 'Delete',
          variant: 'destructive',
        });
        if (!ok) return;
        try {
          await window.runova.vault.remove([entry.id]);
          queryClient.setQueryData<VaultEntrySummary[]>(queryKeys.vaultEntries, (list) =>
            list?.filter((item) => item.id !== entry.id),
          );
          if (useVaultStore.getState().selectedId === entry.id)
            useVaultStore.getState().select(null);
          toast.success('Entry deleted');
        } catch (error) {
          toast.error('Could not delete the entry', { description: vaultErrorMessage(error) });
        }
      },

      async lock(): Promise<void> {
        try {
          await window.runova.vault.lock();
        } catch (error) {
          toast.error('Could not lock the vault', { description: vaultErrorMessage(error) });
        }
      },
    }),
    [patchCache, queryClient],
  );
}
