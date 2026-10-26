import type { HealthIncident, HealthLatencyPoint } from '@runova/core';
import {
  type ChartBand,
  type ChartSeries,
  MetricChart,
} from '@/components/deploy/overview/MetricChart';
import { useChartColors } from '@/lib/chartColors';
import { formatLatency } from './healthView';

/**
 * How fast the endpoint answered over the last day, an hour per point: the median and the 95th
 * percentile, so a slow tail shows before the average moves. Incidents are shaded behind the
 * lines, which makes "it got slow, then it went down" readable at a glance. Hours without a
 * reading are left out rather than drawn as zero.
 */

function niceCeiling(value: number): number {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

function hourLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function hourReadout(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function HealthLatencyChart({
  latency,
  incidents,
  now,
}: {
  latency: readonly HealthLatencyPoint[];
  incidents: readonly HealthIncident[];
  now: number;
}): React.JSX.Element {
  const { green, blue } = useChartColors();
  const points = latency.filter((point) => point.p50 !== null);

  if (points.length < 2) {
    return <p className="py-3 text-xs text-muted-foreground">Not enough checks yet for a chart.</p>;
  }

  const times = points.map((point) => point.start);
  const median = points.map((point) => point.p50 ?? 0);
  const tail = points.map((point) => point.p95 ?? point.p50 ?? 0);
  const series: ChartSeries[] = [
    { key: 'p50', label: 'Median', color: green, values: median },
    { key: 'p95', label: '95th percentile', color: blue, values: tail },
  ];
  const windowStart = latency[0]?.start ?? times[0];
  const bands: ChartBand[] = incidents
    .map((one) => ({ key: one.id, from: one.openedAt, to: one.resolvedAt ?? now }))
    .filter((band) => band.to > windowStart && band.from < now);

  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-3 text-[11px] text-muted-foreground" aria-label="Legend">
        {series.map((item) => (
          <li key={item.key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-3 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
          </li>
        ))}
        {bands.length > 0 && (
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-3 rounded-sm bg-destructive/15" />
            Incident
          </li>
        )}
      </ul>
      <MetricChart
        title="Response time"
        times={times}
        series={series}
        bands={bands}
        yMax={niceCeiling(Math.max(...tail) * 1.1)}
        formatValue={formatLatency}
        formatTime={hourReadout}
        axisTimes={hourLabel}
        height={120}
      />
    </div>
  );
}
