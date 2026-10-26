import { type AgentStatus, getCliDefinition } from '@runova/core';
import type { TerminalSessionUsage } from '@shared/apiTypes';
import { CliLogo } from '@/components/cliLogos';
import {
  ChevronDown,
  Clock,
  Cpu,
  ExternalLink,
  MemoryStick,
  Monitor,
  RefreshCw,
  Server,
  TerminalSquare,
  Trash2,
  Workspace,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { AGENT_STATUS_LABEL, AgentStatusDot } from '@/components/workspace/AgentStatusDot';
import { formatBytes, formatPercent } from '@/lib/format';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';

/** Where a terminal lives in the app. Detached means the shell runs with no tab showing it. */
export type RunningCliSource = 'workspace' | 'drawer' | 'ssh' | 'detached';

export const SOURCE_LABEL: Record<RunningCliSource, string> = {
  workspace: 'Workspace',
  drawer: 'Terminal drawer',
  ssh: 'SSH',
  detached: 'Detached',
};

export interface RunningCli {
  id: string;
  title: string;
  source: RunningCliSource;
  projectId?: string;
  cliId?: string;
  cwd?: string;
  shell?: string;
  /** When the tab or shell started, in ms. */
  createdAt?: number;
  /** Missing for SSH sessions, and for tabs whose shell is no longer running. */
  usage?: TerminalSessionUsage;
  /** The tab is still open but its shell has ended. */
  ended: boolean;
}

export function cliLabel(row: RunningCli): string {
  return row.cliId ? (getCliDefinition(row.cliId)?.label ?? row.cliId) : 'Shell';
}

/** CPU share at which a row's CPU pill turns amber. */
const BUSY_CPU_PERCENT = 50;

function Pill({
  icon,
  children,
  tooltip,
  className,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  tooltip?: string;
  className?: string;
}): React.JSX.Element {
  const pill = (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-foreground/[0.04] px-2 text-[11px] font-medium text-muted-foreground tabular-nums',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
  return tooltip ? <SimpleTooltip label={tooltip}>{pill}</SimpleTooltip> : pill;
}

function IconAction({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label} wrapTrigger={disabled}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(destructive && 'hover:text-destructive')}
        disabled={disabled}
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

function SourceIcon({ source }: { source: RunningCliSource }): React.JSX.Element {
  if (source === 'ssh') return <Server className="h-3 w-3" />;
  if (source === 'workspace') return <Workspace className="h-3 w-3" />;
  return <Monitor className="h-3 w-3" />;
}

export function RunningCliRow({
  row,
  projectName,
  status,
  statsLoading,
  cpuLoading,
  statsAvailable,
  selected,
  expanded,
  pending,
  onSelectedChange,
  onToggleExpanded,
  onOpen,
  onRestart,
  onEnd,
}: {
  row: RunningCli;
  projectName?: string;
  /** Only set for workspace tabs running an agent CLI. */
  status?: AgentStatus;
  /** No usage reading has arrived yet. */
  statsLoading: boolean;
  /** Memory is known but CPU still needs a second reading. */
  cpuLoading: boolean;
  statsAvailable: boolean;
  selected: boolean;
  expanded: boolean;
  pending: boolean;
  onSelectedChange: (selected: boolean) => void;
  onToggleExpanded: () => void;
  onOpen?: () => void;
  onRestart?: () => void;
  onEnd: () => void;
}): React.JSX.Element {
  const { usage } = row;
  const hasStats = row.source !== 'ssh' && !row.ended && statsAvailable;
  const busy = (usage?.cpuPercent ?? 0) >= BUSY_CPU_PERCENT;
  const createdAt = usage?.createdAt ?? row.createdAt;

  return (
    <div className={cn('px-4 py-2.5 transition-colors', selected && 'bg-primary/[0.06]')}>
      <div className="flex items-start gap-3">
        <Checkbox
          className="mt-[3px]"
          checked={selected}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`Select ${row.title}`}
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="mr-1 flex min-w-0 items-center gap-2">
            {row.cliId ? (
              <CliLogo cliId={row.cliId} className="h-3.5 w-3.5" />
            ) : (
              <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <SimpleTooltip label={`${cliLabel(row)}: ${row.title}`}>
              <span
                className={cn(
                  'max-w-[16rem] truncate text-sm font-semibold',
                  row.ended && 'text-muted-foreground line-through decoration-foreground/30',
                )}
              >
                {row.title}
              </span>
            </SimpleTooltip>
          </span>

          {projectName ? (
            <Pill icon={<Workspace className="h-3 w-3" />} tooltip="Project">
              <span className="max-w-[10rem] truncate">{projectName}</span>
            </Pill>
          ) : null}
          <Pill icon={<SourceIcon source={row.source} />}>{SOURCE_LABEL[row.source]}</Pill>
          {row.ended ? (
            <Pill className="border-destructive/40 text-destructive">Shell ended</Pill>
          ) : status ? (
            <Pill
              icon={<AgentStatusDot status={status} className="scale-75" />}
              className={cn(status === 'needs-input' && 'border-warning/40 text-warning')}
            >
              {AGENT_STATUS_LABEL[status]}
            </Pill>
          ) : null}
          {createdAt ? (
            <Pill
              icon={<Clock className="h-3 w-3" />}
              tooltip={`Started ${new Date(createdAt).toLocaleString()}`}
            >
              {shortAge(createdAt)}
            </Pill>
          ) : null}

          {row.source === 'ssh' ? (
            <Pill tooltip="SSH sessions run on the remote server">Remote, no stats</Pill>
          ) : hasStats ? (
            statsLoading ? (
              <>
                <Skeleton className="h-6 w-16 rounded-full" />
                <Skeleton className="h-6 w-20 rounded-full" />
              </>
            ) : usage ? (
              <>
                {cpuLoading ? (
                  <Skeleton className="h-6 w-16 rounded-full" />
                ) : (
                  <Pill
                    icon={<Cpu className="h-3 w-3" />}
                    tooltip="CPU, share of all cores, for the shell and everything it started"
                    className={cn(busy && 'border-warning/40 text-warning')}
                  >
                    {formatPercent(usage.cpuPercent)}
                  </Pill>
                )}
                <Pill
                  icon={<MemoryStick className="h-3 w-3" />}
                  tooltip="Memory in use by the shell and everything it started"
                >
                  {formatBytes(usage.memBytes)}
                </Pill>
                {usage.processCount > 1 ? (
                  <Pill
                    icon={<TerminalSquare className="h-3 w-3" />}
                    tooltip={`${usage.processCount} processes`}
                  >
                    {usage.processCount}
                  </Pill>
                ) : null}
              </>
            ) : null
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <IconAction label={expanded ? 'Hide details' : 'Show details'} onClick={onToggleExpanded}>
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')}
            />
          </IconAction>
          {onOpen ? (
            <IconAction label="Open" onClick={onOpen}>
              <ExternalLink className="h-3.5 w-3.5" />
            </IconAction>
          ) : null}
          {onRestart ? (
            <IconAction label="Restart" onClick={onRestart} disabled={pending}>
              <RefreshCw className="h-3.5 w-3.5" />
            </IconAction>
          ) : null}
          <IconAction
            label={row.ended ? 'Close tab' : 'End session'}
            onClick={onEnd}
            disabled={pending}
            destructive
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconAction>
        </div>
      </div>

      {expanded ? <RunningCliDetails row={row} /> : null}
    </div>
  );
}

function DetailLine({
  label,
  value,
}: {
  label: string;
  value?: string | number;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono">{value ?? 'Unknown'}</dd>
    </div>
  );
}

function RunningCliDetails({ row }: { row: RunningCli }): React.JSX.Element {
  const { usage } = row;
  return (
    <div className="ml-[30px] mt-2 space-y-3 rounded-lg border border-border/60 bg-foreground/[0.03] p-3 text-xs">
      <dl className="grid gap-1.5 sm:grid-cols-2">
        <DetailLine label="Runs" value={cliLabel(row)} />
        <DetailLine label="Shell" value={row.shell} />
        <DetailLine label="Folder" value={row.cwd} />
        <DetailLine label="Shell PID" value={usage?.pid} />
        <DetailLine label="Session" value={row.id} />
      </dl>
      {usage && usage.processes.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left tabular-nums">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="py-1 pr-3 font-medium">Process</th>
                <th className="py-1 pr-3 font-medium">PID</th>
                <th className="py-1 pr-3 text-right font-medium">CPU</th>
                <th className="py-1 text-right font-medium">Memory</th>
              </tr>
            </thead>
            <tbody>
              {usage.processes.map((proc) => (
                <tr key={proc.pid} className="border-b border-border/30 last:border-0">
                  <td className="max-w-[16rem] truncate py-1 pr-3">{proc.name}</td>
                  <td className="py-1 pr-3 font-mono text-muted-foreground">{proc.pid}</td>
                  <td className="py-1 pr-3 text-right">{formatPercent(proc.cpuPercent)}</td>
                  <td className="py-1 text-right">{formatBytes(proc.memBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {usage.processCount > usage.processes.length ? (
            <p className="pt-1 text-muted-foreground">
              Showing the busiest {usage.processes.length} of {usage.processCount} processes.
            </p>
          ) : null}
        </div>
      ) : row.source === 'ssh' ? (
        <p className="text-muted-foreground">
          This session runs on the remote server, so its processes aren&apos;t visible here.
        </p>
      ) : row.ended ? (
        <p className="text-muted-foreground">The shell has ended. Close the tab or restart it.</p>
      ) : null}
    </div>
  );
}
