import { coreErrorMessage } from '@shared/coreErrors';
import type { DeviceInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Monitor } from '@/components/icons';
import { Chip, EmptyState } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { ago } from './format';
import { CARD_BODY, CARD_ROWS, LoadFailure, RowsSkeleton, SecurityCard } from './SecurityCard';

/**
 * The computers enrolled on a core, this one marked. Every role sees its own; Admins and Owners
 * see everyone's (the core decides which). Revoking one ends its sessions at once, and it has to
 * enroll again before it can sign in.
 */
export function DevicesCard({
  server,
  everyone,
}: {
  server: DeployServer;
  /** The signed-in role sees every user's devices, so each row says whose it is. */
  everyone: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const devices = useQuery({
    queryKey: queryKeys.deployDevices(server.id),
    queryFn: () => window.runova.deploySecurity.listDevices(server.id),
    retry: false,
  });

  async function revoke(device: DeviceInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: device.current ? 'Revoke this computer?' : `Revoke ${device.name}?`,
      description: device.current
        ? 'This computer is signed out of the core and has to enroll again (over SSH, or with an enrollment code) before it can manage the server.'
        : `${device.name} is signed out and cannot sign in again until it enrolls again.`,
      confirmLabel: 'Revoke',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.deploySecurity.revokeDevice(server.id, device.id);
      toast.success(device.current ? 'This computer is revoked.' : `${device.name} is revoked.`);
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deploySecurity(server.id) });
      if (device.current) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.deployAccess(server.id) });
      }
    }
  }

  let body: React.ReactNode;
  if (devices.isPending) {
    body = <RowsSkeleton rows={2} />;
  } else if (devices.isError) {
    body = (
      <LoadFailure
        message={coreErrorMessage(devices.error)}
        onRetry={() => void devices.refetch()}
      />
    );
  } else if (devices.data.length === 0) {
    body = (
      <div className={CARD_BODY}>
        <EmptyState size="sm" icon={Monitor} title="No computers are enrolled on this core." />
      </div>
    );
  } else {
    // This computer first, revoked ones last; otherwise as the core listed them (oldest first).
    const ordered = [...devices.data].sort(
      (a, b) => Number(b.current) - Number(a.current) || Number(a.revoked) - Number(b.revoked),
    );
    body = (
      <ul aria-label="Devices" className={CARD_ROWS}>
        {ordered.map((device) => (
          <li
            key={device.id}
            aria-label={device.name}
            className={`flex flex-wrap items-center gap-3 px-4 py-3 ${device.revoked ? 'opacity-70' : ''}`}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{device.name}</span>
                {device.current && <Chip tone="primary">This computer</Chip>}
              </div>
              <p className="text-xs text-muted-foreground">
                {[
                  ...(everyone ? [device.userName] : []),
                  `Enrolled ${ago(device.createdAtUnixMs)}`,
                  device.lastSeenAtUnixMs === undefined
                    ? 'Never seen'
                    : `Seen ${ago(device.lastSeenAtUnixMs)}`,
                ].join(' · ')}
              </p>
            </div>
            {device.revoked ? (
              <Chip>
                <Ban />
                Revoked
              </Chip>
            ) : (
              <>
                <Chip tone="success" dot>
                  Active
                </Chip>
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={`Revoke ${device.name}`}
                  onClick={() => void revoke(device)}
                >
                  Revoke
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <SecurityCard
      icon={<Monitor />}
      title="Devices"
      description={
        <>
          {everyone
            ? 'Every computer enrolled on this core, whoever it belongs to.'
            : 'Your computers enrolled on this core.'}{' '}
          Each one signs in with a key of its own.
        </>
      }
    >
      {body}
    </SecurityCard>
  );
}
