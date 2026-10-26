import type {
  ContainerList as ContainerListData,
  ContainerSummary,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployContainerAction } from '@shared/deployDockerTypes';
import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Docker,
  EllipsisVertical,
  FileText,
  Globe,
  Search,
  Spinner,
} from '@/components/icons';
import {
  CountChip,
  EmptyState,
  FOOTER_HAIRLINE,
  GLASS_PANEL,
  SECTION_HEADING,
  SearchPill,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { useChartColors } from '@/lib/chartColors';
import {
  type ContainerRow,
  containerRows,
  isPublic,
  portsText,
  STANDALONE,
  toggled,
} from '@/lib/deploy/containers/list';
import { cpuText, memoryShare, type StatsHistory } from '@/lib/deploy/containers/stats';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Sparkline } from './Sparkline';
import { StateChip } from './StateChip';

/**
 * Every container on the server, grouped by compose project (E06 T8). Each row shows its state in
 * words, its processor and memory over the last few minutes, and its published ports, with the
 * lifecycle in a menu for the roles that may use it. The list is drawn a screenful at a time.
 */

const ROW_HEIGHT = 56;

export interface ContainerActions {
  open: (container: ContainerSummary) => void;
  act?: (container: ContainerSummary, action: DeployContainerAction) => void;
  remove?: (container: ContainerSummary) => void;
  /** The container that has a call on its way, whose menu waits. */
  busyId?: string | null;
  /** Every service's log of a compose project together. */
  openStackLogs?: (project: string) => void;
}

const ACTION_LABEL: Record<DeployContainerAction, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  pause: 'Pause',
  unpause: 'Resume',
  kill: 'Kill',
};

/** The lifecycle actions that make sense for a container in its state. */
export function actionsFor(container: Pick<ContainerSummary, 'state'>): DeployContainerAction[] {
  switch (container.state) {
    case 'running':
      return ['stop', 'restart', 'pause', 'kill'];
    case 'paused':
      return ['unpause', 'stop', 'kill'];
    case 'restarting':
      return ['stop', 'kill'];
    default:
      return ['start'];
  }
}

export function ActionMenu({
  container,
  actions,
  align = 'end',
}: {
  container: ContainerSummary;
  actions: ContainerActions;
  align?: 'start' | 'end';
}): React.JSX.Element | null {
  const { act, remove } = actions;
  if (!act && !remove) return null;
  const busy = actions.busyId === container.id;
  return (
    <DropdownMenu>
      <SimpleTooltip label="Actions">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${container.name}`}
            disabled={busy}
          >
            {busy ? <Spinner className="motion-safe:animate-spin" /> : <EllipsisVertical />}
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align={align}>
        {act &&
          actionsFor(container).map((action) => (
            <DropdownMenuItem key={action} onSelect={() => act(container, action)}>
              {ACTION_LABEL[action]}
            </DropdownMenuItem>
          ))}
        {remove && (
          <>
            {act && <DropdownMenuSeparator />}
            <DropdownMenuItem tone="danger" onSelect={() => remove(container)}>
              Remove…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GroupHeader({
  row,
  workingDirectory,
  onToggle,
  onLogs,
}: {
  row: Extract<ContainerRow, { kind: 'group' }>;
  workingDirectory?: string;
  onToggle: () => void;
  onLogs?: (project: string) => void;
}): React.JSX.Element {
  const Chevron = row.folded ? ChevronRight : ChevronDown;
  const stopped = row.total - row.running;
  const project = row.project;
  return (
    <div className="flex h-full items-end gap-1 pb-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!row.folded}
        aria-label={`${row.project ?? STANDALONE}, ${row.running} of ${row.total} running`}
        className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chevron className="h-3 w-3 shrink-0 text-muted-foreground" />
        <h3 className={cn(SECTION_HEADING, 'truncate')}>{row.project ?? STANDALONE}</h3>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {row.running} of {row.total} running
          {stopped > 0 ? `, ${stopped} stopped` : ''}
        </span>
        {workingDirectory && (
          <span className="hidden truncate font-mono text-[11px] text-muted-foreground/80 md:inline">
            {workingDirectory}
          </span>
        )}
      </button>
      {project && onLogs && (
        <SimpleTooltip label="Every service's log">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Logs of ${project}`}
            onClick={() => onLogs(project)}
          >
            <FileText />
          </Button>
        </SimpleTooltip>
      )}
    </div>
  );
}

