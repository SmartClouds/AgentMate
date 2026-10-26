import type { ResourceActivitySnapshot, ResourceUsagePoint } from '@runova/core';
import { type ReactNode, useMemo, useState } from 'react';
import { SparklineChart } from '@/components/dashboard/SparklineChart';
import { Docker, X } from '@/components/icons';
import { PillTabs, TileHeader } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useResourceActivity } from '@/hooks/useResourceActivity';
import { useChartColors } from '@/lib/chartColors';
import { formatBytes, formatPercent } from '@/lib/format';

type Metric = 'cpu' | 'memory';

const METRIC_ITEMS: { value: Metric; label: string }[] = [
  { value: 'cpu', label: 'CPU' },
  { value: 'memory', label: 'Memory' },
];

function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function pointValue(
  point: ResourceUsagePoint,
  kind: 'docker' | 'emulator',
  metric: Metric,
): number {
  if (kind === 'docker') return metric === 'cpu' ? point.dockerCpu : point.dockerMem;
  return metric === 'cpu' ? point.emulatorCpu : point.emulatorMem;
}

function emptyMessage(snapshot: ResourceActivitySnapshot): string {
  return snapshot.docker === 'unavailable'
    ? 'Docker is not running, and no emulators are up.'
    : 'No containers or emulators are running.';
}

/**
 * Docker and emulator CPU or memory over the last couple of hours, one line per kind. Totals are
 * across everything running, so a spike is easy to place, and the per-item breakdown lives in the
 * idle list next to it. CPU is on the "100% is one core" scale used everywhere in this feature.
 */
export function ResourceUsageCard({
  className,
  dragHandle,
  onRemove,
  chartHeight,
}: {
  className?: string;
  dragHandle?: ReactNode;
  onRemove?: () => void;
  chartHeight: number;
}): React.JSX.Element {
  const colors = useChartColors();
  const query = useResourceActivity();
  const [metric, setMetric] = useState<Metric>('cpu');

  const snapshot = query.data;
  const history = snapshot?.history ?? [];
  const latest = history.at(-1);
  const hasDocker = history.some((point) => point.dockerCount > 0);
  const hasEmulators = history.some((point) => point.emulatorCount > 0);

  const kinds = useMemo(
    () =>
      [
        { kind: 'docker' as const, label: 'Docker', color: colors.blue, shown: hasDocker },
        { kind: 'emulator' as const, label: 'Emulators', color: colors.green, shown: hasEmulators },
      ].filter((one) => one.shown),
    [colors.blue, colors.green, hasDocker, hasEmulators],
  );

  const timestamps = useMemo(() => history.map((point) => point.at), [history]);
  const series = useMemo(
    () =>
      kinds.map(({ kind, label, color }) => ({
        key: kind,
        label,
        color,
        values: history.map((point) => pointValue(point, kind, metric)),
      })),
    [kinds, history, metric],
  );

  const formatValue = metric === 'cpu' ? formatPercent : formatBytes;

  let body: ReactNode;
  if (!snapshot) {
    body = <Skeleton className="w-full" style={{ height: chartHeight }} />;
  } else if (kinds.length === 0) {
    body = (
      <div
        className="flex items-center justify-center px-2 text-center text-sm text-muted-foreground"
        style={{ height: chartHeight }}
      >
        {emptyMessage(snapshot)}
      </div>
    );
  } else if (history.length < 2) {
    body = (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height: chartHeight }}
      >
        Collecting usage...
      </div>
    );
  } else {
    body = (
      <SparklineChart
        height={chartHeight}
        timestamps={timestamps}
        domainMin={0}
        formatValue={formatValue}
        formatTime={formatClockTime}
        series={series}
      />
    );
  }

  return (
    <div className={className}>
      <div className="flex h-full flex-col p-4">
        <TileHeader
          className="mb-2"
          icon={<Docker />}
          title="Docker and Emulator Usage"
          actions={
            <>
              {dragHandle}
              {onRemove && (
                <SimpleTooltip label="Remove from dashboard">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove from dashboard"
                    onClick={onRemove}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
              )}
            </>
          }
        />
        <div className="mb-2 flex h-8 items-center gap-4 overflow-x-auto overflow-y-hidden whitespace-nowrap">
          {!snapshot ? (
            <>
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-6 w-24" />
            </>
          ) : (
            kinds.map(({ kind, label, color }) => (
              <div key={kind} className="flex shrink-0 items-baseline gap-1.5">
                <span
                  className="inline-block h-2 w-2 shrink-0 self-center rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-xl font-semibold tabular-nums">
                  {latest ? formatValue(pointValue(latest, kind, metric)) : '0'}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="mb-2 flex h-6 items-center justify-between gap-3 whitespace-nowrap">
          <PillTabs
            id="resource-usage-metric"
            label="Usage metric"
            kind="toggle"
            size="xs"
            items={METRIC_ITEMS}
            value={metric}
            onChange={setMetric}
          />
          {latest ? (
            <SimpleTooltip label="CPU is shown so that 100% is one full core.">
              <span className="truncate text-xs text-muted-foreground">
                {[
                  hasDocker ? plural(latest.dockerCount, 'container', 'containers') : null,
                  hasEmulators ? plural(latest.emulatorCount, 'emulator', 'emulators') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </SimpleTooltip>
          ) : null}
        </div>
        {body}
      </div>
    </div>
  );
}
