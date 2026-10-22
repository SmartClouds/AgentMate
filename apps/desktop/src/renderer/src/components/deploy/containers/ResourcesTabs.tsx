import { coreErrorMessage } from '@shared/coreErrors';
import type {
  DockerDiskUsageEntry,
  DockerPruneTarget,
  ImageInfo,
  JobInfo,
  NetworkInfo,
  VolumeInfo,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { isImageReference } from '@shared/dockerNames';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  CloudDownload,
  Docker,
  FolderOpen,
  HardDrive,
  NetworkIcon,
  Package,
  Spinner,
  Trash2,
  Wrench,
} from '@/components/icons';
import { Chip, EmptyState, GLASS_CARD, LoadFailure, TileHeader } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { ago } from '../security/format';
import { serverFilesHref } from '../serverFiles/params';

/**
 * Docker's resources on a server (E06 T7): images (pull one, with its layers in a live log, or
 * remove one), volumes, networks, and how much disk each kind takes with what a prune would free.
 * Removing and pruning ask first; a prune that can take data asks for the server's name.
 */

export interface ResourceRoles {
  canOperate: boolean;
  canAdmin: boolean;
}

/** The glass card a resource list sits in, its rows split by the .settings-rows hairlines. */
const LIST_CARD = cn(GLASS_CARD, 'settings-rows overflow-hidden');

/** One resource in a list card, with its remove button on the right. */
const ROW = 'flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-foreground/[0.03]';

function Rows({ count, label }: { count: number; label: string }): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'space-y-2 p-3')} aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-lg" />
      ))}
    </div>
  );
}

function Failure({ error, retry }: { error: unknown; retry: () => void }): React.JSX.Element {
  return <LoadFailure message={coreErrorMessage(error)} retry={retry} />;
}

function Empty({
  icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: string;
}): React.JSX.Element {
  return <EmptyState card size="sm" icon={icon} title={children} />;
}

function RemoveButton({
  label,
  disabled = false,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={disabled ? 'In use, so it cannot be removed' : 'Remove'} wrapTrigger>
      <Button
        variant="ghost"
        size="icon-sm"
        className="hover:bg-destructive/10 hover:text-destructive"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        <Trash2 />
      </Button>
    </SimpleTooltip>
  );
}

async function attempt(work: () => Promise<unknown>, done: string): Promise<boolean> {
  try {
    await work();
    toast.success(done);
    return true;
  } catch (error) {
    toast.error(coreErrorMessage(error));
    return false;
  }
}

