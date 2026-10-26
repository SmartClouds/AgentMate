import type { DockerContainer } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { DockerContainerRow } from '@/components/docker/DockerContainerRow';
import { RemoveContainerDialog } from '@/components/docker/RemoveContainerDialog';
import { useDockerContainerActions } from '@/components/docker/useDockerContainerActions';
import { Docker, RefreshCw, Search, StopCircle } from '@/components/icons';
import {
  CountChip,
  EmptyState,
  GLASS_CARD,
  SECTION_HEADING,
  SearchPill,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { usePageHeader } from '@/stores/pageHeaderStore';

function matchesQuery(container: DockerContainer, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return container.name.toLowerCase().includes(q) || container.image.toLowerCase().includes(q);
}

function groupByComposeProject(
  containers: DockerContainer[],
): { label: string | null; containers: DockerContainer[] }[] {
  const grouped = new Map<string, DockerContainer[]>();
  const ungrouped: DockerContainer[] = [];
  for (const container of containers) {
    if (!container.composeProject) {
      ungrouped.push(container);
      continue;
    }
    const list = grouped.get(container.composeProject) ?? [];
    list.push(container);
    grouped.set(container.composeProject, list);
  }
  const groups: { label: string | null; containers: DockerContainer[] }[] = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, list]) => ({ label, containers: list }));
  if (ungrouped.length > 0) groups.push({ label: null, containers: ungrouped });
  return groups;
}

