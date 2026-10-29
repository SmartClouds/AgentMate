import { cloudflareErrorMessage } from '@shared/cloudflareErrors';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, Plus } from '@/components/icons';
import { FOOTER_HAIRLINE, GLASS_CARD, GLASS_PANEL } from '@/components/pageKit';
import { SshVaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCloudflareErrors } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CloudflareMark } from './CloudflareMark';
import { Notice, Problem } from './fields';
import { TokenSetupCard } from './TokenSetupCard';
import { TokenStatusCard } from './TokenStatusCard';
import { ZonePanel, zoneTab } from './ZonePanel';
import { PICKER_ATTRIBUTE, ZonePicker } from './ZonePicker';
import { type ZoneGroup, ZoneRail } from './ZoneRail';

/** The page's first card, drawn like a server's header, with the domain picker on the right. */
function CloudflareHeader({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'flex shrink-0 flex-wrap items-center gap-3 px-4 py-3')}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 shadow-[0_0_28px_-12px_hsl(var(--primary)/0.7)]">
        <CloudflareMark className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-semibold leading-tight tracking-tight text-foreground">
          Cloudflare
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your domains on Cloudflare: DNS, SSL/TLS, caching and security rules.
        </p>
      </div>
      {children}
    </div>
  );
}

/**
 * The cards the page will show, shimmering in their own places while the status loads, so
 * nothing jumps when the real thing arrives.
 */
function CloudflareSkeleton(): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-busy="true">
      <CloudflareHeader>
        <Skeleton className="h-9 w-72 max-w-full rounded-full" />
      </CloudflareHeader>
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
  );
}

/**
 * The Cloudflare page in Deploy: the tokens, then the zones they can see, and for the picked
 * zone its DNS records, settings and security rules. Nothing is asked for before that. The zone
 * and tab are kept in the address, so coming back lands in the same place.
 *
 * Cloudflare accounts are not tied to one server, so the page opens from its own row in the
 * server rail. It does not scroll on its own: Deploy's content column scrolls it, the way it
 * scrolls a server. Connecting an account is drawn here too, never in a dialog on top.
 */
export function CloudflareView(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  // The account whose token is being replaced, or `true` while another account is being added.
  const [setup, setSetup] = useState<string | true | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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

  // Ctrl+F (Cmd+F on a Mac) finds a domain: it opens the list, or with the list open selects
  // what is in its search. A dialog opened on top keeps its own keys.
  useEffect(() => {
    if (!ready) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'f' || !(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const dialog = target?.closest('[role="dialog"], [role="alertdialog"]');
      if (dialog && !dialog.hasAttribute(PICKER_ATTRIBUTE)) return;
      event.preventDefault();
      setPickerOpen(true);
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ready]);

  if (statusQuery.isPending) return <CloudflareSkeleton />;

  if (statusQuery.isError) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <CloudflareHeader />
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
  const tab = zoneTab(params.get('tab'));
  // The token card shown above the zone: the one asked for, else the selected zone's account.
  const requestedAccount = params.get('account');
  const managed =
    current.accounts.find((account) => account.id === requestedAccount) ??
    current.accounts.find((account) => account.id === selected?.accountId) ??
    current.accounts[0];
  const several = current.accounts.length > 1;

  // The address also holds the rest of Deploy's state, so a change here sets only the
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
    <div className={cn(GLASS_CARD, 'p-4')}>
      <TokenSetupCard
        // A fresh form when the steps switch between adding an account and replacing a token.
        key={typeof setup === 'string' ? setup : 'another'}
        account={replacing}
        additional={current.configured && !replacing}
        onCancel={current.configured ? () => setSetup(null) : undefined}
        onSaved={() => setSetup(null)}
      />
    </div>
  );

  // Before there is a token to use (none saved, or the passkey is locked) there are no domains to
  // pick from, so the header has no picker.
  if (!ready) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <CloudflareHeader />
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
    <div className="flex min-w-0 flex-col gap-2">
      <CloudflareHeader>
        {selected && (
          <ZonePicker
            groups={groups}
            selected={selected}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            searchRef={searchRef}
            onSelect={(zone) => {
              setSetup(null);
              setPickerOpen(false);
              updateAddress((query) => {
                query.set('zone', zone.id);
                query.set('tab', tab);
                query.delete('account');
              });
            }}
            onManageAccount={(accountId) => {
              setSetup(null);
              setPickerOpen(false);
              updateAddress((query) => {
                query.set('zone', selected.id);
                query.set('tab', tab);
                query.set('account', accountId);
              });
            }}
            onAddAccount={() => {
              setPickerOpen(false);
              setSetup(true);
            }}
          />
        )}
      </CloudflareHeader>
      {connecting ? (
        steps
      ) : (
        <>
          {managed && (
            <TokenStatusCard
              key={managed.id}
              account={managed}
              showName={several}
              // Picking an account's name in the list asks for its token, so show the details.
              defaultOpen={requestedAccount !== null}
              onReplace={() => setSetup(managed.id)}
            />
          )}
          {selected ? (
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
          ) : (
            // No zone to open yet: the list itself says whether it is loading, failed or empty.
            <div className={cn(GLASS_PANEL, 'flex max-h-[32rem] flex-col')}>
              <ZoneRail
                groups={groups}
                searchRef={searchRef}
                selectedId={null}
                onSelect={() => undefined}
                onManageAccount={(accountId) =>
                  updateAddress((query) => {
                    query.set('account', accountId);
                  })
                }
              />
              <div className={cn(FOOTER_HAIRLINE, 'shrink-0 p-2')}>
                <Button variant="soft" size="sm" className="w-full" onClick={() => setSetup(true)}>
                  <Plus className="h-3.5 w-3.5" /> Add account
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