export function ImagesTab({
  serverId,
  roles,
  onJob,
}: {
  serverId: string;
  roles: ResourceRoles;
  onJob: (job: JobInfo) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [reference, setReference] = useState('');
  const [pulling, setPulling] = useState(false);
  const images = useQuery({
    queryKey: queryKeys.deployImages(serverId),
    queryFn: () => window.agentmat.deployDocker.listImages(serverId),
    retry: false,
  });
  const valid = isImageReference(reference.trim());

  async function pull(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!valid) return;
    setPulling(true);
    try {
      onJob(
        await window.agentmat.deployDocker.pullImage({ serverId, reference: reference.trim() }),
      );
      setReference('');
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setPulling(false);
    }
  }

  async function remove(image: ImageInfo): Promise<void> {
    const name = image.tags[0] ?? image.id.replace(/^sha256:/, '').slice(0, 12);
    const used = image.containers > 0;
    const confirmed = await confirmDialog({
      title: `Remove ${name}?`,
      description: used
        ? `${image.containers} container${image.containers === 1 ? '' : 's'} on the server use this image. They keep running, but cannot be created again without pulling it.`
        : 'It can be pulled again later.',
      confirmLabel: used ? 'Remove anyway' : 'Remove the image',
      variant: 'destructive',
    });
    if (!confirmed) return;
    if (
      await attempt(
        () => window.agentmat.deployDocker.removeImage({ serverId, image: image.id, force: used }),
        `Removed ${name}.`,
      )
    ) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployImages(serverId) });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {roles.canOperate && (
        <form
          className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 px-2.5 py-2')}
          onSubmit={(event) => void pull(event)}
        >
          <Input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="nginx:1.29 or ghcr.io/org/app:1.0"
            aria-label="Image to pull"
            aria-invalid={reference.trim() !== '' && !valid ? true : undefined}
            className="h-8 min-w-48 max-w-sm flex-1 font-mono text-xs"
            spellCheck={false}
          />
          <Button type="submit" size="sm" disabled={!valid || pulling}>
            {pulling ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <CloudDownload className="h-3.5 w-3.5" />
            )}
            Pull
          </Button>
          {reference.trim() !== '' && !valid && (
            <span className="text-xs text-destructive">That is not an image reference.</span>
          )}
        </form>
      )}
      {images.isPending ? (
        <Rows count={4} label="Loading images" />
      ) : images.error ? (
        <Failure error={images.error} retry={() => void images.refetch()} />
      ) : images.data.length === 0 ? (
        <Empty icon={Package}>No images on this server yet.</Empty>
      ) : (
        <ul className={LIST_CARD} aria-label="Images">
          {images.data.map((image) => (
            <li key={image.id} aria-label={image.tags[0] ?? image.id} className={ROW}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs text-foreground">
                  {image.tags.length > 0 ? image.tags.join(', ') : 'No tag'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(image.sizeBytes)}, made {ago(image.createdAtUnixMs)},{' '}
                  {image.containers === 0
                    ? 'not used'
                    : `used by ${image.containers} container${image.containers === 1 ? '' : 's'}`}
                </p>
              </div>
              {roles.canOperate && (
                <RemoveButton
                  label={`Remove ${image.tags[0] ?? image.id}`}
                  onClick={() => void remove(image)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VolumesTab({
  serverId,
  roles,
}: {
  serverId: string;
  roles: ResourceRoles;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const volumes = useQuery({
    queryKey: queryKeys.deployVolumes(serverId),
    queryFn: () => window.agentmat.deployDocker.listVolumes(serverId),
    retry: false,
  });

  async function remove(volume: VolumeInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove the volume ${volume.name}?`,
      description: 'Everything stored in it is deleted.',
      warning: 'Deleted data cannot be brought back.',
      confirmLabel: 'Remove the volume',
      variant: 'destructive',
      typeToConfirm: volume.name,
    });
    if (!confirmed) return;
    if (
      await attempt(
        () =>
          window.agentmat.deployDocker.removeVolume({
            serverId,
            volume: volume.name,
            force: false,
          }),
        `Removed ${volume.name}.`,
      )
    ) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployVolumes(serverId) });
    }
  }

  if (volumes.isPending) return <Rows count={3} label="Loading volumes" />;
  if (volumes.error) return <Failure error={volumes.error} retry={() => void volumes.refetch()} />;
  if (volumes.data.length === 0) return <Empty icon={HardDrive}>No volumes on this server.</Empty>;
  return (
    <ul className={LIST_CARD} aria-label="Volumes">
      {volumes.data.map((volume) => (
        <li key={volume.name} aria-label={volume.name} className={ROW}>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs text-foreground">{volume.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[
                volume.composeProject ? `project ${volume.composeProject}` : null,
                volume.sizeBytes !== undefined ? formatBytes(volume.sizeBytes) : null,
                volume.containers === 0
                  ? 'not used'
                  : `used by ${volume.containers} container${volume.containers === 1 ? '' : 's'}`,
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
          </div>
          <SimpleTooltip
            label={roles.canAdmin ? 'Browse files' : 'Browsing files in a volume is for Admins.'}
            wrapTrigger
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Browse files in ${volume.name}`}
              disabled={!roles.canAdmin}
              onClick={() =>
                navigate(serverFilesHref(serverId, { source: 'volume', target: volume.name }))
              }
            >
              <FolderOpen />
            </Button>
          </SimpleTooltip>
          {roles.canAdmin && (
            <RemoveButton
              label={`Remove ${volume.name}`}
              disabled={volume.containers > 0}
              onClick={() => void remove(volume)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function NetworksTab({
  serverId,
  roles,
}: {
  serverId: string;
  roles: ResourceRoles;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const networks = useQuery({
    queryKey: queryKeys.deployNetworks(serverId),
    queryFn: () => window.agentmat.deployDocker.listNetworks(serverId),
    retry: false,
  });

  async function remove(network: NetworkInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove the network ${network.name}?`,
      description: 'Containers that are not on it are not affected.',
      confirmLabel: 'Remove the network',
      variant: 'destructive',
    });
    if (!confirmed) return;
    if (
      await attempt(
        () => window.agentmat.deployDocker.removeNetwork(serverId, network.name),
        `Removed ${network.name}.`,
      )
    ) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployNetworks(serverId) });
    }
  }

  if (networks.isPending) return <Rows count={3} label="Loading networks" />;
  if (networks.error)
    return <Failure error={networks.error} retry={() => void networks.refetch()} />;
  if (networks.data.length === 0)
    return <Empty icon={NetworkIcon}>No networks on this server.</Empty>;
  return (
    <ul className={LIST_CARD} aria-label="Networks">
      {networks.data.map((network) => (
        <li key={network.id} aria-label={network.name} className={ROW}>
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-2 font-mono text-xs text-foreground">
              <span className="truncate">{network.name}</span>
              {network.builtIn && (
                <Chip className="h-4 px-1.5 font-sans text-[10px]">Built in</Chip>
              )}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {[
                network.driver,
                network.internal ? 'internal only' : null,
                network.subnets.join(', ') || null,
                `${network.containers} container${network.containers === 1 ? '' : 's'}`,
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
          </div>
          {roles.canOperate && !network.builtIn && (
            <RemoveButton
              label={`Remove ${network.name}`}
              disabled={network.containers > 0}
              onClick={() => void remove(network)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

type DiskKey = 'images' | 'containers' | 'volumes' | 'buildCache';

const DISK_KINDS: Array<{
  key: DiskKey;
  label: string;
  icon: React.ReactNode;
  prune?: DockerPruneTarget;
  what: string;
}> = [
  {
    key: 'images',
    label: 'Images',
    icon: <Package />,
    prune: 'images',
    what: 'images no container uses',
  },
  {
    key: 'containers',
    label: 'Containers',
    icon: <Docker />,
    prune: 'containers',
    what: 'stopped containers',
  },
  {
    key: 'volumes',
    label: 'Volumes',
    icon: <HardDrive />,
    prune: 'volumes',
    what: 'volumes no container uses',
  },
  { key: 'buildCache', label: 'Build cache', icon: <Wrench />, what: 'the build cache' },
];

export function DiskUsageTab({
  serverId,
  serverName,
  roles,
}: {
  serverId: string;
  serverName: string;
  roles: ResourceRoles;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [pruning, setPruning] = useState<DockerPruneTarget | null>(null);
  const usage = useQuery({
    queryKey: queryKeys.deployDiskUsage(serverId),
    queryFn: () => window.agentmat.deployDocker.diskUsage(serverId),
    retry: false,
  });

  async function prune(target: DockerPruneTarget, what: string): Promise<void> {
    const takesData = target === 'volumes' || target === 'system';
    const confirmed = await confirmDialog({
      title: target === 'system' ? `Clean up Docker on ${serverName}?` : `Remove ${what}?`,
      description:
        target === 'system'
          ? 'Removes stopped containers, unused networks, images no container uses, the build cache and unused volumes.'
          : `Docker removes ${what} on ${serverName}. Running containers are not touched.`,
      warning: takesData ? 'Data in removed volumes cannot be brought back.' : undefined,
      confirmLabel: target === 'system' ? 'Clean up' : 'Remove',
      variant: 'destructive',
      typeToConfirm: takesData ? serverName : undefined,
    });
    if (!confirmed) return;
    setPruning(target);
    try {
      const result = await window.agentmat.deployDocker.prune({
        serverId,
        target,
        allImages: target === 'images' || target === 'system',
        includeVolumes: target === 'system',
      });
      toast.success(
        `Removed ${result.removed} item${result.removed === 1 ? '' : 's'} and freed ${formatBytes(result.reclaimedBytes)}.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployDocker(serverId) });
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setPruning(null);
    }
  }

  if (usage.isPending) return <Rows count={4} label="Loading disk use" />;
  if (usage.error) return <Failure error={usage.error} retry={() => void usage.refetch()} />;
  const data = usage.data;
  const total = DISK_KINDS.reduce((sum, kind) => sum + data[kind.key].sizeBytes, 0);
  const free = DISK_KINDS.reduce((sum, kind) => sum + data[kind.key].reclaimableBytes, 0);

  return (
    <div className="flex flex-col gap-2">
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 px-3.5 py-2.5')}>
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Docker uses {formatBytes(total)} on {serverName}; up to {formatBytes(free)} of it could be
          freed.
        </p>
        {roles.canAdmin && (
          <Button
            size="sm"
            variant="danger"
            disabled={pruning !== null}
            onClick={() => void prune('system', 'everything unused')}
          >
            {pruning === 'system' ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Clean up everything unused
          </Button>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2" role="list" aria-label="Disk use">
        {DISK_KINDS.map((kind) => {
          const entry: DockerDiskUsageEntry = data[kind.key];
          return (
            <div
              key={kind.key}
              role="listitem"
              aria-label={kind.label}
              className={cn(GLASS_CARD, 'flex flex-col gap-2 p-4')}
            >
              <TileHeader icon={kind.icon} title={kind.label} />
              <span className="text-2xl font-semibold tabular-nums tracking-tight">
                {formatBytes(entry.sizeBytes)}
              </span>
              <p className="text-xs text-muted-foreground">
                {entry.count} in all, {entry.active} in use, {formatBytes(entry.reclaimableBytes)}{' '}
                could be freed
              </p>
              {roles.canAdmin && kind.prune && (
                <Button
                  size="sm"
                  variant="soft"
                  className="mt-auto self-start"
                  disabled={pruning !== null || entry.reclaimableBytes === 0}
                  onClick={() => void prune(kind.prune as DockerPruneTarget, kind.what)}
                >
                  {pruning === kind.prune ? (
                    <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  Remove {kind.what}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
