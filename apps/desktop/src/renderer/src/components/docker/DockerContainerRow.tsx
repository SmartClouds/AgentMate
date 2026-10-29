import type { DockerContainer } from '@shared/apiTypes';
import {
  Docker as DockerIcon,
  FileText,
  Play,
  RefreshCw,
  StopCircle,
  Trash2,
} from '@/components/icons';
import { Chip, type ChipTone, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const STATE_TONE: Record<DockerContainer['state'], ChipTone> = {
  running: 'success',
  restarting: 'warning',
  exited: 'neutral',
  dead: 'neutral',
  paused: 'neutral',
  created: 'neutral',
};

export const STATE_LABEL: Record<DockerContainer['state'], string> = {
  running: 'Running',
  restarting: 'Restarting',
  exited: 'Exited',
  dead: 'Dead',
  paused: 'Paused',
  created: 'Created',
};

function formatMem(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function UsageBar({ percent }: { percent: number }): React.JSX.Element {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-foreground/10">
      <span
        className="block h-full rounded-full bg-primary transition-[width] duration-500"
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

/**
 * One container, shared between the machine-wide Docker page and a project's Docker tab so the
 * two views can't drift apart. The `card` variant stands on its own; the `row` variant is flat,
 * for a list inside a glass card whose `.settings-rows` hairlines separate the rows.
 */
export function DockerContainerRow({
  container,
  pending,
  variant = 'card',
  focused = false,
  rowRef,
  onStart,
  onStop,
  onRestart,
  onRemove,
  onLogs,
}: {
  container: DockerContainer;
  pending: boolean;
  variant?: 'card' | 'row';
  /** True when this row was opened via a deep link (e.g. the status bar popover); rings briefly. */
  focused?: boolean;
  rowRef?: (node: HTMLDivElement | null) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRemove: () => void;
  /** Opens the container's log. Left out where there is nowhere to show it. */
  onLogs?: () => void;
}): React.JSX.Element {
  const running = container.state === 'running';
  const memPercent =
    container.memUsedBytes != null && container.memLimitBytes
      ? (container.memUsedBytes / container.memLimitBytes) * 100
      : null;
  const showUsage = running && (container.cpuPercent != null || memPercent != null);

  return (
    <div
      ref={rowRef}
      className={cn(
        'flex items-start gap-3 transition-[box-shadow,background-color]',
        variant === 'card'
          ? cn(SECTION_WELL, 'rounded-lg px-3 py-2.5')
          : 'px-3.5 py-3 hover:bg-foreground/[0.03]',
        focused &&
          (variant === 'card'
            ? 'ring-2 ring-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.15)]'
            : 'ring-2 ring-inset ring-primary'),
      )}
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
        <DockerIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <SimpleTooltip label={container.name}>
            <span className="truncate text-sm font-medium">{container.name}</span>
          </SimpleTooltip>
          <Chip tone={STATE_TONE[container.state]} dot={container.state === 'running'}>
            {STATE_LABEL[container.state]}
          </Chip>
          {container.composeProject && <Chip>{container.composeProject}</Chip>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {container.image} · {container.status}
        </div>
        {showUsage && (
          <div className="flex flex-wrap items-center gap-3 pt-0.5 text-[11px] text-muted-foreground">
            {container.cpuPercent != null && (
              <span className="flex items-center gap-1.5">
                CPU
                <UsageBar percent={container.cpuPercent} />
                <span className="w-10 shrink-0 text-right tabular-nums">
                  {container.cpuPercent.toFixed(1)}%
                </span>
              </span>
            )}
            {memPercent != null && container.memUsedBytes != null && (
              <span className="flex items-center gap-1.5">
                Mem
                <UsageBar percent={memPercent} />
                <span className="w-14 shrink-0 text-right tabular-nums">
                  {formatMem(container.memUsedBytes)}
                </span>
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Reading the log changes nothing, so it stays open while an action is under way. */}
        {onLogs && (
          <SimpleTooltip label="Logs">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Show logs of ${container.name}`}
              onClick={onLogs}
            >
              <FileText className="h-3.5 w-3.5" />
            </Button>
          </SimpleTooltip>
        )}
        {running ? (
          <SimpleTooltip label="Stop">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              aria-label={`Stop ${container.name}`}
              onClick={onStop}
            >
              <StopCircle className="h-3.5 w-3.5" />
            </Button>
          </SimpleTooltip>
        ) : (
          <SimpleTooltip label="Start">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              aria-label={`Start ${container.name}`}
              onClick={onStart}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          </SimpleTooltip>
        )}
        <SimpleTooltip label="Restart">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label={`Restart ${container.name}`}
            onClick={onRestart}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Remove">
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:bg-destructive/10 hover:text-destructive"
            disabled={pending}
            aria-label={`Remove ${container.name}`}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
      </div>
    </div>
  );
}
