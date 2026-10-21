import {
  type AgentStatus,
  bootStageLabel,
  type KeepAwakeMode,
  type Project,
  type SubscriptionWindow,
} from '@agentmat/core';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { KeepAwakeStatus } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CliLogo } from '@/components/cliLogos';
import { SparklineChart } from '@/components/dashboard/SparklineChart';
import {
  Android,
  Check,
  CircleInfo,
  Copy,
  Cpu,
  Docker,
  Globe,
  MemoryStick,
  MugHot,
  Pause,
  Play,
  RefreshCw,
  Smartphone,
  Spinner,
  StopCircle,
  TerminalSquare,
  TriangleAlert,
  Wifi,
} from '@/components/icons';
import { ProviderLogo } from '@/components/providerLogos';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { AGENT_STATUS_LABEL, AgentStatusDot } from '@/components/workspace/AgentStatusDot';
import { useAutoPauseRunsSetting } from '@/hooks/useAutoPauseRunsSetting';
import { useRefreshProviderUsage } from '@/hooks/useRefreshProviderUsage';
import { isPausable, type RunRow, useRunRows } from '@/hooks/useRunRows';
import { useSystemStatsHistory } from '@/hooks/useSystemStatsHistory';
import { formatBytes as formatMemory, formatPercent } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { buildLimitChips, type LimitChip } from '@/lib/statusBarLimits';
import { timeAgo } from '@/lib/time';
import { formatCountdown } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useRunningClisStore } from '@/stores/runningClisStore';
import { pauseRuns, resumeRuns, togglePauseRun, useRunPauseStore } from '@/stores/runPauseStore';
import { stopRun } from '@/stores/runSessionStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { terminalTabLabel, useWorkspaceStore } from '@/stores/workspaceStore';
import { GithubAccountSegment } from './GithubAccountSegment';
import { SftpTransfersSegment } from './SftpTransfersSegment';
import { focusPanel, PANEL_SURFACE, PanelTitle, PopSegment, segmentClass } from './statusBarKit';

/** Sampling shells out to the OS, so the status bar asks less often than the dashboard. */
const SAMPLE_INTERVAL_MS = 4000;
const HISTORY_SAMPLES = 20;

interface AgentTab {
  id: string;
  projectId: string;
  title: string;
  cliId?: string;
}

const ATTENTION_ORDER: AgentStatus[] = ['needs-input', 'working', 'done'];

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
}

function Segment({
  children,
  tooltip,
  onClick,
  className,
}: {
  children: React.ReactNode;
  tooltip: React.ReactNode;
  onClick?: () => void;
  className?: string;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={tooltip} side="top" delayDuration={250}>
      <button
        type="button"
        onClick={onClick}
        className={cn(segmentClass, !onClick && 'cursor-default', className)}
      >
        {children}
      </button>
    </SimpleTooltip>
  );
}

/** A thin meter under a number, filled to `percent`. */
function Meter({ percent }: { percent: number }): React.JSX.Element {
  const tone = percent >= 90 ? 'bg-destructive' : percent >= 70 ? 'bg-warning' : 'bg-primary';
  return (
    <span className="relative h-1 w-8 overflow-hidden rounded-full bg-foreground/10">
      <span
        className={cn(
          'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500',
          tone,
        )}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </span>
  );
}

function AgentSegments(): React.JSX.Element {
  const navigate = useNavigate();
  // The selector returns a string so an unrelated store update does not re-render the bar; a
  // fresh array of fresh objects would never compare equal and would loop.
  const signature = useWorkspaceStore((s) =>
    JSON.stringify(
      Object.entries(s.workspaces).flatMap(([projectId, ws]) =>
        Object.values(ws.tabs).flatMap((tab) =>
          tab.kind === 'terminal' && tab.cliId
            ? [[tab.id, projectId, terminalTabLabel(tab), tab.cliId]]
            : [],
        ),
      ),
    ),
  );
  const tabs = useMemo<AgentTab[]>(
    () =>
      (JSON.parse(signature) as string[][]).map(([id, projectId, title, cliId]) => ({
        id,
        projectId,
        title,
        cliId,
      })),
    [signature],
  );
  const statuses = useAgentStatusStore((s) => s.statuses);
  const projectsQuery = useQuery<Project[]>({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
  });
  const projectName = (id: string): string =>
    projectsQuery.data?.find((p) => p.id === id)?.name ?? 'Project';

  const live = tabs.filter((tab) => statuses[tab.id] !== 'exited');
  if (live.length === 0) {
    return (
      <Segment tooltip="Open the Workspace to run agents" onClick={() => navigate('/workspace')}>
        <span className="h-1.5 w-1.5 rounded-full bg-foreground/25" />
        No agents running
      </Segment>
    );
  }

  const groups = ATTENTION_ORDER.map((status) => ({
    status,
    tabs: live.filter((tab) => (statuses[tab.id] ?? 'idle') === status),
  })).filter((group) => group.tabs.length > 0);
  const idle = live.filter((tab) => (statuses[tab.id] ?? 'idle') === 'idle');

  const open = (tab: AgentTab): void => {
    void navigate(`/workspace/${tab.projectId}?session=${encodeURIComponent(tab.id)}`);
  };

  /** Each agent is its own row: clicking one opens that tab. */
  const list = (items: AgentTab[], status: AgentStatus): React.ReactNode => (
    <div className="-mx-1 flex flex-col">
      {items.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => open(tab)}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <AgentStatusDot status={status} className="shrink-0 scale-90" />
          {tab.cliId ? <CliLogo cliId={tab.cliId} className="h-3 w-3 shrink-0" /> : null}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{tab.title}</span>
          <span className="shrink-0 truncate text-[10px] text-muted-foreground">
            {projectName(tab.projectId)}
          </span>
        </button>
      ))}
    </div>
  );

  const noun = (status: AgentStatus, count: number): string => {
    if (status === 'needs-input') return `${count} waiting on you`;
    if (status === 'working') return `${count} working`;
    return `${count} finished`;
  };

  return (
    <>
      {groups.map((group) => (
        <PopSegment
          key={group.status}
          label={`${AGENT_STATUS_LABEL[group.status]}: ${noun(group.status, group.tabs.length)}`}
          className={cn(group.status === 'needs-input' && 'text-warning hover:text-warning')}
          width="w-80"
          panel={
            <>
              <PanelTitle title={AGENT_STATUS_LABEL[group.status]} detail="Click one to open it" />
              {list(group.tabs, group.status)}
            </>
          }
        >
          <AgentStatusDot status={group.status} className="scale-90" />
          {noun(group.status, group.tabs.length)}
        </PopSegment>
      ))}
      {idle.length > 0 ? (
        <PopSegment
          label={`${idle.length} idle agent${idle.length === 1 ? '' : 's'}`}
          width="w-80"
          panel={
            <>
              <PanelTitle title="Idle" detail="Click one to open it" />
              {list(idle, 'idle')}
            </>
          }
        >
          <span className="h-1.5 w-1.5 rounded-full bg-foreground/30" />
          {idle.length} idle
        </PopSegment>
      ) : null}
    </>
  );
}

