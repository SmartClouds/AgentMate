import { coreErrorMessage } from '@shared/coreErrors';
import type {
  FirewallChangeSetInfo,
  OriginLockState,
  OriginLockStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Clock, Lock, LockOpen, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { relative } from '@/lib/deploy/sites/certificates';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CloudflareMark } from '../CloudflareMark';
import { CardBody, CloudflareCard, Notice } from '../fields';
import { OriginLockDialog } from './OriginLockDialog';

/**
 * The Cloudflare-only origin lock in a server's Firewall section (E14 T6): whether ports 80 and
 * 443 answer Cloudflare alone, how the firewall compares with Cloudflare's published ranges for
 * IPv4 and IPv6, and when the core last fetched them. Its changes are firewall change sets like
 * any other, so the countdown banner above keeps or reverts them.
 */

const STATE: Record<OriginLockState, { text: string; icon: typeof Lock; tone: string }> = {
  off: {
    text: 'Off: every address reaches ports 80 and 443',
    icon: LockOpen,
    tone: 'text-muted-foreground',
  },
  pending: {
    text: 'Waiting for you to keep the firewall change',
    icon: Clock,
    tone: 'text-warning',
  },
  on: { text: 'On: only Cloudflare reaches ports 80 and 443', icon: Lock, tone: 'text-success' },
  drifted: {
    text: 'On, but the firewall no longer matches',
    icon: TriangleAlert,
    tone: 'text-destructive',
  },
};

const SHOWN = 4;

function Differences({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <ul className="font-mono text-xs leading-5 text-foreground">
        {items.slice(0, SHOWN).map((item) => (
          <li key={item}>{item}</li>
        ))}
        {items.length > SHOWN && (
          <li className="text-muted-foreground">and {items.length - SHOWN} more</li>
        )}
      </ul>
    </div>
  );
}

export function OriginLockCard({
  serverId,
  serverName,
  signedIn,
  canAdmin,
  busy,
  onApplied,
}: {
  serverId: string;
  serverName: string;
  signedIn: boolean;
  canAdmin: boolean;
  /** Another firewall change waits, or the link is reconnecting. */
  busy: boolean;
  onApplied: (change: FirewallChangeSetInfo) => void;
}): React.JSX.Element {
  const lock = useQuery({
    queryKey: queryKeys.cloudflareOriginLock(serverId),
    queryFn: () => window.runova.cloudflareServer.originLock(serverId),
    enabled: signedIn,
    retry: false,
    refetchInterval: (query) =>
      (query.state.data as OriginLockStatus | undefined)?.state === 'pending' ? 3_000 : 60_000,
  });
  const [dialog, setDialog] = useState<'on' | 'off' | null>(null);
  const status = lock.data;
  const state = status ? STATE[status.state] : null;
  const now = Date.now();

  return (
    <CloudflareCard
      icon={<CloudflareMark />}
      title="Cloudflare-only origin"
      description="Stops visitors from going around Cloudflare to the server's own address."
    >
      <CardBody className="space-y-3">
        {lock.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : !status || !state ? (
          <p className="text-sm text-muted-foreground">
            {lock.error ? coreErrorMessage(lock.error) : 'The origin lock could not be read.'}
          </p>
        ) : (
          <>
            <p className={cn('flex items-center gap-2 text-sm font-medium', state.tone)}>
              <state.icon className="h-4 w-4" /> {state.text}
            </p>
            {status.enabled && (
              <p className="text-xs text-muted-foreground">
                Authenticated Origin Pulls {status.authenticatedOriginPulls ? 'on' : 'off'}.
              </p>
            )}
            {status.ranges && (
              <p className="text-xs text-muted-foreground">
                {status.ranges.ipv4.length} IPv4 and {status.ranges.ipv6.length} IPv6 ranges from
                Cloudflare, fetched {relative(status.ranges.fetchedAtUnixMs, now)}.
              </p>
            )}
            {status.lastRefreshError && (
              <p className="flex items-start gap-2 text-xs text-warning">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {status.lastRefreshError}
              </p>
            )}
            {status.state === 'drifted' && (
              <Notice tone="destructive">
                <div className="space-y-2">
                  <Differences label="Not allowed yet" items={status.missingRules} />
                  <Differences label="Still open to everyone" items={status.openRules} />
                  <Differences label="No longer Cloudflare's" items={status.staleRules} />
                </div>
              </Notice>
            )}
            {status.warnings.map((warning) => (
              <p key={warning} className="text-xs text-warning">
                {warning}
              </p>
            ))}
            {canAdmin && (
              <div className="flex flex-wrap gap-1.5">
                {status.state !== 'on' && (
                  <Button
                    size="sm"
                    disabled={busy || status.state === 'pending'}
                    onClick={() => setDialog('on')}
                  >
                    <Lock className="h-3.5 w-3.5" />
                    {status.enabled ? 'Bring up to date' : 'Lock to Cloudflare'}
                  </Button>
                )}
                {status.enabled && (
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={busy || status.state === 'pending'}
                    onClick={() => setDialog('off')}
                  >
                    <LockOpen className="h-3.5 w-3.5" /> Turn off
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardBody>
      <OriginLockDialog
        open={dialog !== null}
        serverId={serverId}
        serverName={serverName}
        enabling={dialog === 'on'}
        initialPulls={status?.authenticatedOriginPulls ?? false}
        onOpenChange={(open) => !open && setDialog(null)}
        onApplied={(change) => {
          setDialog(null);
          void lock.refetch();
          if (change) onApplied(change);
        }}
      />
    </CloudflareCard>
  );
}
