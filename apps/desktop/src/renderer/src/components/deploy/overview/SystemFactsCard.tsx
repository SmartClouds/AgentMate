import type { SystemInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { CircleCheck, Power, Server, TriangleAlert } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUptime } from '@/lib/deploy/setup';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DeployCard, FactRow, FactRows, Notice } from '../deployKit';

/** What the server is: its hardware, addresses, kernel and clock, and whether it wants a reboot. */

function DiskBar({ used, total }: { used: number; total: number }) {
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  return (
    <span
      className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]"
      aria-hidden
    >
      <span
        className={cn(
          'block h-full rounded-full',
          percent >= 90 ? 'bg-destructive' : percent >= 80 ? 'bg-warning' : 'bg-primary',
        )}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

export function SystemFactsCard({
  info,
  loading,
  error,
  stale,
  now,
  onReboot,
  rebooting,
}: {
  info: SystemInfo | undefined;
  loading: boolean;
  error: string | null;
  stale: boolean;
  now: number;
  /** Shown to Operators and above. */
  onReboot?: () => void;
  rebooting: boolean;
}): React.JSX.Element {
  return (
    <DeployCard
      icon={<Server />}
      title="System"
      description={info ? `${info.hostname}, ${info.os.name}` : 'What the server runs on.'}
      actions={
        onReboot && (
          <Button size="sm" variant="soft" disabled={rebooting || !info} onClick={onReboot}>
            <Power /> Reboot
          </Button>
        )
      }
    >
      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-6 w-full" />
          ))}
        </div>
      ) : !info ? (
        <p role="alert" className="text-sm text-muted-foreground">
          The server's facts did not load{error ? `: ${error}` : '.'}
        </p>
      ) : (
        <div className={cn('space-y-2 transition-opacity', stale && 'opacity-50')}>
          {(info.rebootRequired || info.rebootRequiredBy.length > 0) && (
            <Notice tone="warning" icon={TriangleAlert}>
              A reboot is waiting
              {info.rebootRequiredBy.length > 0 ? ` for ${info.rebootRequiredBy.join(', ')}` : ''}.
            </Notice>
          )}
          <FactRows>
            <FactRow label="Processor" labelWidth="8rem">
              {info.cpu.model}
              <span className="block text-xs text-muted-foreground">
                {info.cpu.logicalCores} cores ({info.cpu.physicalCores} physical
                {info.cpu.sockets > 1 ? `, ${info.cpu.sockets} sockets` : ''}), {info.architecture}
              </span>
            </FactRow>
            <FactRow label="Memory" labelWidth="8rem">
              {formatBytes(info.memoryTotalBytes)}
              <span className="text-muted-foreground">
                {info.swapTotalBytes > 0
                  ? `, swap ${formatBytes(info.swapTotalBytes)}`
                  : ', no swap'}
              </span>
            </FactRow>
            <FactRow label="Disks" labelWidth="8rem">
              <ul className="space-y-2">
                {info.disks.map((disk) => (
                  <li key={disk.mountPoint}>
                    <span className="font-mono text-xs">{disk.mountPoint}</span>{' '}
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(disk.usedBytes)} used of {formatBytes(disk.totalBytes)},{' '}
                      {formatBytes(disk.availableBytes)} free ({disk.fileSystem})
                    </span>
                    <DiskBar used={disk.usedBytes} total={disk.totalBytes} />
                  </li>
                ))}
              </ul>
            </FactRow>
            <FactRow label="Network" labelWidth="8rem">
              <ul className="space-y-1">
                {info.networks.map((nic) => (
                  <li key={nic.name} className="text-xs">
                    <span className="font-mono">{nic.name}</span>{' '}
                    <span className="text-muted-foreground">
                      {nic.up ? 'up' : 'down'}
                      {nic.speedMbps ? `, ${nic.speedMbps} Mb/s` : ''}
                    </span>
                    {nic.addresses.length > 0 && (
                      <span className="block break-all font-mono text-muted-foreground">
                        {nic.addresses.join(', ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </FactRow>
            <FactRow label="Public address" labelWidth="8rem">
              <span className="break-all font-mono text-xs">
                {info.publicAddresses.length > 0 ? info.publicAddresses.join(', ') : 'None found'}
              </span>
            </FactRow>
            <FactRow label="Kernel" labelWidth="8rem">
              <span className="font-mono text-xs">{info.kernel}</span>
            </FactRow>
            <FactRow label="Up for" labelWidth="8rem">
              {formatUptime(info.bootedAtUnixMs, now)}
            </FactRow>
            <FactRow label="Clock" labelWidth="8rem">
              {info.timeSync.synchronized === false ? (
                <Chip tone="warning">
                  <TriangleAlert /> Not in sync
                </Chip>
              ) : info.timeSync.synchronized ? (
                <span className="inline-flex items-center gap-1.5">
                  <CircleCheck className="h-3.5 w-3.5 text-success" /> In sync
                </span>
              ) : (
                'Unknown'
              )}
              <span className="text-xs text-muted-foreground">
                {info.timeSync.timeZone ? `, ${info.timeSync.timeZone}` : ''}
                {info.timeSync.service ? ` (${info.timeSync.service})` : ''}
              </span>
            </FactRow>
          </FactRows>
        </div>
      )}
    </DeployCard>
  );
}
