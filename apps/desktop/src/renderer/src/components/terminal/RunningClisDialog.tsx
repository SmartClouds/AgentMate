import * as PopoverPrimitive from '@radix-ui/react-popover';
import { type AgentStatus, getCliDefinition, type Project } from '@runova/core';
import type { TerminalSessionUsage } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Cpu,
  Filter,
  MemoryStick,
  RefreshCw,
  Search,
  Trash2,
  X,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { MENU_LABEL, OVERLAY_MOTION, OVERLAY_SURFACE } from '@/components/ui/overlay';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes, formatPercent } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { confirmDialog } from '@/stores/confirmStore';
import { useRunningClisStore } from '@/stores/runningClisStore';
import { stopRuns } from '@/stores/runSessionStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { terminalTabLabel, useWorkspaceStore } from '@/stores/workspaceStore';
import {
  cliLabel,
  type RunningCli,
  RunningCliRow,
  type RunningCliSource,
  SOURCE_LABEL,
} from './RunningCliRow';

/** Sampling shells out to the OS, so the modal asks every few seconds and only while open. */
const POLL_INTERVAL_MS = 3000;

type SortKey = 'cpu' | 'memory' | 'age' | 'name' | 'project';

const SORT_LABEL: Record<SortKey, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  age: 'Age',
  name: 'Name',
  project: 'Project',
};

/** Numbers read best biggest first; names read best A to Z. */
const DEFAULT_DESC: Record<SortKey, boolean> = {
  cpu: true,
  memory: true,
  age: true,
  name: false,
  project: false,
};

type KindFilter = 'agent' | 'shell';
type StateFilter = 'running' | 'ended';

interface Filters {
  sources: Set<RunningCliSource>;
  kinds: Set<KindFilter>;
  states: Set<StateFilter>;
}

const ALL_SOURCES: RunningCliSource[] = ['workspace', 'drawer', 'ssh', 'detached'];
const ALL_KINDS: KindFilter[] = ['agent', 'shell'];
const ALL_STATES: StateFilter[] = ['running', 'ended'];

function allFilters(): Filters {
  return {
    sources: new Set(ALL_SOURCES),
    kinds: new Set(ALL_KINDS),
    states: new Set(ALL_STATES),
  };
}

function hiddenFilterCount(filters: Filters): number {
  return (
    ALL_SOURCES.length -
    filters.sources.size +
    ALL_KINDS.length -
    filters.kinds.size +
    ALL_STATES.length -
    filters.states.size
  );
}

function toggled<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** The workspace's terminal tabs as a string, so unrelated store updates don't re-render. */
function useWorkspaceTerminalSignature(): string {
  return useWorkspaceStore((s) =>
    JSON.stringify(
      Object.entries(s.workspaces).flatMap(([projectId, ws]) =>
        Object.values(ws.tabs).flatMap((tab) =>
          tab.kind === 'terminal'
            ? [
                [
                  tab.id,
                  projectId,
                  terminalTabLabel(tab),
                  tab.cliId,
                  tab.cwd,
                  tab.shell,
                  tab.createdAt,
                ],
              ]
            : [],
        ),
      ),
    ),
  );
}

