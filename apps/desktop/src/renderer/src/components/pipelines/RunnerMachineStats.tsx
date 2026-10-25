import type {
  RunnerMachineLink,
  RunnerMachineSample,
  RunnerMachineStatsResult,
} from '@shared/apiTypes';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CircleInfo, Lock } from '@/components/icons';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { SshVaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/** Often enough to catch a job pinning the machine, rare enough to cost nothing over SSH. */
const POLL_MS = 15_000;
/** A machine that did not answer is asked less often, so a dead one does not keep SSH busy. */
const FAILED_POLL_MS = 60_000;

const WARN_AT = 80;
const ALERT_AT = 95;

export function machineKey(link: RunnerMachineLink): string {
  return link.kind === 'local' ? 'local' : `ssh:${link.serverId}`;
}

function useRunnerMachineStats(link: RunnerMachineLink, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.runnerMachineStats(machineKey(link)),
    queryFn: async (): Promise<RunnerMachineStatsResult> => {
      try {
        return await window.agentmat.pipelines.runnerMachineStats(link);
      } catch (error) {
        return {
          ok: false,
          reason: 'unreachable',
          error: ipcErrorMessage(error, 'Could not read the machine.'),
        };
      }
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: POLL_MS - 1_000,
    refetchInterval: (query) =>
      query.state.data && !query.state.data.ok ? FAILED_POLL_MS : POLL_MS,
  });
}

function percentOf(used: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
}

function Meter({
  label,
  percent,
  detail,
}: {
  label: string;
  /** Null when the machine gave no figure. */
  percent: number | null;
  detail: string;
}): React.JSX.Element {
  const tone =
    percent === null
      ? 'bg-muted-foreground/40'
      : percent >= ALERT_AT
        ? 'bg-destructive'
        : percent >= WARN_AT
          ? 'bg-warning'
          : 'bg-primary/70';
  const shown = percent === null ? 'n/a' : `${Math.round(percent)}%`;
  return (
    <SimpleTooltip label={detail} className="whitespace-pre-line">
      {/* Focusable so keyboard users can open the details too. */}
      <span
        tabIndex={0}
        role="group"
        aria-label={`${label} ${shown}`}
        className="flex min-w-0 flex-1 cursor-default flex-col gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-baseline justify-between gap-1 text-[10px] leading-none">
          <span className="text-muted-foreground">{label}</span>
          <span
            className={cn(
              'font-medium tabular-nums',
              percent !== null && percent >= ALERT_AT
                ? 'text-destructive'
                : percent !== null && percent >= WARN_AT
                  ? 'text-warning'
                  : 'text-foreground',
            )}
          >
            {shown}
          </span>
        </span>
        <span aria-hidden className="h-1 overflow-hidden rounded-full bg-foreground/[0.08]">
          <span
            className={cn('block h-full rounded-full transition-[width] duration-500', tone)}
            style={{ width: `${percent ?? 0}%` }}
          />
        </span>
      </span>
    </SimpleTooltip>
  );
}

function cpuDetail(sample: RunnerMachineSample): string {
  const lines = [sample.cpuPercent === null ? 'The machine gave no CPU figure' : 'CPU in use'];
  if (sample.load1 !== null) {
    const cores = sample.cpuCount ? ` on ${sample.cpuCount} cores` : '';
    lines.push(`Load ${sample.load1.toFixed(2)}${cores}`);
  } else if (sample.cpuCount) {
    lines.push(`${sample.cpuCount} cores`);
  }
  return lines.join('\n');
}

function Meters({ sample }: { sample: RunnerMachineSample }): React.JSX.Element {
  return (
    <div className="flex gap-2.5">
      <Meter label="CPU" percent={sample.cpuPercent} detail={cpuDetail(sample)} />
      <Meter
        label="RAM"
        percent={percentOf(sample.memUsedBytes, sample.memTotalBytes)}
        detail={`${formatBytes(sample.memUsedBytes)} of ${formatBytes(sample.memTotalBytes)} in use`}
      />
      <Meter
        label="Disk"
        percent={percentOf(sample.diskUsedBytes, sample.diskTotalBytes)}
        detail={`${formatBytes(sample.diskUsedBytes)} of ${formatBytes(sample.diskTotalBytes)} used on ${sample.diskMount}`}
      />
    </div>
  );
}

function MetersSkeleton(): React.JSX.Element {
  return (
    <div className="flex gap-2.5" data-testid="runner-machine-loading">
      {['CPU', 'RAM', 'Disk'].map((label) => (
        <div key={label} className="flex flex-1 flex-col gap-1">
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-1 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

function Problem({
  text,
  detail,
  children,
}: {
  text: string;
  detail?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const line = (
    <span className="flex min-w-0 items-center gap-1.5">
      <CircleInfo className="h-3 w-3 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      {detail ? (
        <SimpleTooltip label={detail} className="max-w-xs">
          {/* Focusable so keyboard users can read the error too. */}
          <span
            tabIndex={0}
            className="min-w-0 cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {line}
          </span>
        </SimpleTooltip>
      ) : (
        line
      )}
      {children}
    </div>
  );
}

/**
 * CPU, memory and disk of the machine a runner is linked to, refreshed while the tile is on
 * screen. Each tile loads on its own, so a slow server never holds up the others.
 */
export function RunnerMachineStats({
  link,
  serverName,
  enabled,
  onUnlink,
}: {
  link: RunnerMachineLink;
  /** The saved server's nickname, for the "could not reach" line. */
  serverName?: string;
  /** False while the runner is offline: there is nothing to read then. */
  enabled: boolean;
  onUnlink: () => void;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const query = useRunnerMachineStats(link, enabled);

  if (!enabled) return null;
  const result = query.data;
  if (!result) return <MetersSkeleton />;
  if (result.ok) return <Meters sample={result.sample} />;

  if (result.reason === 'locked') {
    return (
      <>
        <Problem text="The Servers vault is locked">
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto h-5 shrink-0 px-1.5 [&_svg]:size-2.5"
            onClick={() => setUnlockOpen(true)}
          >
            <Lock className="h-2.5 w-2.5" />
            Unlock
          </Button>
        </Problem>
        <SshVaultUnlockDialog
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          mode="unlock"
          onUnlocked={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.sshVaultStatus });
            void queryClient.invalidateQueries({ queryKey: ['runner-machine-stats'] });
          }}
        />
      </>
    );
  }
  if (result.reason === 'missing') {
    return (
      <Problem text="The linked server was removed">
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto h-5 shrink-0 px-1.5"
          onClick={onUnlink}
        >
          Unlink
        </Button>
      </Problem>
    );
  }
  if (result.reason === 'unreachable') {
    return (
      <Problem
        text={`Could not reach ${link.kind === 'local' ? 'this computer' : (serverName ?? 'the server')}`}
        detail={result.error}
      />
    );
  }
  return <Problem text="Could not read this machine" detail={result.error} />;
}
