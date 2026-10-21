import type { RdpLinkStats } from '@shared/apiTypes';
import { ArrowDown, ArrowUp } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatSpeed, linkQuality } from '@/lib/rdp/linkQuality';
import { cn } from '@/lib/utils';

const BAR_HEIGHTS = ['h-1', 'h-1.5', 'h-2.5', 'h-3.5'];

const LEVEL_COLOR = {
  excellent: 'bg-success',
  good: 'bg-success',
  fair: 'bg-warning',
  poor: 'bg-destructive',
} as const;

/**
 * Connection quality and speed for the session window's top bar: four signal bars from how
 * quickly the server answers, then the download and upload speed. The details are in the tooltip,
 * and the speeds drop out of the bar itself when the window is narrow.
 */
export function RdpLinkIndicator({ stats }: { stats: RdpLinkStats | null }): React.JSX.Element {
  const quality = linkQuality(stats?.latencyMs ?? null);
  const down = formatSpeed(stats?.downBytesPerSec ?? 0);
  const up = formatSpeed(stats?.upBytesPerSec ?? 0);

  const label = [
    quality && stats?.latencyMs != null
      ? `Connection quality: ${quality.label}\nThe server takes about ${stats.latencyMs} ms to react to what you do.`
      : 'Connection quality: measuring\nIt shows up once you type or click and the server answers.',
    `Download ${down}, upload ${up}`,
  ].join('\n');

  return (
    <SimpleTooltip label={label} side="bottom">
      <div
        data-testid="rdp-link-indicator"
        className="ml-2 flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground [-webkit-app-region:no-drag]"
      >
        <span
          className="flex items-end gap-0.5"
          role="img"
          aria-label={
            quality ? `Connection quality ${quality.label}` : 'Connection quality unknown'
          }
        >
          {BAR_HEIGHTS.map((height, index) => (
            <span
              key={height}
              className={cn(
                'w-[3px] rounded-[1px]',
                height,
                quality && index < quality.bars
                  ? LEVEL_COLOR[quality.level]
                  : 'bg-muted-foreground/30',
              )}
            />
          ))}
        </span>
        <span className="hidden min-w-[5.5rem] items-center gap-1 lg:inline-flex">
          <ArrowDown className="h-3 w-3 shrink-0" />
          {down}
        </span>
        <span className="hidden min-w-[5.5rem] items-center gap-1 lg:inline-flex">
          <ArrowUp className="h-3 w-3 shrink-0" />
          {up}
        </span>
      </div>
    </SimpleTooltip>
  );
}
