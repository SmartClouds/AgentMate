import { vaultErrorMessage } from '@shared/vaultErrors';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { VaultLockedScreen } from '@/components/vault/VaultLockedScreen';
import { VaultSetupScreen } from '@/components/vault/VaultSetupScreen';
import { VaultUnlockedView } from '@/components/vault/VaultUnlockedView';
import { queryKeys } from '@/lib/queryKeys';
import { usePageHeader } from '@/stores/pageHeaderStore';

/** The status is not known yet, so this is the shape every vault screen opens with: one card. */
function VaultPageSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div
        role="status"
        aria-label="Opening the vault"
        className="glass w-full max-w-md space-y-4 rounded-[calc(var(--radius)+2px)] p-8"
      >
        <Skeleton className="mx-auto h-14 w-14 rounded-2xl" />
        <Skeleton className="mx-auto h-5 w-40" />
        <Skeleton className="h-10 w-full rounded-full" />
        <Skeleton className="h-10 w-full rounded-full" />
      </div>
    </div>
  );
}

export default function VaultPage(): React.JSX.Element {
  usePageHeader('Vault', 'Passwords, API keys and private notes, encrypted on this computer.');
  const statusQuery = useQuery({
    queryKey: queryKeys.vaultStatus,
    queryFn: () => window.runova.vault.status(),
    meta: { silentLoading: true },
  });

  if (statusQuery.isLoading) return <VaultPageSkeleton />;

  if (statusQuery.isError || !statusQuery.data) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="glass flex w-full max-w-md flex-col items-center gap-4 rounded-[calc(var(--radius)+2px)] px-8 py-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/12 text-destructive shadow-[0_0_40px_-12px_hsl(var(--destructive)/0.7)]">
            <TriangleAlert className="h-6 w-6" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold tracking-tight">
              The vault could not be opened
            </h2>
            <p className="text-sm text-muted-foreground">{vaultErrorMessage(statusQuery.error)}</p>
          </div>
          <Button onClick={() => void statusQuery.refetch()}>
            <RefreshCw /> Try again
          </Button>
        </div>
      </div>
    );
  }

  switch (statusQuery.data.state) {
    case 'uninitialized':
      return <VaultSetupScreen />;
    case 'locked':
      return <VaultLockedScreen status={statusQuery.data} />;
    case 'unlocked':
      return <VaultUnlockedView />;
  }
}
