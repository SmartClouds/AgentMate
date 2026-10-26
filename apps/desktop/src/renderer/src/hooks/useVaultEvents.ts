import type { VaultStatus } from '@shared/apiTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { settleClipboardToast } from '@/lib/vault/clipboardToast';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Keeps the renderer in step with the vault in main. Mounted once by the shell, so locking from
 * anywhere (idle, the OS, another page) drops the decrypted list even when the Vault page is
 * not open.
 */
export function useVaultEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const vault = window.runova?.vault;
    if (!vault) return;

    const offState = vault.onStateChanged((event) => {
      queryClient.setQueryData<VaultStatus>(queryKeys.vaultStatus, (current) =>
        current ? { ...current, state: event.state } : current,
      );
      if (event.state === 'unlocked') {
        useVaultStore.getState().setLastLockReason(null);
        void queryClient.invalidateQueries({ queryKey: queryKeys.vaultStatus });
        return;
      }
      queryClient.removeQueries({ queryKey: queryKeys.vaultData });
      const store = useVaultStore.getState();
      store.resetView();
      store.setLastLockReason(event.reason ?? null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vaultStatus });
    });
    const offEntries = vault.onEntriesChanged(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vaultEntries });
    });
    const offClipboard = vault.onClipboardSettled((event) => settleClipboardToast(event.cleared));

    return () => {
      offState();
      offEntries();
      offClipboard();
    };
  }, [queryClient]);
}
