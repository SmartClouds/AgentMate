import { coreErrorMessage } from '@shared/coreErrors';
import type { DockerDiskUsage } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Spinner, Trash2, Wrench } from '@/components/icons';
import { GLASS_CARD, Notice, TileHeader } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';

/**
 * The top of a server's Cleanup section: how much disk Docker takes and how much of it could go,
 * split by kind, and the build cache, which has no items to pick and is cleared as a whole.
 */

type UsageKey = keyof DockerDiskUsage;

const SHARES: ReadonlyArray<{ key: UsageKey; label: string; swatch: string }> = [
  { key: 'images', label: 'Images', swatch: 'bg-primary' },
  { key: 'containers', label: 'Containers', swatch: 'bg-sky-500' },
  { key: 'volumes', label: 'Volumes', swatch: 'bg-amber-500' },
  { key: 'buildCache', label: 'Build cache', swatch: 'bg-violet-500' },
];

export function CleanupSummary({
  usage,
  serverName,
  scanning,
  onScan,
}: {
  usage: DockerDiskUsage;
  serverName: string;
  scanning: boolean;
  onScan: () => void;
}): React.JSX.Element {
  const total = SHARES.reduce((sum, share) => sum + usage[share.key].sizeBytes, 0);
  const free = SHARES.reduce((sum, share) => sum + usage[share.key].reclaimableBytes, 0);
  return (
    <section aria-label="Disk use" className={cn(GLASS_CARD, 'flex flex-col gap-3 p-4')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-semibold tabular-nums tracking-tight">{formatBytes(free)}</p>
          <p className="text-sm text-muted-foreground">
            Docker uses {formatBytes(total)} on {serverName}. About {formatBytes(free)} of it could
            be freed.
          </p>
        </div>
        <Button size="sm" variant="ghost" disabled={scanning} onClick={onScan}>
          <RefreshCw className={cn('h-3.5 w-3.5', scanning && 'motion-safe:animate-spin')} />
          Scan again
        </Button>
      </div>
      {/* What could be freed, as a share of everything Docker holds. */}
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-foreground/[0.07]"
        aria-hidden="true"
      >
        {SHARES.map((share) => {
          const part = total > 0 ? (usage[share.key].reclaimableBytes / total) * 100 : 0;
          return part > 0 ? (
            <span
              key={share.key}
              className={cn('h-full transition-[width] duration-500', share.swatch)}
              style={{ width: `${part}%` }}
            />
          ) : null;
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {SHARES.map((share) => (
          <li key={share.key} className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', share.swatch)} aria-hidden="true" />
            {share.label}
            <span className="tabular-nums text-foreground">
              {formatBytes(usage[share.key].reclaimableBytes)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const OLDER_CORE = /older core/i;

export function BuildCacheCard({
  serverId,
  serverName,
  usage,
  canAdmin,
  onCleared,
  onUpdateCore,
}: {
  serverId: string;
  serverName: string;
  usage: DockerDiskUsage['buildCache'];
  canAdmin: boolean;
  onCleared: () => void;
  onUpdateCore?: (() => void) | undefined;
}): React.JSX.Element {
  const [clearing, setClearing] = useState(false);
  const [olderCore, setOlderCore] = useState<string | null>(null);

  async function clear(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Clear the build cache on ${serverName}?`,
      description:
        'Docker removes every cached build step. The next image build on this server starts from scratch, so it takes longer.',
      confirmLabel: 'Clear',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setClearing(true);
    try {
      const result = await window.runova.deployDocker.prune({ serverId, target: 'buildCache' });
      setOlderCore(null);
      toast.success(`Cleared the build cache and freed ${formatBytes(result.reclaimedBytes)}.`);
      onCleared();
    } catch (error) {
      const message = coreErrorMessage(error);
      if (OLDER_CORE.test(message)) setOlderCore(message);
      else toast.error(message);
    } finally {
      setClearing(false);
    }
  }

  return (
    <section aria-label="Build cache" className={cn(GLASS_CARD, 'flex flex-col gap-2 p-4')}>
      <TileHeader icon={<Wrench />} title="Build cache" />
      <span className="text-2xl font-semibold tabular-nums tracking-tight">
        {formatBytes(usage.sizeBytes)}
      </span>
      <p className="text-xs text-muted-foreground">
        {usage.count === 0
          ? 'Nothing cached. Image builds leave their steps here.'
          : `${usage.count} cached build step${usage.count === 1 ? '' : 's'}, left by image builds.`}
      </p>
      {olderCore && (
        <Notice
          tone="warning"
          size="sm"
          action={
            onUpdateCore && (
              <Button size="sm" onClick={onUpdateCore}>
                Update the core
              </Button>
            )
          }
        >
          {olderCore}
        </Notice>
      )}
      {canAdmin && (
        <Button
          size="sm"
          variant="soft"
          className="mt-auto self-start"
          disabled={clearing || usage.sizeBytes === 0}
          onClick={() => void clear()}
        >
          {clearing ? (
            <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Clear build cache
        </Button>
      )}
    </section>
  );
}
