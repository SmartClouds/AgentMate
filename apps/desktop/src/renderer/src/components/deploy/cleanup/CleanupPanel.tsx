import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Docker, Sparkles } from '@/components/icons';
import { EmptyState, GLASS_CARD, LoadFailure, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CLEANUP_KINDS,
  type CleanupApi,
  type CleanupFilter,
  type CleanupKind,
  canRemove,
  cleanupCandidates,
  filterItems,
  runCleanup,
  selectionSummary,
} from '@/lib/deploy/cleanup/candidates';
import { allContainers } from '@/lib/deploy/containers/list';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useDockerEvents } from '../containers/hooks';
import { hasRole } from '../security/format';
import {
  CleanupGroup,
  CleanupToolbar,
  KIND_META,
  type RowState,
  SelectionBar,
} from './CleanupList';
import { BuildCacheCard, CleanupSummary } from './CleanupSummary';

/**
 * A server's Cleanup section: what Docker keeps on the server that nothing uses (images no
 * container runs, stopped containers, volumes and networks nothing is attached to), with its age
 * and size. Pick by kind, age or name and remove the lot in one go; the build cache is cleared on
 * its own. Removal asks first, and asks for the server's name when volumes (data) are in it.
 */

const NO_FILTER: CleanupFilter = { kind: 'all', age: 'any', query: '' };
/** Names listed in the confirmation before it says "and N more". */
const LISTED = 6;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function PanelSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Looking for unused data">
      <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Skeleton className="h-36 rounded-[calc(var(--radius)+2px)]" />
        <Skeleton className="h-36 rounded-[calc(var(--radius)+2px)]" />
      </div>
      <div className={cn(GLASS_CARD, 'space-y-2 p-3')}>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function CleanupPanel({
  server,
  onUpdateCore,
}: {
  server: DeployServer;
  onUpdateCore?: (() => void) | undefined;
}): React.JSX.Element {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<CleanupFilter>(NO_FILTER);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [statuses, setStatuses] = useState<ReadonlyMap<string, RowState>>(new Map());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const access = useQuery({
    queryKey: queryKeys.deployAccess(serverId),
    queryFn: () => window.runova.deploy.access(serverId),
    retry: false,
    staleTime: 30_000,
  });
  const signedIn = access.data?.state === 'signed-in';
  const roles = access.data?.user?.roles;
  const canOperate = hasRole(roles, 'operator');
  const canAdmin = hasRole(roles, 'admin');

  const status = useQuery({
    queryKey: queryKeys.deployDockerStatus(serverId),
    queryFn: () => window.runova.deployDocker.status(serverId),
    enabled: signedIn,
    retry: false,
  });
  const ready = signedIn && status.data?.installed === true && status.data.running;
  // The same keys as the Containers tabs, so both read one cache and a change refreshes both.
  const lists = {
    images: useQuery({
      queryKey: queryKeys.deployImages(serverId),
      queryFn: () => window.runova.deployDocker.listImages(serverId),
      enabled: ready,
      retry: false,
    }),
    containers: useQuery({
      queryKey: queryKeys.deployContainers(serverId),
      queryFn: () => window.runova.deployDocker.listContainers(serverId),
      enabled: ready,
      retry: false,
    }),
    volumes: useQuery({
      queryKey: queryKeys.deployVolumes(serverId),
      queryFn: () => window.runova.deployDocker.listVolumes(serverId),
      enabled: ready,
      retry: false,
    }),
    networks: useQuery({
      queryKey: queryKeys.deployNetworks(serverId),
      queryFn: () => window.runova.deployDocker.listNetworks(serverId),
      enabled: ready,
      retry: false,
    }),
    usage: useQuery({
      queryKey: queryKeys.deployDiskUsage(serverId),
      queryFn: () => window.runova.deployDocker.diskUsage(serverId),
      enabled: ready,
      retry: false,
    }),
  };
  useDockerEvents(serverId, ready);

  const items = useMemo(
    () =>
      cleanupCandidates({
        images: lists.images.data,
        containers: allContainers(lists.containers.data),
        volumes: lists.volumes.data,
        networks: lists.networks.data,
      }).filter((item) => !gone.has(item.key)),
    [lists.images.data, lists.containers.data, lists.volumes.data, lists.networks.data, gone],
  );
  const shown = useMemo(() => filterItems(items, filter, Date.now()), [items, filter]);
  // What is picked and still there: an item that went away (removed elsewhere) drops out.
  const picked = useMemo(
    () => new Set(items.filter((item) => selected.has(item.key)).map((item) => item.key)),
    [items, selected],
  );
  const summary = selectionSummary(items, picked);
  const roleFlags = { canOperate, canAdmin };

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployDocker(serverId) });
  }

  function toggle(keys: string[], on: boolean): void {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  async function removeSelected(): Promise<void> {
    const chosen = items.filter((item) => picked.has(item.key));
    if (chosen.length === 0) return;
    const confirmed = await confirmDialog({
      title: `Remove ${plural(chosen.length, 'item')} from ${server.nickname}?`,
      description: [
        'Nothing running uses them.',
        summary.bytes > 0 ? `This frees about ${formatBytes(summary.bytes)}.` : null,
        chosen.some((item) => item.kind === 'image') ? 'Removed images can be pulled again.' : null,
      ]
        .filter(Boolean)
        .join(' '),
      items: chosen
        .slice(0, LISTED)
        .map((item) => ({ name: item.name, detail: KIND_META[item.kind].one })),
      moreCount: chosen.length > LISTED ? chosen.length - LISTED : undefined,
      warning: summary.hasVolumes ? 'Data in removed volumes cannot be brought back.' : undefined,
      confirmLabel: 'Remove',
      variant: 'destructive',
      typeToConfirm: summary.hasVolumes ? server.nickname : undefined,
    });
    if (!confirmed) return;

    const docker = window.runova.deployDocker;
    const api: CleanupApi = {
      removeContainer: (containerId) =>
        docker.remove({ serverId, containerId, removeVolumes: false, force: false }),
      removeImage: (image) => docker.removeImage({ serverId, image, force: false }),
      removeNetwork: (network) => docker.removeNetwork(serverId, network),
      removeVolume: (volume) => docker.removeVolume({ serverId, volume, force: false }),
    };
    setStatuses(new Map());
    setProgress({ done: 0, total: chosen.length });
    const outcome = await runCleanup(chosen, api, (step) => {
      setProgress({ done: step.done, total: step.total });
      setStatuses((previous) => {
        const next = new Map(previous);
        if (step.state === 'removing') next.set(step.item.key, { state: 'removing' });
        else if (step.state === 'failed')
          next.set(step.item.key, { state: 'failed', message: step.message ?? '' });
        else next.delete(step.item.key);
        return next;
      });
      if (step.state === 'removed') {
        setGone((previous) => new Set(previous).add(step.item.key));
      }
    });
    setProgress(null);
    setSelected(new Set(outcome.failed.map((failure) => failure.item.key)));
    const removed = outcome.removed.length;
    if (outcome.failed.length === 0) {
      toast.success(
        outcome.freedBytes > 0
          ? `Removed ${plural(removed, 'item')} and freed ${formatBytes(outcome.freedBytes)}.`
          : `Removed ${plural(removed, 'item')}.`,
      );
    } else {
      toast.warning(
        `Removed ${removed} of ${chosen.length}. ${outcome.failed.length} could not be removed.`,
      );
    }
    refresh();
  }

  if (access.isPending) return <PanelSkeleton />;
  if (!signedIn) {
    return (
      <EmptyState
        card
        icon={Docker}
        title="Not signed in"
        description={`Sign in to ${server.nickname} on its Overview to see what could be cleaned up.`}
      />
    );
  }
  if (status.isPending) return <PanelSkeleton />;
  if (status.error) {
    return (
      <LoadFailure
        message={`Could not find out about Docker: ${coreErrorMessage(status.error)}`}
        retry={() => void status.refetch()}
      />
    );
  }
  if (!ready) {
    return (
      <Notice
        icon={Docker}
        action={
          <Button
            size="sm"
            variant="soft"
            onClick={() =>
              navigate(
                `/deploy?${new URLSearchParams({ server: serverId, view: 'containers' }).toString()}`,
              )
            }
          >
            Open Containers
          </Button>
        }
      >
        {status.data.installed
          ? `Docker is not running on ${server.nickname}, so there is nothing to look through. Start it from the Containers section.`
          : `Docker is not installed on ${server.nickname}, so there is nothing to clean up. Set it up from the Containers section.`}
      </Notice>
    );
  }
  const all = Object.values(lists);
  const failed = all.find((query) => query.error);
  if (failed) {
    return (
      <LoadFailure
        message={coreErrorMessage(failed.error)}
        retry={() => {
          for (const query of all) if (query.error) void query.refetch();
        }}
      />
    );
  }
  if (all.some((query) => query.isPending) || !lists.usage.data) return <PanelSkeleton />;

  const counts = {
    all: items.length,
    ...Object.fromEntries(
      CLEANUP_KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind).length]),
    ),
  } as Record<CleanupKind | 'all', number>;
  const scanning = all.some((query) => query.isFetching);

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <CleanupSummary
          usage={lists.usage.data}
          serverName={server.nickname}
          scanning={scanning}
          onScan={refresh}
        />
        <BuildCacheCard
          serverId={serverId}
          serverName={server.nickname}
          usage={lists.usage.data.buildCache}
          canAdmin={canAdmin}
          onCleared={refresh}
          onUpdateCore={onUpdateCore}
        />
      </div>
      {!canOperate && (
        <Notice size="sm">
          Removing needs an Operator, and volumes need an Admin. You can still see what could go.
        </Notice>
      )}
      {items.length === 0 ? (
        <EmptyState
          card
          icon={Sparkles}
          title={`Nothing to clean up on ${server.nickname}`}
          description="Every image, volume and network is in use, and no container is stopped."
        />
      ) : (
        <>
          <CleanupToolbar filter={filter} counts={counts} onChange={setFilter} />
          {shown.length === 0 ? (
            <EmptyState
              card
              size="sm"
              icon={Sparkles}
              title="No unused items match these filters."
              action={
                <Button size="sm" variant="soft" onClick={() => setFilter(NO_FILTER)}>
                  Reset filters
                </Button>
              }
            />
          ) : (
            CLEANUP_KINDS.map((kind) => (
              <CleanupGroup
                key={kind}
                kind={kind}
                items={shown.filter((item) => item.kind === kind)}
                selected={picked}
                allowed={canRemove(kind, roleFlags)}
                busy={progress !== null}
                statuses={statuses}
                onToggle={toggle}
              />
            ))
          )}
          {(summary.count > 0 || progress) && (
            <SelectionBar
              summary={summary}
              progress={progress}
              onClear={() => setSelected(new Set())}
              onRemove={() => void removeSelected()}
            />
          )}
        </>
      )}
    </div>
  );
}