/** The container list's card, shimmering row by row until the first list arrives. */
function ContainerListSkeleton(): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'settings-rows')} role="status" aria-label="Loading containers">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3.5 py-3">
          <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function DockerPage(): React.JSX.Element {
  usePageHeader('Docker', 'Containers on this machine, grouped by Compose project.');
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  /** A container asked for by a deep link (the status bar popover), waiting for the list to load. */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [focusedContainerId, setFocusedContainerId] = useState<string | null>(null);
  const rowNodes = useRef(new Map<string, HTMLDivElement>());
  const bindRow = useCallback((id: string) => {
    return (node: HTMLDivElement | null): void => {
      if (node) rowNodes.current.set(id, node);
      else rowNodes.current.delete(id);
    };
  }, []);

  const availabilityQuery = useQuery({
    queryKey: queryKeys.dockerAvailability,
    queryFn: () => window.runova.docker.availability(),
    meta: { silentLoading: true },
  });
  const available = availabilityQuery.data;

  const listQuery = useQuery({
    queryKey: queryKeys.dockerList,
    queryFn: () => window.runova.docker.list(),
    enabled: available === true,
    refetchInterval: available === true ? 4000 : false,
    meta: { silentLoading: true },
  });

  const actions = useDockerContainerActions(queryKeys.dockerList);
  const containers = listQuery.data ?? [];

  // `/docker?container=<id>`, the link the status bar's Docker popover opens. The search box is
  // cleared so the target can't be hidden by whatever was typed last time, and the query string
  // is dropped once read so a later refresh doesn't jump around again.
  useEffect(() => {
    const id = searchParams.get('container');
    if (!id) return;
    setQuery('');
    setSearchParams({}, { replace: true });
    setPendingFocus(id);
    if (available === true) void queryClient.refetchQueries({ queryKey: queryKeys.dockerList });
  }, [searchParams, setSearchParams, available, queryClient]);

  // The list is in by now, so scroll the requested container into view and ring it. Held off
  // until the list has actually loaded at least once: an empty `containers` array here can mean
  // either "not loaded yet" (availability still resolving, or the first fetch in flight) or
  // "genuinely gone", and clearing pendingFocus on the wrong one would drop the request silently.
  useEffect(() => {
    if (!pendingFocus) return;
    if (available !== true || listQuery.isLoading) return;
    const match = containers.find((c) => c.id === pendingFocus);
    setPendingFocus(null);
    if (!match) {
      toast.info('That container is no longer listed.');
      return;
    }
    setFocusedContainerId(match.id);
    const frame = requestAnimationFrame(() => {
      rowNodes.current.get(match.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingFocus, containers, available, listQuery.isLoading]);

  // The ring is a "here it is" pointer, not a state, so it fades on its own.
  useEffect(() => {
    if (focusedContainerId === null) return;
    const timer = setTimeout(() => setFocusedContainerId(null), 6000);
    return () => clearTimeout(timer);
  }, [focusedContainerId]);

  if (availabilityQuery.isLoading) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <Skeleton className="h-12 w-full rounded-[calc(var(--radius)+2px)]" />
        <ContainerListSkeleton />
      </div>
    );
  }

  if (available === false) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <div className={GLASS_CARD}>
          <EmptyState
            size="lg"
            icon={Docker}
            title="Docker isn't available"
            description="Runova couldn't find the docker command on PATH. Install Docker Desktop (or the Docker Engine CLI) and reopen this page."
          />
        </div>
      </div>
    );
  }

  const runningCount = containers.filter((c) => c.state === 'running').length;
  const search = query.trim();
  const visible = containers.filter((c) => matchesQuery(c, search));
  const groups = groupByComposeProject(visible);
  const hasComposeGroups = groups.some((group) => group.label !== null);

  return (
    <div className="flex flex-col gap-2 p-2">
      {/* The toolbar is its own glass card, the way the API Client's URL bar heads its card. */}
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 px-2.5 py-2')}>
        <SearchPill
          label="Search containers"
          placeholder="Search containers or images"
          value={query}
          onValueChange={setQuery}
          className="w-full min-w-48 max-w-xs flex-1"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <CountChip
            label="Running"
            value={runningCount}
            tone="success"
            loading={listQuery.isLoading}
          />
          <CountChip
            label="Stopped"
            value={containers.length - runningCount}
            loading={listQuery.isLoading}
          />
          <CountChip label="Total" value={containers.length} loading={listQuery.isLoading} />
        </div>
        <Button
          variant="soft"
          className="ml-auto"
          disabled={listQuery.isFetching}
          aria-busy={listQuery.isFetching}
          onClick={() => void listQuery.refetch()}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', listQuery.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {listQuery.isLoading ? (
        <ContainerListSkeleton />
      ) : containers.length === 0 ? (
        <div className={GLASS_CARD}>
          <EmptyState
            size="lg"
            icon={Docker}
            title="No containers on this machine"
            description="Containers you create or run with Docker will show up here."
          />
        </div>
      ) : visible.length === 0 ? (
        <div className={GLASS_CARD}>
          <EmptyState
            size="sm"
            icon={Search}
            title="Nothing found"
            description={`No containers match "${search}".`}
          />
        </div>
      ) : (
        groups.map((group) => {
          const runningContainers = group.containers.filter((c) => c.state === 'running');
          return (
            <section
              key={group.label ?? 'ungrouped'}
              aria-label={group.label ?? 'Other containers'}
              className={cn(GLASS_CARD, 'overflow-hidden')}
            >
              {/* Loose containers only get a heading when compose groups sit above them. */}
              {(group.label || hasComposeGroups) && (
                <div className="flex h-10 items-center gap-2 pl-3.5 pr-2 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
                  <p className={cn(SECTION_HEADING, 'min-w-0 truncate')}>
                    {group.label ?? 'Other containers'}
                  </p>
                  <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
                    {group.containers.length}
                  </span>
                  {group.label && runningContainers.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 gap-1 px-2.5 text-muted-foreground hover:text-foreground"
                      onClick={() => actions.stopMany(runningContainers, group.label ?? undefined)}
                    >
                      <StopCircle className="h-3 w-3" />
                      Stop all
                    </Button>
                  )}
                </div>
              )}
              {/* Rows at the card's edge follow its inner corner (radius + 2px, less the 1px
                  border), so a focused row's ring curves with the card instead of cutting square. */}
              <div
                className={cn(
                  'settings-rows [&>*:last-child]:rounded-b-[calc(var(--radius)+1px)]',
                  !(group.label || hasComposeGroups) &&
                    '[&>*:first-child]:rounded-t-[calc(var(--radius)+1px)]',
                )}
              >
                {group.containers.map((container) => (
                  <DockerContainerRow
                    key={container.id}
                    variant="row"
                    container={container}
                    pending={actions.pendingIds.has(container.id)}
                    focused={focusedContainerId === container.id}
                    rowRef={bindRow(container.id)}
                    onStart={() => actions.start(container.id)}
                    onStop={() => actions.stop(container)}
                    onRestart={() => actions.restart(container.id)}
                    onRemove={() => actions.openRemoveDialog(container)}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}

      <RemoveContainerDialog
        containerName={actions.removeTarget?.name ?? null}
        open={actions.removeTarget !== null}
        removing={actions.removing}
        onOpenChange={(open) => {
          if (!open) actions.closeRemoveDialog();
        }}
        onConfirm={actions.confirmRemove}
      />
    </div>
  );
}