export function RunningClisDialog(): React.JSX.Element {
  const open = useRunningClisStore((s) => s.open);
  const setOpen = useRunningClisStore((s) => s.setOpen);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Filters>(allFilters);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cpu', desc: true });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) return;
    setSearch('');
    setSelected(new Set());
    setExpanded(new Set());
  }, [open]);

  const usageQuery = useQuery({
    queryKey: queryKeys.terminalUsage,
    queryFn: () => window.runova.terminal.usage(),
    enabled: open,
    refetchInterval: open ? POLL_INTERVAL_MS : false,
    meta: { silentLoading: true },
  });
  const projectsQuery = useQuery<Project[]>({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
    enabled: open,
  });
  const statuses = useAgentStatusStore((s) => s.statuses);
  const workspaceSignature = useWorkspaceTerminalSignature();
  const drawerSessions = useTerminalStore((s) => s.sessions);

  const projectName = (id?: string): string | undefined =>
    id ? (projectsQuery.data?.find((p) => p.id === id)?.name ?? 'Unknown project') : undefined;

  const usage = usageQuery.data;
  const rows = useMemo<RunningCli[]>(() => {
    const usageById = new Map<string, TerminalSessionUsage>(
      (usage?.sessions ?? []).map((session) => [session.sessionId, session]),
    );
    const loaded = usage !== undefined;
    const list: RunningCli[] = [];
    const seen = new Set<string>();

    const tabs = JSON.parse(workspaceSignature) as [
      string,
      string,
      string,
      string | undefined,
      string,
      string | undefined,
      number,
    ][];
    for (const [id, projectId, title, cliId, cwd, shell, createdAt] of tabs) {
      seen.add(id);
      const sessionUsage = usageById.get(id);
      list.push({
        id,
        title,
        source: 'workspace',
        projectId,
        cliId: cliId ?? undefined,
        cwd,
        shell: shell ?? undefined,
        createdAt,
        usage: sessionUsage,
        ended: loaded && !sessionUsage,
      });
    }
    for (const session of drawerSessions) {
      // A file manager tab (E25) has no shell, so it is not a running CLI of any kind.
      if (session.kind === 'sftp') continue;
      seen.add(session.id);
      const ssh = session.kind === 'ssh';
      const sessionUsage = ssh ? undefined : usageById.get(session.id);
      list.push({
        id: session.id,
        title: session.title,
        source: ssh ? 'ssh' : 'drawer',
        projectId: session.projectId,
        cwd: session.cwd,
        shell: session.shell,
        usage: sessionUsage,
        ended: !ssh && loaded && !sessionUsage,
      });
    }
    // Shells the host is still running with no tab left to show them.
    for (const session of usage?.sessions ?? []) {
      if (seen.has(session.sessionId)) continue;
      list.push({
        id: session.sessionId,
        title: session.cliId
          ? `${getCliDefinition(session.cliId)?.label ?? session.cliId} session`
          : `${session.processes.find((p) => p.pid === session.pid)?.name ?? 'Shell'} (PID ${session.pid})`,
        source: 'detached',
        projectId: session.projectId,
        cliId: session.cliId,
        createdAt: session.createdAt,
        usage: session,
        ended: false,
      });
    }
    return list;
  }, [usage, workspaceSignature, drawerSessions]);

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const names = new Map((projectsQuery.data ?? []).map((p) => [p.id, p.name]));
    const matches = rows.filter((row) => {
      if (!filters.sources.has(row.source)) return false;
      if (!filters.kinds.has(row.cliId ? 'agent' : 'shell')) return false;
      if (!filters.states.has(row.ended ? 'ended' : 'running')) return false;
      if (!query) return true;
      const haystack = [
        row.title,
        row.projectId ? names.get(row.projectId) : '',
        cliLabel(row),
        row.cwd,
        row.shell,
        SOURCE_LABEL[row.source],
        ...(row.usage?.processes.map((p) => p.name) ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

    const direction = sort.desc ? -1 : 1;
    const text = (row: RunningCli): string =>
      sort.key === 'project' ? (names.get(row.projectId ?? '') ?? '') : row.title;
    const value = (row: RunningCli): number | null => {
      if (sort.key === 'cpu') return row.usage ? row.usage.cpuPercent : null;
      if (sort.key === 'memory') return row.usage ? row.usage.memBytes : null;
      const started = row.usage?.createdAt ?? row.createdAt;
      // Older is "more age", so it sorts first when descending.
      return started ? -started : null;
    };
    return [...matches].sort((a, b) => {
      if (sort.key === 'name' || sort.key === 'project') {
        return (
          text(a).localeCompare(text(b), undefined, { sensitivity: 'base' }) * direction ||
          a.title.localeCompare(b.title)
        );
      }
      const av = value(a);
      const bv = value(b);
      // Rows without a number (SSH, ended) always sink to the bottom.
      if (av === null || bv === null) return av === null ? (bv === null ? 0 : 1) : -1;
      return (av - bv) * direction || a.title.localeCompare(b.title);
    });
  }, [rows, filters, query, sort, projectsQuery.data]);

  // Drop selections for rows that went away (ended elsewhere, or closed by an action here).
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(rows.map((row) => row.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [rows]);

  const totals = useMemo(() => {
    let cpu = 0;
    let mem = 0;
    let running = 0;
    for (const row of rows) {
      if (!row.usage) continue;
      running += 1;
      cpu += row.usage.cpuPercent;
      mem += row.usage.memBytes;
    }
    return { cpu: Math.min(100, cpu), mem, running };
  }, [rows]);

  const statsLoading = usage === undefined && usageQuery.isPending;
  const cpuLoading = usage !== undefined && !usage.cpuReady;
  const statsAvailable = usage?.available ?? true;
  const visibleIds = visible.map((row) => row.id);
  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const hiddenFilters = hiddenFilterCount(filters);

  const refreshUsage = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.terminalUsage });
  };

  const markPending = (ids: string[], on: boolean): void =>
    setPending((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  function endRow(row: RunningCli): void {
    if (row.source === 'workspace' && row.projectId) {
      useWorkspaceStore.getState().closeTab(row.projectId, row.id);
    } else if (row.source === 'ssh') {
      useTerminalStore.getState().closeSession(row.id);
    } else {
      void window.runova.terminal.kill(row.id);
    }
  }

  async function endRows(targets: RunningCli[]): Promise<void> {
    if (targets.length === 0) return;
    const [only] = targets;
    const running = targets.filter((row) => !row.ended).length;
    const confirmed = await confirmDialog(
      targets.length === 1 && only
        ? {
            title: only.ended ? `Close ${only.title}?` : `End ${only.title}?`,
            description: only.ended
              ? 'Its shell has already ended. This removes the tab.'
              : 'This ends the shell and everything running in it, including any agent. Work the agent has not saved is lost.',
            confirmLabel: only.ended ? 'Close tab' : 'End session',
            variant: 'destructive',
          }
        : {
            title: `End ${targets.length} terminals?`,
            description:
              running > 0
                ? `${running} of them ${running === 1 ? 'is' : 'are'} still running. Their shells and everything in them end, including any agents.`
                : 'Their shells have already ended. This removes the tabs.',
            confirmLabel: 'End selected',
            variant: 'destructive',
          },
    );
    if (!confirmed) return;
    const ids = targets.map((row) => row.id);
    markPending(ids, true);
    try {
      // Drawer tabs go together so that the runs among them ask about their Docker containers
      // once, not once each. This dialog already says "Ended N terminals", hence quiet.
      stopRuns(
        targets.filter((row) => row.source === 'drawer').map((row) => row.id),
        { quiet: true },
      );
      for (const row of targets) if (row.source !== 'drawer') endRow(row);
      setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
      toast.success(
        targets.length === 1 && only
          ? `Ended ${only.title}.`
          : `Ended ${targets.length} terminals.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not end every terminal.');
    } finally {
      markPending(ids, false);
      // The host takes a moment to reap the processes.
      setTimeout(refreshUsage, 500);
    }
  }

  async function restartRow(row: RunningCli): Promise<void> {
    if (row.source !== 'workspace' || !row.projectId) return;
    const confirmed = row.ended
      ? true
      : await confirmDialog({
          title: `Restart ${row.title}?`,
          description:
            'The shell and everything in it end, and the tab starts again with the same command.',
          confirmLabel: 'Restart',
        });
    if (!confirmed) return;
    useWorkspaceStore.getState().restartTab(row.projectId, row.id);
    setTimeout(refreshUsage, 1000);
  }

  function openRow(row: RunningCli): void {
    setOpen(false);
    if (row.source === 'workspace' && row.projectId) {
      void navigate(`/workspace/${row.projectId}?session=${encodeURIComponent(row.id)}`);
      return;
    }
    const terminals = useTerminalStore.getState();
    terminals.setActiveSession(row.id);
    terminals.openDrawer();
  }

  const statusFor = (row: RunningCli): AgentStatus | undefined =>
    row.source === 'workspace' && row.cliId ? (statuses[row.id] ?? 'idle') : undefined;

  const updatedLabel = usageQuery.dataUpdatedAt
    ? `Updated ${timeAgo(new Date(usageQuery.dataUpdatedAt).toISOString())}`
    : 'Reading usage…';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="flex h-[min(46rem,88vh)] max-w-4xl flex-col gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          // Radix would focus the first button, which pops its tooltip on open.
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        {/* Header. Right padding leaves room for the dialog's own close button. */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border/70 py-3.5 pl-5 pr-14">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base">Running CLIs</DialogTitle>
            <DialogDescription className="sr-only">
              Every terminal across your workspaces with the CPU and memory it is using.
            </DialogDescription>
          </div>
          <span className="text-xs text-muted-foreground">{updatedLabel}</span>
          <span className="text-xs font-semibold tabular-nums">{selected.size} selected</span>
          <Button
            type="button"
            variant="destructive"
            disabled={selected.size === 0}
            onClick={() => void endRows(rows.filter((row) => selected.has(row.id)))}
          >
            <Trash2 className="h-3.5 w-3.5" />
            End selected
          </Button>
          <SimpleTooltip label="Refresh now">
            <Button
              type="button"
              variant="soft"
              size="icon"
              aria-label="Refresh now"
              onClick={refreshUsage}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', usageQuery.isFetching && 'animate-spin')} />
            </Button>
          </SimpleTooltip>
        </div>

        {/* Totals strip. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border/70 px-5 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">Resource usage</p>
              <p className="text-xs text-muted-foreground">
                {statsAvailable
                  ? 'Each terminal counts its shell and every process it started, agent CLIs included.'
                  : "Couldn't read process usage on this system. Terminals are still listed."}
              </p>
            </div>
          </div>
          {statsAvailable ? (
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5">
                <Cpu className="h-3 w-3 text-muted-foreground" />
                {statsLoading || cpuLoading ? (
                  <Skeleton className="h-4 w-10" />
                ) : (
                  <span className="font-semibold tabular-nums">{formatPercent(totals.cpu)}</span>
                )}
                <span className="text-muted-foreground">CPU</span>
              </span>
              <span className="flex items-center gap-1.5">
                <MemoryStick className="h-3 w-3 text-muted-foreground" />
                {statsLoading ? (
                  <Skeleton className="h-4 w-14" />
                ) : (
                  <span className="font-semibold tabular-nums">{formatBytes(totals.mem)}</span>
                )}
                <span className="text-muted-foreground">RAM</span>
              </span>
              <span className="text-muted-foreground tabular-nums">
                {statsLoading ? '…' : totals.running} running
              </span>
            </div>
          ) : null}
        </div>

        {/* Search and filters. */}
        <div className="flex items-center gap-2 px-4 pt-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, project, CLI, folder, process"
              className="h-9 pl-9 pr-8"
            />
            {search ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => setSearch('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2"
              >
                <X />
              </Button>
            ) : null}
          </div>
          <FiltersPopover filters={filters} onChange={setFilters} hiddenCount={hiddenFilters} />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            Showing {visible.length} of {rows.length}
          </span>
        </div>

        {/* Select all and sort. */}
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={allSelected ? true : selectedVisible.length > 0 ? 'indeterminate' : false}
              disabled={visible.length === 0}
              onCheckedChange={() =>
                setSelected((current) => {
                  const next = new Set(current);
                  for (const id of visibleIds) {
                    if (allSelected) next.delete(id);
                    else next.add(id);
                  }
                  return next;
                })
              }
            />
            Select all {visible.length} {visible.length === 1 ? 'terminal' : 'terminals'}
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="gap-1.5">
                <ChevronsUpDown className="h-3 w-3" />
                Sort by {SORT_LABEL[sort.key]}
                {sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
                <DropdownMenuItem
                  key={key}
                  onSelect={() =>
                    setSort((current) =>
                      current.key === key
                        ? { key, desc: !current.desc }
                        : { key, desc: DEFAULT_DESC[key] },
                    )
                  }
                  className="justify-between text-xs"
                >
                  {SORT_LABEL[key]}
                  {sort.key === key ? (
                    sort.desc ? (
                      <ArrowDown className="h-3 w-3" />
                    ) : (
                      <ArrowUp className="h-3 w-3" />
                    )
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {rows.length === 0 && statsLoading ? (
            <div className="divide-y divide-border/50">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="h-[18px] w-[18px] rounded-[5px]" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-6 w-20 rounded-full" />
                  <Skeleton className="h-6 w-16 rounded-full" />
                  <Skeleton className="h-6 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              No terminals are open. Start an agent in the Workspace or open the terminal drawer.
            </p>
          ) : visible.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              No terminals match your search or filters.
            </p>
          ) : (
            <div className="divide-y divide-border/50">
              {visible.map((row) => (
                <RunningCliRow
                  key={row.id}
                  row={row}
                  projectName={projectName(row.projectId)}
                  status={statusFor(row)}
                  statsLoading={statsLoading}
                  cpuLoading={cpuLoading}
                  statsAvailable={statsAvailable}
                  selected={selected.has(row.id)}
                  expanded={expanded.has(row.id)}
                  pending={pending.has(row.id)}
                  onSelectedChange={(value) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (value) next.add(row.id);
                      else next.delete(row.id);
                      return next;
                    })
                  }
                  onToggleExpanded={() => setExpanded((current) => toggled(current, row.id))}
                  onOpen={row.source === 'detached' ? undefined : () => openRow(row)}
                  onRestart={row.source === 'workspace' ? () => void restartRow(row) : undefined}
                  onEnd={() => void endRows([row])}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function FilterOption({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors hover:bg-foreground/[0.07]">
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      {children}
    </label>
  );
}

function FiltersPopover({
  filters,
  onChange,
  hiddenCount,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
  hiddenCount: number;
}): React.JSX.Element {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="soft"
          size="sm"
          // A filtered list tints the trigger, so it reads as on next to the plain search field.
          className={cn('h-9 gap-1.5', hiddenCount > 0 && 'text-primary hover:text-primary')}
        >
          <Filter className="h-3 w-3" />
          Filters
          {hiddenCount > 0 ? (
            <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground tabular-nums">
              {hiddenCount}
            </span>
          ) : null}
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            OVERLAY_SURFACE,
            OVERLAY_MOTION,
            'z-50 w-56 p-1 origin-[var(--radix-popover-content-transform-origin)]',
          )}
        >
          <p className={MENU_LABEL}>Where</p>
          {ALL_SOURCES.map((source) => (
            <FilterOption
              key={source}
              checked={filters.sources.has(source)}
              onToggle={() => onChange({ ...filters, sources: toggled(filters.sources, source) })}
            >
              {SOURCE_LABEL[source]}
            </FilterOption>
          ))}
          <p className={MENU_LABEL}>Kind</p>
          <FilterOption
            checked={filters.kinds.has('agent')}
            onToggle={() => onChange({ ...filters, kinds: toggled(filters.kinds, 'agent') })}
          >
            Agent CLIs
          </FilterOption>
          <FilterOption
            checked={filters.kinds.has('shell')}
            onToggle={() => onChange({ ...filters, kinds: toggled(filters.kinds, 'shell') })}
          >
            Plain shells
          </FilterOption>
          <p className={MENU_LABEL}>State</p>
          <FilterOption
            checked={filters.states.has('running')}
            onToggle={() => onChange({ ...filters, states: toggled(filters.states, 'running') })}
          >
            Running
          </FilterOption>
          <FilterOption
            checked={filters.states.has('ended')}
            onToggle={() => onChange({ ...filters, states: toggled(filters.states, 'ended') })}
          >
            Shell ended
          </FilterOption>
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => onChange(allFilters())}
              className="mt-2 w-full rounded-md border-t border-border/60 px-2 pt-2 text-left text-xs text-primary hover:underline"
            >
              Show everything
            </button>
          ) : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
