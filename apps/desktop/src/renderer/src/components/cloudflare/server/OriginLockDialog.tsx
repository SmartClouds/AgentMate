import type { CloudflareDomainCheck, CloudflareOriginLockPlan } from '@shared/cloudflareTypes';
import type { FirewallChangeSetInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, CircleInfo, Spinner, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { GuidedFix } from './GuidedFix';

/**
 * The last look before the origin lock changes the firewall: the exact commands, what the core
 * noticed, and how each of the server's site domains stands in Cloudflare. A domain that is not
 * proxied stops answering once the lock is on, so it is called out. Applying starts the usual
 * firewall countdown; the change is kept from the banner above, over a new SSH connection.
 */

function DomainRow({ check, enabling }: { check: CloudflareDomainCheck; enabling: boolean }) {
  const outside = check.zoneId === null;
  const direct = check.proxied === false;
  const warn = enabling && (outside || direct || check.proxied === null);
  const text = outside
    ? 'Not in this Cloudflare account'
    : check.proxied === null
      ? `No address record in ${check.zoneName}`
      : direct
        ? 'DNS only: visitors would no longer reach it'
        : 'Proxied through Cloudflare';
  const Icon = warn ? TriangleAlert : CircleCheck;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
      <span className="font-mono text-xs text-foreground">{check.domain}</span>
      <span className={`flex items-center gap-1 text-xs ${warn ? 'text-warning' : 'text-success'}`}>
        <Icon className="h-3 w-3" /> {text}
      </span>
    </li>
  );
}

export function OriginLockDialog({
  open,
  serverId,
  serverName,
  enabling,
  initialPulls,
  onOpenChange,
  onApplied,
}: {
  open: boolean;
  serverId: string;
  serverName: string;
  /** Turning the lock on (or bringing it up to date) rather than off. */
  enabling: boolean;
  initialPulls: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied: (change: FirewallChangeSetInfo | undefined) => void;
}): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const [pulls, setPulls] = useState(initialPulls);
  const [plan, setPlan] = useState<CloudflareOriginLockPlan | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPulls(initialPulls);
    setApplyError(null);
  }, [open, initialPulls]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setPlan(null);
    setLoadError(null);
    window.runova.cloudflareServer
      .previewOriginLock({
        serverId,
        enabled: enabling,
        authenticatedOriginPulls: enabling && pulls,
      })
      .then((result) => current && setPlan(result))
      .catch((error: unknown) => current && setLoadError(error));
    return () => {
      current = false;
    };
  }, [open, serverId, enabling, pulls]);

  async function apply(): Promise<void> {
    setBusy(true);
    setApplyError(null);
    try {
      const result = await window.runova.cloudflareServer.applyOriginLock({
        serverId,
        enabled: enabling,
        authenticatedOriginPulls: enabling && pulls,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cloudflareOriginLock(serverId) });
      if (!result.nginx.applied) {
        toast.warning(
          `The firewall changed, but nginx did not take it: ${result.nginx.error ?? 'see the Websites section'}.`,
        );
      } else if (!result.changeSet) {
        toast.success('nginx is up to date. The firewall already matched.');
      }
      onApplied(result.changeSet);
    } catch (error) {
      setApplyError(error);
    } finally {
      setBusy(false);
    }
  }

  const commands = plan?.preview.firewall?.commands ?? [];
  const exposed = plan?.domains.filter((check) => check.proxied !== true) ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <div className="flex max-h-[calc(85vh-3rem)] min-h-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {enabling
                ? `Lock ${serverName} to Cloudflare`
                : `Open ${serverName} to everyone again`}
            </DialogTitle>
            <DialogDescription>
              {enabling
                ? "Ports 80 and 443 will only answer Cloudflare's published addresses, and nginx will log each visitor's own address. The core keeps the list up to date by itself every day."
                : 'Ports 80 and 443 will answer every address again. nginx stops trusting Cloudflare for the visitor address.'}
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
            {enabling && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`${id}-pulls`}
                  checked={pulls}
                  onCheckedChange={(checked) => setPulls(checked === true)}
                />
                <Label htmlFor={`${id}-pulls`} className="text-sm font-normal leading-snug">
                  Also require Cloudflare's client certificate on HTTPS (Authenticated Origin
                  Pulls). It is turned on for the zones of this server's sites first.
                </Label>
              </div>
            )}
            {loadError ? (
              <GuidedFix error={loadError} />
            ) : !plan ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : (
              <>
                {plan.domains.length > 0 && (
                  <section aria-label="Site domains" className="space-y-1">
                    <h4 className="text-xs font-medium text-muted-foreground">
                      Site domains on this server
                    </h4>
                    <ul className="settings-rows rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.08]">
                      {plan.domains.map((check) => (
                        <DomainRow key={check.domain} check={check} enabling={enabling} />
                      ))}
                    </ul>
                    {enabling && exposed.length > 0 && (
                      <p className="flex items-start gap-2 text-xs text-warning">
                        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                        Turn the proxy on for these names first, or they stop answering.
                      </p>
                    )}
                  </section>
                )}
                <section aria-label="Firewall commands" className="space-y-1">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {commands.length === 0
                      ? 'The firewall already matches'
                      : `${commands.length} firewall commands`}
                  </h4>
                  {commands.length > 0 && (
                    <pre className="max-h-40 overflow-auto rounded-xl bg-foreground/[0.03] p-2.5 font-mono text-xs ring-1 ring-inset ring-foreground/[0.08]">
                      {commands.join('\n')}
                    </pre>
                  )}
                </section>
                {plan.preview.notes.map((note) => (
                  <p key={note} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <CircleInfo className="mt-0.5 h-3 w-3 shrink-0" /> {note}
                  </p>
                ))}
                {plan.preview.firewall?.guard.blocked && (
                  <p role="alert" className="text-sm text-destructive">
                    {plan.preview.firewall.guard.reasons.join(' ')}
                  </p>
                )}
              </>
            )}
            {applyError ? <GuidedFix error={applyError} /> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="soft"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={enabling ? 'default' : 'destructive'}
              disabled={busy || !plan || plan.preview.firewall?.guard.blocked === true}
              onClick={() => void apply()}
            >
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              {enabling ? 'Lock to Cloudflare' : 'Open to everyone'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
