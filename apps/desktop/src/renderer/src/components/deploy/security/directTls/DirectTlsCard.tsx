import { coreErrorMessage } from '@shared/coreErrors';
import { closePortChanges, openPortChanges } from '@shared/deploy/directTlsValidation';
import type {
  FirewallChange,
  FirewallStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployDirectTlsInfo } from '@shared/deployDirectTlsTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Power, Shield, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { Notice } from '../../deployKit';
import { useDeployConnection } from '../../overview/hooks';
import { useProofStepUp } from '../../overview/useProofStepUp';
import { ago } from '../format';
import { CARD_BODY, LoadFailure, SecurityCard } from '../SecurityCard';
import { DirectTlsDetails } from './DirectTlsDetails';
import { DirectTlsFirewall } from './DirectTlsFirewall';
import { DirectTlsForm } from './DirectTlsForm';

/**
 * Direct TLS (E16) for one server: the core's own HTTPS port, for when SSH is not an option.
 * Everyone sees how it stands and the pin; Owners turn it on (with a step-up), change it and turn
 * it off. Each change is followed by the firewall change set that opens or closes the port, with
 * the usual review and countdown. A pin that changed is shown as a warning and stays refused
 * until the Owner accepts the new one.
 */
export function DirectTlsCard({
  server,
  owner,
}: {
  server: DeployServer;
  owner: boolean;
}): React.JSX.Element {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const info = useQuery({
    queryKey: queryKeys.deployDirectTls(serverId),
    queryFn: () => window.runova.deployDirectTls.status(serverId),
    retry: false,
  });
  const connection = useDeployConnection(serverId);
  const stepUp = useProofStepUp(server);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'off' | 'pin' | null>(null);
  const [review, setReview] = useState<FirewallChange[] | null>(null);

  function settled(next: DeployDirectTlsInfo): void {
    queryClient.setQueryData(queryKeys.deployDirectTls(serverId), next);
  }

  /** The firewall change set for the new state, offered for review when there is one. */
  async function offerFirewall(
    changesFor: (firewall: FirewallStatus) => FirewallChange[],
  ): Promise<void> {
    try {
      const firewall = await window.runova.deployFirewall.status(serverId);
      const changes = changesFor(firewall);
      if (changes.length > 0) setReview(changes);
    } catch (error) {
      toast.error(`Could not read the firewall to update its rule: ${coreErrorMessage(error)}`);
    }
  }

  async function save(port: number, sources: string[]): Promise<void> {
    setBusy('save');
    try {
      const next = await stepUp.run(
        (proof) => window.runova.deployDirectTls.enable({ serverId, port, sources, ...proof }),
        'open the direct TLS port',
      );
      if (!next) return;
      const previous = info.data?.status;
      settled(next);
      setEditing(false);
      toast.success(`Direct TLS is on, port ${next.status.port}.`);
      await offerFirewall((firewall) => {
        const moved =
          previous?.enabled && previous.port !== next.status.port
            ? closePortChanges(firewall, previous.port, previous.sources)
            : [];
        return [...moved, ...openPortChanges(firewall, next.status.port, next.status.sources)];
      });
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function turnOff(): Promise<void> {
    const current = info.data?.status;
    if (!current) return;
    const confirmed = await confirmDialog({
      title: `Turn off direct TLS on ${server.nickname}?`,
      description: `Port ${current.port} closes, and every computer goes back to SSH. Computers that cannot use SSH lose access to the core.`,
      confirmLabel: 'Turn off',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setBusy('off');
    try {
      settled(await window.runova.deployDirectTls.disable(serverId));
      toast.success('Direct TLS is off.');
      await offerFirewall((firewall) => closePortChanges(firewall, current.port, current.sources));
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function acceptPin(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Trust the new server key?',
      description:
        'The core presents a different key than the one pinned on this computer. That is expected after the core was installed again without its data. If you did not expect it, keep the old pin and check the server: something may be intercepting the connection.',
      warning: 'The new pin was read over SSH, which checks the server by its host key.',
      confirmLabel: 'Trust the new key',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setBusy('pin');
    try {
      settled(await window.runova.deployDirectTls.acceptPin(serverId));
      toast.success('The new pin is in place.');
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  let body: React.ReactNode;
  if (info.isPending) {
    body = (
      <div className={`${CARD_BODY} space-y-3`} aria-busy="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex gap-3">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 flex-1" />
          </div>
        ))}
      </div>
    );
  } else if (info.isError) {
    body = (
      <LoadFailure message={coreErrorMessage(info.error)} onRetry={() => void info.refetch()} />
    );
  } else {
    const data = info.data;
    const { status } = data;
    body = (
      <div className={`${CARD_BODY} space-y-4`}>
        {data.pinChanged && (
          <Notice role="alert" tone="destructive" icon={TriangleAlert}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium text-foreground">The server key changed</p>
                <p className="text-muted-foreground">
                  The core presents a key that does not match the pin this computer took{' '}
                  {data.pinned ? ago(data.pinned.pinnedAt) : 'earlier'}. Direct TLS stays refused on
                  this computer, and nothing falls back to it quietly, until the new key is trusted.
                </p>
              </div>
              {owner && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => void acceptPin()}
                >
                  Trust the new key
                </Button>
              )}
            </div>
          </Notice>
        )}
        <DirectTlsDetails info={data} connection={connection} />
        {!owner ? (
          <p className="text-xs text-muted-foreground">Only an Owner can change direct TLS.</p>
        ) : editing || !status.enabled ? (
          <DirectTlsForm
            initialPort={status.port || status.defaultPort}
            initialSources={status.sources}
            busy={busy === 'save'}
            submitLabel={status.enabled ? 'Save' : 'Turn on direct TLS'}
            onSubmit={(port, sources) => void save(port, sources)}
            {...(status.enabled ? { onCancel: () => setEditing(false) } : {})}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="soft"
              disabled={busy !== null}
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3.5 w-3.5" /> Change port or sources
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null}
              onClick={() => void turnOff()}
            >
              <Power className="h-3.5 w-3.5" /> Turn off
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <SecurityCard
      icon={<Shield />}
      title="Direct TLS"
      description="Reach the core on its own HTTPS port when SSH is not available. Each computer proves itself with a client certificate for its device key, and checks the core's key against a pin read over SSH. When the port does not answer, the app uses SSH as before."
    >
      {/* The firewall half renders nothing until a change waits, so it gets no padding of its own. */}
      <div className="px-4 empty:hidden [&:has(>*)]:pb-3.5">
        <DirectTlsFirewall
          server={server}
          changes={review}
          stepUp={stepUp}
          canAdmin={owner}
          onClose={() => setReview(null)}
        />
      </div>
      {body}
      {stepUp.dialog}
    </SecurityCard>
  );
}