/** The window that rolls over next, falling back to the first when none has a reset time. */
function soonestWindow(windows: SubscriptionWindow[]): SubscriptionWindow | undefined {
  return (
    [...windows]
      .filter((w) => w.resetAt)
      .sort((a, b) => Date.parse(a.resetAt ?? '') - Date.parse(b.resetAt ?? ''))[0] ?? windows[0]
  );
}

// The countdowns and the "Updated 3m ago" line are worked out at render, so they are redrawn on
// this beat as well as when new numbers arrive. Without it they freeze at whatever they said last.
const LIMIT_CLOCK_MS = 30_000;

/**
 * One provider's item in the bar: the limit that resets soonest, a countdown to it and the panel
 * behind it. A read that failed keeps the item. With its last limits it dims and carries a warning,
 * and with none it shows only the warning, so its refresh button stays one click away. Numbers
 * estimated from local logs are marked with a "~" and say so in the panel.
 */
function ProviderLimitSegment({ chip }: { chip: LimitChip }): React.JSX.Element {
  const navigate = useNavigate();
  const refresh = useRefreshProviderUsage(chip.providerId);
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LIMIT_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const next = soonestWindow(chip.windows);
  const countdown = formatCountdown(next?.resetAt);
  const pending = refresh.isPending;
  const refreshLabel = `Refresh ${chip.name} usage`;
  const asOf = chip.asOf && !Number.isNaN(Date.parse(chip.asOf)) ? timeAgo(chip.asOf) : null;
  const openUsage = (): void => {
    void navigate(`/usage?provider=${encodeURIComponent(chip.providerId)}`);
  };
  // A press while a refresh runs is ignored, so it cannot start a second one.
  const runRefresh = (): void => {
    if (!pending) refresh.mutate();
  };
  const estimated = chip.state === 'estimate';
  const qualifier = {
    ok: '',
    estimate: ', estimated from local logs',
    stale: ', may be out of date',
    unavailable: '',
  };
  const label = next
    ? `${chip.name}: ${next.label} limit${qualifier[chip.state]}`
    : `${chip.name}: usage unavailable`;
  const asOfPrefix = { ok: 'Updated', estimate: 'Estimated', stale: 'Last read', unavailable: '' };

  return (
    <PopSegment
      label={label}
      width="w-80"
      onOpenAutoFocus={focusPanel}
      className={cn(
        chip.state === 'stale' && 'opacity-60',
        chip.state === 'unavailable' && 'text-warning hover:text-warning',
      )}
      panel={
        <>
          <PanelTitle
            title={chip.name}
            detail={chip.plan}
            action={
              <SimpleTooltip label={refreshLabel} side="top">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={refreshLabel}
                  // aria-disabled rather than disabled, so focus stays on the button while it works.
                  aria-disabled={pending}
                  aria-busy={pending}
                  onClick={runRefresh}
                  className="shrink-0"
                >
                  <RefreshCw className={cn(pending && 'motion-safe:animate-spin')} />
                </Button>
              </SimpleTooltip>
            }
          />
          {estimated ? (
            <p className="mb-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
              <CircleInfo className="mt-px h-3 w-3 shrink-0" />
              <span>Estimated from local logs: {chip.problem}.</span>
            </p>
          ) : chip.state !== 'ok' ? (
            <p className="mb-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
              <TriangleAlert className="mt-px h-3 w-3 shrink-0 text-warning" />
              <span>
                {chip.state === 'stale' ? "Couldn't refresh: " : "Couldn't load usage: "}
                {chip.problem}
              </span>
            </p>
          ) : null}
          {chip.windows.length > 0 ? (
            <div className="flex flex-col gap-1">
              {chip.windows.map((w) => (
                <span key={w.key} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate text-[10px] text-muted-foreground">
                    {w.label}
                  </span>
                  <Meter percent={w.percent} />
                  <span className="w-8 shrink-0 text-right text-[10px] tabular-nums">
                    {estimated ? '~' : ''}
                    {Math.round(w.percent)}%
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground">
                    {formatCountdown(w.resetAt) ?? 'no reset time'}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
            <PopoverPrimitive.Close asChild>
              <button type="button" onClick={openUsage} className="text-left hover:text-foreground">
                Open Token Usage
              </button>
            </PopoverPrimitive.Close>
            {asOf ? (
              <span className="tabular-nums">
                {asOfPrefix[chip.state]} {asOf}
              </span>
            ) : null}
          </div>
        </>
      }
    >
      <ProviderLogo providerId={chip.providerId} className="h-3 w-3 shrink-0" />
      {next ? (
        <>
          <span className="tabular-nums">
            {estimated ? '~' : ''}
            {Math.round(next.percent)}%
          </span>
          {countdown ? (
            <span className="tabular-nums text-muted-foreground/80">{countdown}</span>
          ) : null}
        </>
      ) : null}
      {chip.state === 'stale' || chip.state === 'unavailable' ? (
        <TriangleAlert className="h-3 w-3 shrink-0" />
      ) : null}
    </PopSegment>
  );
}

/**
 * One item per AI subscription with limits to show, or a warning when its read failed, in a fixed
 * order, minus any the user switched off in Settings. A provider with nothing to count down to (an
 * unlimited Cursor plan, Codex on an API key) stays out of the bar.
 */
function UsageLimitSegments(): React.JSX.Element {
  const usageQuery = useQuery({
    queryKey: queryKeys.usageList,
    queryFn: () => window.agentmat.usage.list(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    meta: { silentLoading: true },
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.agentmat.settings.get(),
    meta: { silentLoading: true },
  });
  // Until settings load every provider counts as on, so the bar does not flash empty.
  const chips = buildLimitChips(usageQuery.data, settingsQuery.data?.statusBarUsage);

  return (
    <>
      {chips.map((chip) => (
        <ProviderLimitSegment key={chip.providerId} chip={chip} />
      ))}
    </>
  );
}

/** The container count in the bottom bar: hidden entirely when Docker isn't on this machine. */
function DockerSegment(): React.JSX.Element | null {
  const navigate = useNavigate();
  const availabilityQuery = useQuery({
    queryKey: queryKeys.dockerAvailability,
    queryFn: () => window.agentmat.docker.availability(),
    meta: { silentLoading: true },
  });
  const available = availabilityQuery.data;
  const listQuery = useQuery({
    queryKey: queryKeys.dockerList,
    queryFn: () => window.agentmat.docker.list(),
    enabled: available === true,
    refetchInterval: available === true ? SAMPLE_INTERVAL_MS : false,
    meta: { silentLoading: true },
  });

  if (available !== true) return null;

  const containers = listQuery.data ?? [];
  const running = containers.filter((c) => c.state === 'running');

  return (
    <PopSegment
      label={`Docker: ${running.length} container${running.length === 1 ? '' : 's'} running`}
      width="w-80"
      panel={
        <>
          <PanelTitle title="Docker" detail={`${running.length} of ${containers.length} running`} />
          {running.length > 0 ? (
            <div className="-mx-1 flex flex-col">
              {running.slice(0, 8).map((container) => (
                <PopoverPrimitive.Close key={container.id} asChild>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/docker?container=${encodeURIComponent(container.id)}`)
                    }
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {container.name}
                    </span>
                    {container.cpuPercent != null ? (
                      <>
                        <Meter percent={container.cpuPercent} />
                        <span className="w-8 shrink-0 text-right text-[10px] tabular-nums">
                          {Math.round(container.cpuPercent)}%
                        </span>
                      </>
                    ) : null}
                  </button>
                </PopoverPrimitive.Close>
              ))}
              {running.length > 8 ? (
                <p className="px-2 py-1 text-[10px] text-muted-foreground">
                  and {running.length - 8} more
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">No containers running right now.</p>
          )}
          <PopoverPrimitive.Close asChild>
            <button
              type="button"
              onClick={() => navigate('/docker')}
              className="mt-2 w-full border-t border-border/60 pt-2 text-left text-[10px] text-muted-foreground hover:text-foreground"
            >
              Open the Docker page
            </button>
          </PopoverPrimitive.Close>
        </>
      }
    >
      <Docker className="h-2.5 w-2.5" />
      <span className="tabular-nums">{running.length} running</span>
    </PopSegment>
  );
}

/**
 * Running emulators in the bottom bar, so what is up is visible from any page. Hidden entirely
 * when there is no Android SDK on this machine, the way Docker's entry is.
 *
 * Usage is sampled only while the panel is open. The bar is always on screen, and the sampler
 * behind those numbers is a process-tree scan that costs real time on Windows.
 */
function AndroidSegment(): React.JSX.Element | null {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const sdkQuery = useQuery({
    queryKey: queryKeys.androidSdk,
    queryFn: () => window.agentmat.android.sdk(),
    meta: { silentLoading: true },
  });
  const available = sdkQuery.data?.status === 'found';

  const snapshotQuery = useQuery({
    queryKey: queryKeys.androidSnapshot,
    queryFn: () => window.agentmat.android.refresh(),
    enabled: available,
    refetchInterval: available ? SAMPLE_INTERVAL_MS : false,
    meta: { silentLoading: true },
  });

  useEffect(() => {
    if (!open) return;
    void window.agentmat.android.watchUsage(true);
    return () => {
      void window.agentmat.android.watchUsage(false);
    };
  }, [open]);

  if (!available) return null;

  const emulators = snapshotQuery.data?.emulators ?? [];
  const running = emulators.filter((emulator) => emulator.state === 'running');
  const booting = emulators.filter((emulator) =>
    ['launching', 'connecting', 'booting', 'finishing'].includes(emulator.state),
  );

  const go = (serial: string | null): void => {
    void navigate(serial ? `/android?device=${encodeURIComponent(serial)}` : '/android');
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <SimpleTooltip
        label={open ? null : `Android: ${running.length} running`}
        side="top"
        delayDuration={250}
      >
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={`Android: ${running.length} emulator${running.length === 1 ? '' : 's'} running`}
            className={segmentClass}
          >
            <Android className="h-2.5 w-2.5" />
            <span className="tabular-nums">{running.length} running</span>
            {booting.length > 0 ? (
              <span className="shimmer h-1.5 w-1.5 rounded-full bg-primary/60" />
            ) : null}
          </button>
        </PopoverPrimitive.Trigger>
      </SimpleTooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={8}
          className={cn(PANEL_SURFACE, 'w-80')}
        >
          <PanelTitle title="Android" detail={`${running.length} of ${emulators.length} running`} />
          {running.length + booting.length > 0 ? (
            <div className="-mx-1 flex flex-col">
              {[...running, ...booting].slice(0, 8).map((emulator) => (
                <PopoverPrimitive.Close key={emulator.avd.name} asChild>
                  <button
                    type="button"
                    onClick={() => go(emulator.serial)}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {emulator.avd.displayName}
                    </span>
                    {emulator.state !== 'running' ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {bootStageLabel(emulator.state)}
                      </span>
                    ) : emulator.usage ? (
                      <>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {formatBytes(emulator.usage.memoryBytes)}
                        </span>
                        {emulator.usage.cpuReady ? (
                          <>
                            <Meter percent={emulator.usage.cpuPercent} />
                            <span className="w-8 shrink-0 text-right text-[10px] tabular-nums">
                              {Math.round(emulator.usage.cpuPercent)}%
                            </span>
                          </>
                        ) : (
                          // CPU is a delta between two samples, so the first tick has no rate.
                          <span className="w-[4.25rem] shrink-0 text-right text-[10px] text-muted-foreground">
                            measuring
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="w-[4.25rem] shrink-0 text-right text-[10px] text-muted-foreground">
                        measuring
                      </span>
                    )}
                  </button>
                </PopoverPrimitive.Close>
              ))}
              {running.length + booting.length > 8 ? (
                <p className="px-2 py-1 text-[10px] text-muted-foreground">
                  and {running.length + booting.length - 8} more
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">No emulators running right now.</p>
          )}
          <PopoverPrimitive.Close asChild>
            <button
              type="button"
              onClick={() => go(null)}
              className="mt-2 w-full border-t border-border/60 pt-2 text-left text-[10px] text-muted-foreground hover:text-foreground"
            >
              Open the Android page
            </button>
          </PopoverPrimitive.Close>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function CoreBars({ percents }: { percents: number[] }): React.JSX.Element {
  return (
    <div className="mt-2 grid grid-cols-8 gap-1">
      {percents.map((percent, index) => (
        <span key={index} className="relative h-6 overflow-hidden rounded-sm bg-foreground/10">
          <span
            className={cn(
              'absolute inset-x-0 bottom-0 rounded-sm transition-[height] duration-500',
              percent >= 90 ? 'bg-destructive' : percent >= 70 ? 'bg-warning' : 'bg-primary',
            )}
            style={{ height: `${Math.min(100, Math.max(3, percent))}%` }}
          />
        </span>
      ))}
    </div>
  );
}

/** The apps using the most of one resource right now, asked for only while a panel is open. */
function TopApps({ resource }: { resource: 'cpu' | 'memory' }): React.JSX.Element | null {
  const top = useQuery({
    queryKey: queryKeys.topResourceApps(resource),
    queryFn: () => window.agentmat.system.topApps(resource),
    refetchInterval: 5000,
    meta: { silentLoading: true },
  });
  const apps = (top.data?.apps ?? []).slice(0, 5);
  if (top.isPending) {
    return (
      <div className="mt-3 space-y-1.5">
        {Array.from({ length: 3 }, (_, i) => (
          <span
            key={i}
            className="shimmer block h-3 rounded"
            style={{ width: `${80 - i * 15}%` }}
          />
        ))}
      </div>
    );
  }
  if (apps.length === 0) return null;
  return (
    <div className="mt-3 space-y-1">
      <p className="text-[10px] font-medium text-muted-foreground">
        {resource === 'cpu' ? 'Busiest apps' : 'Heaviest apps'}
      </p>
      {apps.map((app) => (
        <div key={`${app.name}:${app.pid}`} className="flex items-center gap-2">
          {app.iconDataUrl ? (
            <img src={app.iconDataUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0 rounded-sm bg-foreground/10" />
          )}
          <span className="min-w-0 flex-1 truncate text-[11px]">{app.name}</span>
          {resource === 'memory' && app.memBytes ? (
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {formatBytes(app.memBytes)}
            </span>
          ) : null}
          <Meter percent={app.percent} />
          <span className="w-8 shrink-0 text-right text-[10px] tabular-nums">
            {Math.round(app.percent)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function SystemSegments(): React.JSX.Element {
  const history = useSystemStatsHistory({
    intervalMs: SAMPLE_INTERVAL_MS,
    maxSamples: HISTORY_SAMPLES,
  });
  const latest = history.at(-1);

  if (!latest) {
    return (
      <span className="flex items-center gap-3 px-2">
        <span className="shimmer h-2 w-14 rounded" />
        <span className="shimmer h-2 w-16 rounded" />
        <span className="shimmer h-2 w-12 rounded" />
      </span>
    );
  }

  const timestamps = history.map((sample) => sample.timestamp);
  const pings = latest.pings ?? [];
  const alive = pings.filter((p) => p.alive);
  const latencies = alive.flatMap((p) => (p.latencyMs == null ? [] : [p.latencyMs]));
  const latency = latencies.length ? Math.round(Math.min(...latencies)) : null;
  // Quality over the recent window, so one dropped ping does not flash the bar red.
  const recent = history.flatMap((sample) => sample.pings ?? []);
  const quality = recent.length ? recent.filter((p) => p.alive).length / recent.length : 1;
  const online = pings.length === 0 || alive.length > 0;
  // Plenty of networks drop ping while the connection works, so no replies only reads as
  // offline when the OS agrees.
  const offline = !online && !navigator.onLine;
  const netTone = offline
    ? 'text-destructive'
    : !online || quality < 0.8 || (latency ?? 0) > 250
      ? 'text-warning'
      : 'text-success';

  return (
    <>
      <PopSegment
        label="CPU"
        width="w-80"
        panel={
          <>
            <PanelTitle
              title={`CPU ${Math.round(latest.cpuPercent)}%`}
              detail={`${latest.cpuCoreCount} threads`}
            />
            <p className="mb-1 truncate text-[10px] text-muted-foreground">{latest.cpuModel}</p>
            <SparklineChart
              timestamps={timestamps}
              series={[
                {
                  key: 'cpu',
                  label: 'CPU',
                  color: 'hsl(var(--primary))',
                  values: history.map((s) => s.cpuPercent),
                },
              ]}
              height={64}
              domainMin={0}
              domainMax={100}
              formatValue={(value) => `${Math.round(value)}%`}
            />
            {latest.cpuCorePercents.length > 0 ? (
              <>
                <p className="mt-2 text-[10px] font-medium text-muted-foreground">Per core</p>
                <CoreBars percents={latest.cpuCorePercents} />
              </>
            ) : null}
            <TopApps resource="cpu" />
            {latest.gpus.length > 0 ? (
              <div className="mt-3 space-y-1">
                <p className="text-[10px] font-medium text-muted-foreground">GPU</p>
                {latest.gpus.map((gpu) => (
                  <div key={gpu.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11px]">{gpu.label}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {formatBytes(gpu.memUsedBytes)}
                    </span>
                    <Meter percent={gpu.percent} />
                    <span className="w-8 shrink-0 text-right text-[10px] tabular-nums">
                      {Math.round(gpu.percent)}%
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        }
      >
        <Cpu className="h-2.5 w-2.5" />
        <span className="w-8 text-right tabular-nums">{Math.round(latest.cpuPercent)}%</span>
        <Meter percent={latest.cpuPercent} />
      </PopSegment>

      <PopSegment
        label="Memory"
        width="w-80"
        panel={
          <>
            <PanelTitle
              title={`Memory ${Math.round(latest.memPercent)}%`}
              detail={`${formatBytes(latest.memUsedBytes)} of ${formatBytes(latest.memTotalBytes)}`}
            />
            <SparklineChart
              timestamps={timestamps}
              series={[
                {
                  key: 'mem',
                  label: 'Memory',
                  color: 'hsl(var(--primary))',
                  values: history.map((s) => s.memPercent),
                },
              ]}
              height={64}
              domainMin={0}
              domainMax={100}
              formatValue={(value) => `${Math.round(value)}%`}
            />
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
              {[
                ['In use', formatBytes(latest.memUsedBytes)],
                ['Free', formatBytes(latest.memTotalBytes - latest.memUsedBytes)],
                ['Total', formatBytes(latest.memTotalBytes)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md bg-foreground/[0.05] px-1.5 py-1">
                  <dt className="text-[10px] text-muted-foreground">{label}</dt>
                  <dd className="text-[11px] font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <TopApps resource="memory" />
          </>
        }
      >
        <MemoryStick className="h-2.5 w-2.5" />
        <span className="tabular-nums">
          {formatBytes(latest.memUsedBytes)}
          <span className="text-muted-foreground/60"> / {formatBytes(latest.memTotalBytes)}</span>
        </span>
        <Meter percent={latest.memPercent} />
      </PopSegment>

      <Segment
        tooltip={
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold">
              {online
                ? `Online, ${Math.round(quality * 100)}% of recent pings answered`
                : offline
                  ? 'Offline'
                  : 'Connected, but pings get no reply'}
            </span>
            {pings.some((ping) => /^https?:\/\//i.test(ping.host)) && (
              <span className="text-muted-foreground">Measured with URL requests</span>
            )}
            {pings.map((ping) => (
              <span key={ping.host} className="flex justify-between gap-4 text-muted-foreground">
                <span className="font-mono">{ping.host}</span>
                <span>{ping.alive ? `${Math.round(ping.latencyMs ?? 0)} ms` : 'no reply'}</span>
              </span>
            ))}
          </span>
        }
        className={netTone}
      >
        <Wifi className="h-2.5 w-2.5" />
        <span className="tabular-nums">
          {offline ? 'Offline' : !online ? 'No ping' : latency != null ? `${latency} ms` : 'Online'}
        </span>
      </Segment>
    </>
  );
}

const KEEP_AWAKE_OPTIONS: { mode: KeepAwakeMode; title: string; detail: string }[] = [
  { mode: 'on', title: 'On', detail: 'Keep this computer awake continuously' },
  { mode: 'agent', title: 'Agent', detail: 'Stay awake while an agent or command is running' },
  { mode: 'off', title: 'Off', detail: 'Allow normal system sleep behavior' },
];

const KEEP_AWAKE_LABEL: Record<KeepAwakeMode, string> = { on: 'On', agent: 'Agent', off: 'Off' };
const BUSY_LABEL: Record<string, string> = {
  agents: 'an agent at work',
  terminals: 'a command in a terminal',
  ssh: 'an SSH session',
  sftp: 'file transfers',
};

/** Whether the machine may sleep while AgentMate runs, and what is holding it awake. */
function KeepAwakeSegment(): React.JSX.Element | null {
  const [status, setStatus] = useState<KeepAwakeStatus | null>(null);

  useEffect(() => {
    void window.agentmat.power.keepAwakeStatus().then(setStatus);
    return window.agentmat.power.onKeepAwake(setStatus);
  }, []);

  if (!status) return null;
  const pick = (mode: KeepAwakeMode): void => {
    setStatus({ ...status, mode });
    void window.agentmat.power.setKeepAwake(mode).then(setStatus);
  };
  const why = status.busy.map((reason) => BUSY_LABEL[reason] ?? reason).join(', ');

  return (
    <PopSegment
      label="Keep computer awake"
      width="w-72"
      className={status.blocking ? 'text-foreground' : undefined}
      panel={
        <>
          <PanelTitle
            title="Keep computer awake"
            detail={status.blocking ? 'Awake now' : 'Sleep allowed'}
          />
          <div className="-mx-1 flex flex-col">
            {KEEP_AWAKE_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                onClick={() => pick(option.mode)}
                className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Check
                  className={cn(
                    'mt-0.5 h-2.5 w-2.5 shrink-0 text-primary',
                    status.mode === option.mode ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{option.title}</span>
                  <span className="block text-[10px] leading-snug text-muted-foreground">
                    {option.detail}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {status.mode === 'agent' && why ? (
            <p className="mt-2 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
              Awake for {why}.
            </p>
          ) : null}
        </>
      }
    >
      <MugHot className={cn('h-2.5 w-2.5', status.blocking && 'text-primary')} />
      <span>{KEEP_AWAKE_LABEL[status.mode]}</span>
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status.blocking ? 'bg-primary' : 'bg-foreground/25',
        )}
      />
    </PopSegment>
  );
}

/** How long a run has been going: "under a minute", "4m", "1h 12m". */
function formatRunTime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function RunStateDot({ state }: { state: RunRow['state'] }): React.JSX.Element {
  if (state === 'paused') {
    return <Pause data-state-dot="paused" className="h-2 w-2 shrink-0 text-warning" />;
  }
  return (
    <span
      data-state-dot={state}
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        state === 'running' && 'bg-success',
        state === 'starting' && 'shimmer bg-primary/60',
        state === 'idle' && 'bg-muted-foreground/50',
      )}
    />
  );
}

function portOfUrl(url: string): string | null {
  try {
    return new URL(url).port || null;
  } catch {
    return null;
  }
}

/** Where a run can be reached, in a few characters: its port, or the device it went to. */
function RunTarget({ row }: { row: RunRow }): React.JSX.Element | null {
  if (row.mobile) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <Smartphone className="h-2.5 w-2.5 shrink-0" />
        <span className="max-w-[8rem] truncate">{row.device?.name ?? 'waiting for device'}</span>
      </span>
    );
  }
  const ports = row.urls.map(portOfUrl).filter((port): port is string => port !== null);
  if (ports.length === 0) return null;
  return (
    <span className="flex items-center gap-1 tabular-nums">
      <Globe className="h-2.5 w-2.5 shrink-0" />:{ports[0]}
      {ports.length > 1 ? <span className="text-muted-foreground">+{ports.length - 1}</span> : null}
    </span>
  );
}

const RUN_STATE_LABEL: Record<RunRow['state'], string> = {
  starting: 'starting',
  running: 'running',
  idle: 'finished, the shell is still open',
  paused: 'paused, using no CPU',
};

function runStateLabel(row: RunRow): string {
  if (row.state === 'paused' && row.pause?.reason === 'agent') {
    return 'paused while an agent works';
  }
  return RUN_STATE_LABEL[row.state];
}

/** Pause or Resume for one run, showing the change while main makes it. */
function PauseRunButton({
  row,
  pauseLabel,
}: {
  row: RunRow;
  pauseLabel: string | null;
}): React.JSX.Element {
  const pending = useRunPauseStore((s) => s.pending[row.session.id] ?? null);
  const paused = row.state === 'paused';
  const verb = paused ? 'Resume' : 'Pause';
  const tip = paused
    ? 'Resume: thaw its processes, they pick up where they were'
    : 'Pause: freeze its processes so they use no CPU';
  return (
    <SimpleTooltip label={pauseLabel ? `${tip} (${pauseLabel})` : tip} side="top">
      <Button
        variant="soft"
        size="xs"
        aria-label={`${verb} ${row.session.run.label}`}
        disabled={pending !== null}
        onClick={() => void togglePauseRun(row.session.id)}
      >
        {pending ? <Spinner className="motion-safe:animate-spin" /> : paused ? <Play /> : <Pause />}
        {pending === 'pausing' ? 'Pausing' : pending === 'resuming' ? 'Resuming' : verb}
      </Button>
    </SimpleTooltip>
  );
}

function RunDetail({
  row,
  stopLabel,
  pauseLabel,
}: {
  row: RunRow;
  stopLabel: string | null;
  pauseLabel: string | null;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { session, status, urls, device } = row;
  const openTerminal = (): void => {
    const terminal = useTerminalStore.getState();
    terminal.setActiveSession(session.id);
    terminal.openDrawer();
  };

  return (
    <div className="flex flex-col gap-1.5 px-2 py-2">
      <div className="flex items-center gap-2">
        <RunStateDot state={row.state} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{session.title}</span>
        <SimpleTooltip label="Show terminal" side="top">
          <PopoverPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Show terminal"
              onClick={openTerminal}
            >
              <TerminalSquare />
            </Button>
          </PopoverPrimitive.Close>
        </SimpleTooltip>
        {isPausable(row) ? <PauseRunButton row={row} pauseLabel={pauseLabel} /> : null}
        <SimpleTooltip label={stopLabel ? `Stop (${stopLabel})` : 'Stop'} side="top">
          <Button
            variant="danger"
            size="xs"
            aria-label={`Stop ${session.run.label}`}
            onClick={() => stopRun(session.id)}
          >
            <StopCircle />
            Stop
          </Button>
        </SimpleTooltip>
      </div>
      <p className="truncate text-[10px] text-muted-foreground">
        <span className="font-mono">{session.run.command}</span> · {runStateLabel(row)} ·{' '}
        {formatRunTime(Date.now() - session.run.startedAt)}
      </p>
      {status ? (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Cpu className="h-2.5 w-2.5" />
          {row.state === 'paused' ? (
            <span className="text-warning">paused</span>
          ) : row.cpuReady ? (
            <>
              <Meter percent={status.cpuPercent} />
              <span className="tabular-nums">{formatPercent(status.cpuPercent)}</span>
            </>
          ) : (
            <span>measuring</span>
          )}
          <MemoryStick className="ml-1.5 h-2.5 w-2.5" />
          <span className="tabular-nums">{formatMemory(status.memBytes)}</span>
          <span className="ml-auto tabular-nums">
            {status.processCount} {status.processCount === 1 ? 'process' : 'processes'}
          </span>
        </div>
      ) : null}
      {urls.map((url) => (
        <div key={url} className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void window.agentmat.shell.openExternal(url)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-primary transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Globe className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{url}</span>
          </button>
          <SimpleTooltip label="Copy address" side="top">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Copy ${url}`}
              onClick={() => void navigator.clipboard.writeText(url)}
            >
              <Copy />
            </Button>
          </SimpleTooltip>
        </div>
      ))}
      {row.mobile && device?.serial ? (
        <PopoverPrimitive.Close asChild>
          <button
            type="button"
            onClick={() =>
              void navigate(`/android?device=${encodeURIComponent(device.serial ?? '')}`)
            }
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Smartphone className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{device.name}</span>
          </button>
        </PopoverPrimitive.Close>
      ) : row.mobile ? (
        <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <Smartphone className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{device?.name ?? 'Waiting for a device'}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Pause all, or Resume all once every run that can be paused is. Only for two or more. */
function PauseAllButton({ rows }: { rows: RunRow[] }): React.JSX.Element | null {
  const pending = useRunPauseStore((s) => s.pending);
  const pausable = rows.filter(isPausable);
  if (pausable.length < 2) return null;
  const running = pausable.filter((row) => row.state !== 'paused');
  const busy = pausable.some((row) => pending[row.session.id]);
  const ids = (list: RunRow[]): string[] => list.map((row) => row.session.id);
  return running.length > 0 ? (
    <Button variant="soft" size="xs" disabled={busy} onClick={() => void pauseRuns(ids(running))}>
      <Pause />
      Pause all
    </Button>
  ) : (
    <Button variant="soft" size="xs" disabled={busy} onClick={() => void resumeRuns(ids(pausable))}>
      <Play />
      Resume all
    </Button>
  );
}

function AutoPauseSwitch(): React.JSX.Element {
  const { loaded, enabled, setEnabled } = useAutoPauseRunsSetting();
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2">
      <div className="min-w-0 flex-1">
        <p id="auto-pause-runs-label" className="text-[11px] font-medium">
          Pause runs while an agent works
        </p>
        <p className="text-[10px] text-muted-foreground">
          Hot reload waits and catches up once the agent is done.
        </p>
      </div>
      <Switch
        aria-labelledby="auto-pause-runs-label"
        checked={enabled}
        disabled={!loaded}
        onCheckedChange={setEnabled}
      />
    </div>
  );
}

/**
 * The projects started with Run, and where each can be reached. One run gets its name, port or
 * device and usage right in the bar; more than one collapse into a count, so the agents on the
 * left keep their room. The panel lists every run with its own Pause and Stop buttons.
 */
function RunSegments(): React.JSX.Element | null {
  const rows = useRunRows();
  const stopLabel = useShortcutLabel('terminal.stopRun');
  const pauseLabel = useShortcutLabel('terminal.togglePauseRun');
  if (rows.length === 0) return null;

  const cpuReady = rows[0].cpuReady;
  const cpu = rows.reduce((sum, row) => sum + (row.status?.cpuPercent ?? 0), 0);
  const mem = rows.reduce((sum, row) => sum + (row.status?.memBytes ?? 0), 0);
  const single = rows.length === 1 ? rows[0] : null;
  const pausedCount = rows.filter((row) => row.state === 'paused').length;
  const allPaused = pausedCount === rows.length;

  return (
    <PopSegment
      label={
        single
          ? `${single.session.title}: ${single.session.run.label}${allPaused ? ', paused' : ''}`
          : `${rows.length} project runs${pausedCount > 0 ? `, ${pausedCount} paused` : ''}`
      }
      width="w-80"
      panel={
        <>
          <PanelTitle
            title="Runs"
            detail={
              [
                pauseLabel ? `${pauseLabel} pauses` : null,
                stopLabel ? `${stopLabel} stops the active run` : null,
              ]
                .filter(Boolean)
                .join(' · ') || null
            }
            action={<PauseAllButton rows={rows} />}
          />
          <div className="-mx-3 flex max-h-96 flex-col divide-y divide-border/60 overflow-y-auto px-1">
            {rows.map((row) => (
              <RunDetail
                key={row.session.id}
                row={row}
                stopLabel={stopLabel}
                pauseLabel={pauseLabel}
              />
            ))}
          </div>
          <AutoPauseSwitch />
        </>
      }
    >
      {single ? (
        <>
          <RunStateDot state={single.state} />
          <span className="max-w-[9rem] truncate">{single.session.title}</span>
          <RunTarget row={single} />
        </>
      ) : (
        <>
          {allPaused ? (
            <Pause className="h-2.5 w-2.5 text-warning" />
          ) : (
            <Play className="h-2.5 w-2.5" />
          )}
          <span className="tabular-nums">{rows.length} runs</span>
          {pausedCount > 0 && !allPaused ? (
            <span className="tabular-nums text-warning">{pausedCount} paused</span>
          ) : null}
        </>
      )}
      {allPaused ? (
        <span className="text-warning">paused</span>
      ) : cpuReady ? (
        <span className="tabular-nums">{formatPercent(Math.min(100, cpu))}</span>
      ) : null}
      {mem > 0 ? <span className="tabular-nums">{formatMemory(mem)}</span> : null}
    </PopSegment>
  );
}

/**
 * How many terminals are open across the Workspace and the drawer. Counting comes from the
 * stores alone; the per-terminal CPU and memory are only sampled while the modal is open.
 */
function TerminalsSegment(): React.JSX.Element | null {
  const setOpen = useRunningClisStore((s) => s.setOpen);
  const workspaceCount = useWorkspaceStore((s) =>
    Object.values(s.workspaces).reduce(
      (sum, ws) => sum + Object.values(ws.tabs).filter((tab) => tab.kind === 'terminal').length,
      0,
    ),
  );
  // A docked file manager is a drawer tab but not a terminal.
  const drawerCount = useTerminalStore(
    (s) => s.sessions.filter((session) => session.kind !== 'sftp').length,
  );
  const count = workspaceCount + drawerCount;
  if (count === 0) return null;
  return (
    <Segment
      tooltip="Running CLIs: CPU and memory for every terminal"
      onClick={() => setOpen(true)}
    >
      <TerminalSquare className="h-2.5 w-2.5" />
      <span className="tabular-nums">
        {count} {count === 1 ? 'terminal' : 'terminals'}
      </span>
    </Segment>
  );
}

/** The strip along the bottom of the window: agents on the left, the machine on the right. */
export function StatusBar(): React.JSX.Element {
  return (
    <footer
      aria-label="Status bar"
      className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border/70 bg-card/40 px-1 text-[11px] text-muted-foreground glass:border-t-0 glass:bg-transparent"
    >
      <div className="flex h-full min-w-0 items-center overflow-hidden">
        <AgentSegments />
      </div>
      <div className="flex h-full shrink-0 items-center">
        <RunSegments />
        <SftpTransfersSegment />
        <TerminalsSegment />
        <UsageLimitSegments />
        <GithubAccountSegment />
        <DockerSegment />
        <AndroidSegment />
        <SystemSegments />
        <KeepAwakeSegment />
      </div>
    </footer>
  );
}