function ContainerItem({
  container,
  history,
  actions,
}: {
  container: ContainerSummary;
  history: StatsHistory;
  actions: ContainerActions;
}): React.JSX.Element {
  const { categorical } = useChartColors();
  const samples = history.get(container.id) ?? [];
  const latest = samples.at(-1);
  const running = container.state === 'running';
  const ports = portsText(container.ports);
  const exposed = container.ports.some(isPublic);
  const subtitle = container.composeService
    ? `${container.composeService} · ${container.image}`
    : container.image;

  return (
    <div
      role="listitem"
      aria-label={container.name}
      className="grid h-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2.5 transition-colors hover:bg-foreground/[0.06] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1.6fr)_9rem_9rem_minmax(0,1fr)_auto]"
    >
      <button
        type="button"
        onClick={() => actions.open(container)}
        className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open ${container.name}`}
      >
        <StateChip container={container} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {container.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        </span>
      </button>
      <div
        className="hidden items-center gap-2 xl:flex"
        aria-label={`Processor for ${container.name}`}
      >
        <Sparkline values={samples.map((s) => s.cpuPercent)} color={categorical[0]} />
        <span className="w-12 text-right text-xs tabular-nums text-foreground">
          {running && latest ? cpuText(latest.cpuPercent) : '–'}
        </span>
      </div>
      <div
        className="hidden items-center gap-2 xl:flex"
        aria-label={`Memory for ${container.name}`}
      >
        <Sparkline values={samples.map((s) => memoryShare(s))} max={100} color={categorical[1]} />
        <span className="w-14 text-right text-xs tabular-nums text-foreground">
          {running && latest ? formatBytes(latest.memoryUsedBytes) : '–'}
        </span>
      </div>
      <div className="hidden min-w-0 items-center gap-1.5 md:flex">
        {exposed && (
          <SimpleTooltip label="Published on every address: anyone who can reach the server can reach this port.">
            <span className="flex items-center gap-1 text-warning" aria-label="Public">
              <Globe className="h-3 w-3" />
            </span>
          </SimpleTooltip>
        )}
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {ports.length > 0 ? ports.join(', ') : 'No ports'}
        </span>
      </div>
      <ActionMenu container={container} actions={actions} />
    </div>
  );
}

export function ContainerList({
  list,
  history,
  actions,
  notice,
}: {
  list: ContainerListData;
  history: StatsHistory;
  actions: ContainerActions;
  /** A line under the search, such as live figures not coming in. */
  notice?: React.ReactNode;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => containerRows(list, { query, folded }), [list, query, folded]);
  const directories = useMemo(
    () =>
      new Map(list.groups.map((group) => [group.project ?? '', group.workingDirectory] as const)),
    [list],
  );
  const virtual = useVirtualRows(rows.length, ROW_HEIGHT);
  const total = list.groups.reduce((sum, group) => sum + group.containers.length, 0);

  return (
    <div className={cn(GLASS_PANEL, 'min-w-0')}>
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
        <SearchPill
          label="Find a container"
          clearLabel="Clear filter"
          placeholder="Find a container by name, image, project or port"
          value={query}
          onValueChange={setQuery}
          className="min-w-56 max-w-md flex-1"
        />
        <CountChip label="Containers" value={total} />
        {notice}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={query ? Search : Docker}
          title={query ? 'Nothing found' : 'No containers yet'}
          description={
            query
              ? `No container matches "${query}".`
              : 'No containers on this server yet. Start one from the App Store or deploy a project.'
          }
          className={FOOTER_HAIRLINE}
        />
      ) : (
        <div
          ref={virtual.containerRef}
          onScroll={virtual.onScroll}
          className={cn(
            'max-h-[calc(100vh-22rem)] min-h-64 overflow-y-auto px-1.5 pb-1.5',
            FOOTER_HAIRLINE,
          )}
        >
          <div
            role="list"
            aria-label="Containers"
            style={{ paddingTop: virtual.padTop, paddingBottom: virtual.padBottom }}
          >
            {rows.slice(virtual.start, virtual.end).map((row) => (
              <div
                key={row.key}
                style={{ height: ROW_HEIGHT }}
                className={cn(row.kind === 'container' && 'py-0.5')}
                role={row.kind === 'group' ? 'presentation' : undefined}
              >
                {row.kind === 'group' ? (
                  <GroupHeader
                    row={row}
                    workingDirectory={directories.get(row.project ?? '')}
                    onToggle={() => setFolded((current) => toggled(current, row.key))}
                    onLogs={actions.openStackLogs}
                  />
                ) : (
                  <ContainerItem container={row.container} history={history} actions={actions} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
