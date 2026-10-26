import { cloudflareErrorMessage } from '@shared/cloudflareErrors';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, Plus } from '@/components/icons';
import { FOOTER_HAIRLINE, GLASS_CARD, GLASS_PANEL } from '@/components/pageKit';
import { SshVaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { Skeleton } from '@/components/ui/skeleton';
import { useCloudflareErrors } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { PANEL_WIDTHS, usePanelWidth } from '@/stores/panelWidthStore';
import { CloudflareMark } from './CloudflareMark';
import { Notice, Problem } from './fields';
import { TokenSetupCard } from './TokenSetupCard';
import { TokenStatusCard } from './TokenStatusCard';
import { isZoneTab, ZonePanel, type ZoneTab } from './ZonePanel';
import { type ZoneGroup, ZoneRail } from './ZoneRail';

/**
 * The rail and the cards the dialog will show, shimmering in their own places while the status
 * loads, so nothing jumps when the real thing arrives.
 */
function CloudflareSkeleton(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 gap-2 p-2" aria-busy="true">
      <div className={cn(GLASS_PANEL, 'w-64 shrink-0 space-y-1.5 p-3')}>
        <Skeleton className="mb-3 h-3 w-16" />
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full rounded-lg" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className={cn(GLASS_CARD, 'flex items-center gap-3 px-4 py-3')}>
          <Skeleton className="h-9 w-9 rounded-xl" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <div className={cn(GLASS_CARD, 'space-y-3 p-4')}>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}

/**
 * What the dialog shows once it is open: the tokens, then the zones they can see, and for the
 * picked zone its DNS records, settings and security rules. Nothing is asked for before that. The
 * zone and tab are kept in the address, so opening the dialog again lands in the same place.
 *
 * Connecting an account is drawn here too, never in a second dialog on top: beside the domain
 * list when there is one, and on its own when there is not.
 */
function CloudflareContent(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  // The account whose token is being replaced, or `true` while another account is being added.
  const [setup, setSetup] = useState<string | true | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [railWidth, setRailWidth] = usePanelWidth('cloudflareRail');

  const statusQuery = useQuery({
    queryKey: queryKeys.cloudflareStatus,
    queryFn: () => window.runova.cloudflare.status(),
  });
  const status = statusQuery.data;
  const ready = Boolean(status?.configured && !status.locked);
  const zoneQueries = useQueries({
    queries: (status?.accounts ?? []).map((account) => ({
      queryKey: queryKeys.cloudflareAccountZones(account.id),
      queryFn: () => window.runova.cloudflare.listZones(account.id),
      enabled: ready,
    })),
  });
  const zoneErrors = useCloudflareErrors(zoneQueries.map((query) => query.error));

  if (statusQuery.isPending) return <CloudflareSkeleton />;

  if (statusQuery.isError) {
    return (
      <div className="p-2">
        <Problem
          message={cloudflareErrorMessage(statusQuery.error)}
          onRetry={() => void statusQuery.refetch()}
        />
      </div>
    );
  }

  const current = statusQuery.data;
  const groups: ZoneGroup[] = current.accounts.map((account, index) => ({
    accountId: account.id,
    label: account.label,
    zones: zoneQueries[index]?.data,
    error: zoneErrors[index] ?? null,
    onRetry: () => void zoneQueries[index]?.refetch(),
  }));
  const allZones = groups.flatMap((group) => group.zones ?? []);
  const selected = allZones.find((zone) => zone.id === params.get('zone')) ?? allZones[0];
  const requestedTab = params.get('tab');
  const tab: ZoneTab = isZoneTab(requestedTab) ? requestedTab : 'dns';
  // The token card shown above the zone: the one asked for, else the selected zone's account.
  const requestedAccount = params.get('account');
  const managed =
    current.accounts.find((account) => account.id === requestedAccount) ??
    current.accounts.find((account) => account.id === selected?.accountId) ??
    current.accounts[0];
  const several = current.accounts.length > 1;

  // The address also holds the Deploy server and the open dialog, so a change here sets only the
  // Cloudflare keys and leaves the rest alone.
  function updateAddress(change: (query: URLSearchParams) => void): void {
    setParams(
      (previous) => {
        const query = new URLSearchParams(previous);
        change(query);
        return query;
      },
      { replace: true },
    );
  }

  const unlockDialog = (
    <SshVaultUnlockDialog
      open={unlockOpen}
      onOpenChange={setUnlockOpen}
      mode="unlock"
      onUnlocked={() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sshVaultStatus });
        void queryClient.invalidateQueries({ queryKey: ['cloudflare'] });
      }}
    />
  );

  const replacing =
    typeof setup === 'string'
      ? current.accounts.find((account) => account.id === setup)
      : undefined;
  const connecting = current.configured && setup !== null;
  const steps = (
    <TokenSetupCard
      // A fresh form when the steps switch between adding an account and replacing a token.
      key={typeof setup === 'string' ? setup : 'another'}
      account={replacing}
      additional={current.configured && !replacing}
      onCancel={current.configured ? () => setSetup(null) : undefined}
      onSaved={() => setSetup(null)}
    />
  );

  // Before there is a token to use (none saved, or the passkey is locked) there are no domains to
  // list, so the dialog is one column instead of an empty rail.
  if (!ready) {
    return (
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
        {current.locked && (
          <Notice
            tone="warning"
            icon={Lock}
            className="items-center"
            action={
              <Button size="sm" onClick={() => setUnlockOpen(true)}>
                Unlock
              </Button>
            }
          >
            Your saved servers are locked with a passkey, and the Cloudflare tokens with them.
            Unlock them to manage your domains.
          </Notice>
        )}
        {!current.configured || connecting ? (
          steps
        ) : (
          <div className="flex flex-col gap-2">
            {current.accounts.map((account) => (
              <TokenStatusCard
                key={account.id}
                account={account}
                showName={several}
                onReplace={() => setSetup(account.id)}
              />
            ))}
            <Button variant="soft" className="self-start" onClick={() => setSetup(true)}>
              <Plus className="h-3.5 w-3.5" /> Add another account
            </Button>
          </div>
        )}
        {unlockDialog}
      </div>
    );
  }

  return (
    // The domain list and the zone side by side, the way the API Client lays out its collections
    // and request. The gap between them is the resize handle.
    <div className="flex min-h-0 flex-1 overflow-hidden p-2">
      <aside
        aria-label="Cloudflare domains"
        // The cap keeps a wide saved width from squeezing the zone on a narrow dialog.
        style={{ width: railWidth, maxWidth: '40%' }}
        className={cn(GLASS_PANEL, 'shrink-0')}
      >
        <ZoneRail
          groups={groups}
          selectedId={selected?.id ?? null}
          onSelect={(zone) => {
            setSetup(null);
            updateAddress((query) => {
              query.set('zone', zone.id);
              query.set('tab', tab);
              query.delete('account');
            });
          }}
          onManageAccount={(accountId) => {
            setSetup(null);
            updateAddress((query) => {
              if (selected) query.set('zone', selected.id);
              query.set('tab', tab);
              query.set('account', accountId);
            });
          }}
        />
        <div className={cn(FOOTER_HAIRLINE, 'flex shrink-0 flex-col gap-1.5 p-2')}>
          <Button variant="soft" size="sm" className="w-full" onClick={() => setSetup(true)}>
            <Plus className="h-3.5 w-3.5" /> Add account
          </Button>
        </div>
      </aside>
      <ResizeHandle
        orientation="vertical"
        label="Resize domains"
        size={railWidth}
        min={PANEL_WIDTHS.cloudflareRail.min}
        max={PANEL_WIDTHS.cloudflareRail.max}
        defaultSize={PANEL_WIDTHS.cloudflareRail.default}
        onSizeChange={setRailWidth}
        quiet
        className="w-2"
      />
      <div className="rail-scroll flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
        {connecting ? (
          <div className="px-3 py-2">{steps}</div>
        ) : (
          <>
            {managed && (
              <TokenStatusCard
                key={managed.id}
                account={managed}
                showName={several}
                // Picking an account's name in the rail asks for its token, so show the details.
                defaultOpen={requestedAccount !== null}
                onReplace={() => setSetup(managed.id)}
              />
            )}
            {selected && (
              <ZonePanel
                key={selected.id}
                zone={selected}
                tab={tab}
                onTabChange={(next) =>
                  updateAddress((query) => {
                    query.set('zone', selected.id);
                    query.set('tab', next);
                  })
                }
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The Cloudflare dialog, opened over the Deploy page the way Connect a WordPress site is. Cloudflare
 * accounts are not tied to one server, so it opens from the server rail rather than from a server.
 */
export function CloudflareDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Two rows (title, then the content), so no empty third row leaves a gap at the bottom. */}
      <DialogContent className="h-[min(85vh,48rem)] w-[calc(100vw-2rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudflareMark className="h-5 w-5" /> Cloudflare
          </DialogTitle>
          <DialogDescription>
            Your domains on Cloudflare: DNS, settings and security rules.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col">
          <CloudflareContent />
        </div>
      </DialogContent>
    </Dialog>
  );
}
