import { FIREWALL_POLICIES } from '@shared/deploy/firewallValidation';
import type {
  FirewallPolicy,
  FirewallStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Lock, LockOpen, TriangleAlert } from '@/components/icons';
import { FOOTER_HAIRLINE, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { BACKEND_LABEL, POLICY_LABEL } from '@/lib/deploy/firewall/format';
import { cn } from '@/lib/utils';
import { SECURITY_CARD } from '../security/SecurityCard';

/**
 * The firewall at a glance: on or off (a word and a lock, never colour alone), which backend,
 * the default policies, IPv6, and the SSH ports the guard keeps open. Admins turn it on or off
 * and change the incoming default from here; both go through the preview like any change.
 */

// The heading already says "default", so the values stay one word and the dropdown never clips.
const INCOMING_OPTIONS = FIREWALL_POLICIES.map((policy) => ({
  value: policy,
  label: POLICY_LABEL[policy],
}));

/** A label over its value. Values wrap rather than cut off, so a narrow window loses no words. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={SECTION_HEADING}>{label}</dt>
      <dd className="mt-1.5 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

export function StatusHero({
  status,
  loading,
  error,
  stale,
  canAdmin,
  busy,
  stagedIncoming,
  onToggle,
  onDefaultIncoming,
}: {
  status: FirewallStatus | undefined;
  loading: boolean;
  error: string | null;
  stale: boolean;
  canAdmin: boolean;
  /** A change is being staged or waits for its confirmation. */
  busy: boolean;
  /** An incoming default staged but not applied yet. */
  stagedIncoming?: FirewallPolicy;
  onToggle: (on: boolean) => void;
  onDefaultIncoming: (policy: FirewallPolicy) => void;
}): React.JSX.Element {
  if (loading && !status) {
    return (
      <div className={SECURITY_CARD} aria-busy="true">
        <div className="flex flex-wrap items-center gap-6 p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-2xl" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-44" />
            </div>
          </div>
          <Skeleton className="h-10 min-w-48 flex-1" />
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div className={cn(SECURITY_CARD, 'p-4 text-sm text-destructive')} role="alert">
        {error ?? 'The firewall could not be read.'}
      </div>
    );
  }

  const none = status.backend === 'none' || !status.installed;
  const on = status.active && !none;
  const Mark = on ? Lock : LockOpen;
  return (
    <div className={cn(SECURITY_CARD, 'transition-opacity', stale && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 p-4">
        <div className="flex items-center gap-3" aria-label="Firewall state">
          <span
            className={cn(
              'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl',
              on
                ? 'bg-success/12 text-success shadow-[0_0_32px_-12px_hsl(var(--success)/0.8)]'
                : 'bg-warning/12 text-warning shadow-[0_0_32px_-12px_hsl(var(--warning)/0.8)]',
            )}
          >
            <Mark className="h-5 w-5" />
          </span>
          <div className="space-y-0.5">
            <p className="text-base font-semibold leading-tight tracking-tight text-foreground">
              {none ? 'No firewall found' : on ? 'Firewall on' : 'Firewall off'}
            </p>
            <p className="text-xs text-muted-foreground">
              {none
                ? 'Neither ufw nor firewalld is installed.'
                : on
                  ? 'Only what the rules allow gets in.'
                  : 'Every port that listens can be reached.'}
            </p>
          </div>
        </div>

        <dl className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-6 gap-y-3">
          <Fact label="Backend">
            {BACKEND_LABEL[status.backend]}
            {status.zone ? ` (zone ${status.zone})` : ''}
          </Fact>
          <Fact label="Incoming default">
            {canAdmin && !none && !busy ? (
              <div className="-mt-0.5 flex flex-wrap items-center gap-2">
                <Combobox
                  ariaLabel="Incoming by default"
                  className="h-8 w-fit min-w-28 max-w-full pl-3.5 pr-2.5 font-medium"
                  searchable={false}
                  options={INCOMING_OPTIONS}
                  value={stagedIncoming ?? status.defaultIncoming}
                  onChange={(policy) => onDefaultIncoming(policy as FirewallPolicy)}
                />
                {stagedIncoming && (
                  <span className="text-xs font-normal text-muted-foreground">Not applied yet</span>
                )}
              </div>
            ) : (
              POLICY_LABEL[status.defaultIncoming]
            )}
          </Fact>
          <Fact label="Outgoing default">{POLICY_LABEL[status.defaultOutgoing]}</Fact>
          <Fact label="IPv6">{status.ipv6 ? 'Filtered too' : 'Not filtered'}</Fact>
          <Fact label="SSH ports">
            {status.ssh.ports.length > 0 ? (
              <span className="font-mono tabular-nums">{status.ssh.ports.join(', ')}</span>
            ) : (
              (status.ssh.error ?? 'Unknown')
            )}
          </Fact>
        </dl>

        {canAdmin &&
          !none &&
          // Turning it off opens every port, so that reads as a destructive action.
          (on ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => onToggle(false)}>
              Turn off
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => onToggle(true)}>
              Turn on
            </Button>
          ))}
      </div>
      {(status.warnings.length > 0 || status.error) && (
        <ul className={cn(FOOTER_HAIRLINE, 'space-y-1 px-4 py-3 text-xs text-warning')}>
          {[...(status.error ? [status.error] : []), ...status.warnings].map((warning) => (
            <li key={warning} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {warning}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
