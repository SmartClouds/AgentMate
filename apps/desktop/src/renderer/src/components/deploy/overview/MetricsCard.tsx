import { coreErrorMessage } from '@shared/coreErrors';
import type { MetricsSample } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ChartSimple, Table } from '@/components/icons';
import { SEGMENT_TRACK, segmentClass } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useChartColors } from '@/lib/chartColors';
import {
  formatAxisTime,
  formatPointTime,
  formatRate,
  type MetricsRange,
  memoryAmounts,
  memoryPercent,
  niceRateMax,
  RANGES,
  rangeOption,
  wholePercent,
} from '@/lib/deploy/overview/metrics';
import { formatPercent } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { DeployCard } from '../deployKit';
import { type ChartSeries, MetricChart } from './MetricChart';

/** The table view keeps to the newest readings, so a 30-day range stays a page long. */
const TABLE_ROWS = 60;

interface ChartSpec {
  key: string;
  title: string;
  series: Array<{
    key: string;
    label: string;
    pick: (sample: MetricsSample) => number;
    /** Words for the reading under the pointer, such as the amounts behind a percentage. */
    detail?: (sample: MetricsSample) => string;
  }>;
  percent: boolean;
}

const CHARTS: ChartSpec[] = [
  {
    key: 'cpu',
    title: 'Processor',
    percent: true,
    series: [{ key: 'cpu', label: 'Busy', pick: (sample) => sample.cpuPercent }],
  },
  {
    key: 'memory',
    title: 'Memory',
    percent: true,
    series: [{ key: 'memory', label: 'In use', pick: memoryPercent, detail: memoryAmounts }],
  },
  {
    key: 'network',
    title: 'Network',
    percent: false,
    series: [
      { key: 'rx', label: 'Received', pick: (sample) => sample.networkReceiveBytesPerSecond },
      { key: 'tx', label: 'Sent', pick: (sample) => sample.networkTransmitBytesPerSecond },
    ],
  },
  {
    key: 'disk',
    title: 'Disk activity',
    percent: false,
    series: [
      { key: 'read', label: 'Read', pick: (sample) => sample.diskReadBytesPerSecond },
      { key: 'write', label: 'Written', pick: (sample) => sample.diskWriteBytesPerSecond },
    ],
  },
];

function Legend({ series }: { series: ChartSeries[] }): React.JSX.Element | null {
  if (series.length < 2) return null;
  return (
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
    </ul>
  );
}

function ReadingsTable({ samples, spanMs }: { samples: MetricsSample[]; spanMs: number }) {
  const rows = samples.slice(-TABLE_ROWS).reverse();
  return (
    <div className="overflow-x-auto">
      {samples.length > TABLE_ROWS && (
        <p className="mb-2 text-xs text-muted-foreground">
          The newest {TABLE_ROWS} of {samples.length} readings.
        </p>
      )}
      <table className="w-full text-xs tabular-nums" aria-label="Readings">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Time</th>
            <th className="py-1 pr-3 font-medium">Processor</th>
            <th className="py-1 pr-3 font-medium">Memory</th>
            <th className="py-1 pr-3 font-medium">Received</th>
            <th className="py-1 pr-3 font-medium">Sent</th>
            <th className="py-1 pr-3 font-medium">Read</th>
            <th className="py-1 font-medium">Written</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((sample) => (
            // A hairline as an inset shadow, since a border would take the global colour.
            <tr
              key={sample.atUnixMs}
              className="[&>td]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]"
            >
              <td className="py-1 pr-3">{formatPointTime(sample.atUnixMs, spanMs)}</td>
              <td className="py-1 pr-3">{formatPercent(sample.cpuPercent)}</td>
              <td className="py-1 pr-3">{wholePercent(memoryPercent(sample))}</td>
              <td className="py-1 pr-3">{formatRate(sample.networkReceiveBytesPerSecond)}</td>
              <td className="py-1 pr-3">{formatRate(sample.networkTransmitBytesPerSecond)}</td>
              <td className="py-1 pr-3">{formatRate(sample.diskReadBytesPerSecond)}</td>
              <td className="py-1">{formatRate(sample.diskWriteBytesPerSecond)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The server's history: processor, memory, network and disk, live for the last 15 minutes or
 * from the core's stored minutes and quarter hours for longer. Changing the range keeps the
 * charts on screen, dimmed, until the new readings are in.
 */
export function MetricsCard({
  serverId,
  live,
  liveReady,
  liveError,
  stale,
}: {
  serverId: string;
  live: MetricsSample[];
  liveReady: boolean;
  liveError: string | null;
  /** The connection is down for now: keep what is on screen, dimmed. */
  stale: boolean;
}): React.JSX.Element {
  const [range, setRange] = useState<MetricsRange>('live');
  const [table, setTable] = useState(false);
  const { categorical } = useChartColors();
  const option = rangeOption(range);

  const history = useQuery({
    queryKey: queryKeys.deployMetricsHistory(serverId, range),
    queryFn: () =>
      window.runova.deploySystem.metricsHistory({
        serverId,
        resolution: option.resolution,
        fromUnixMs: Date.now() - option.spanMs,
      }),
    enabled: range !== 'live',
    refetchInterval: option.refreshMs ?? false,
    placeholderData: (previous) => previous,
  });

  const samples = range === 'live' ? live : (history.data?.samples ?? []);
  const loading = range === 'live' ? !liveReady : history.isPending;
  const error =
    range === 'live' ? liveError : history.isError ? coreErrorMessage(history.error) : null;
  const dimmed = stale || (range !== 'live' && history.isPlaceholderData);
  const times = samples.map((sample) => sample.atUnixMs);

  return (
    <DeployCard
      icon={<ChartSimple />}
      title="History"
      description={`Showing ${option.description}.`}
      actions={
        <>
          <div role="radiogroup" aria-label="Range" className={SEGMENT_TRACK}>
            {RANGES.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={item.value === range}
                onClick={() => setRange(item.value)}
                className={segmentClass(item.value === range)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="soft"
            aria-pressed={table}
            onClick={() => setTable((current) => !current)}
          >
            {table ? <ChartSimple /> : <Table />}
            {table ? 'Charts' : 'Table'}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="grid gap-6 md:grid-cols-2" aria-busy="true">
          {CHARTS.map((chart) => (
            <Skeleton key={chart.key} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      ) : error && samples.length === 0 ? (
        <p role="alert" className="text-sm text-muted-foreground">
          The readings did not load: {error}
        </p>
      ) : samples.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {range === 'live'
            ? 'Waiting for the first reading from the server.'
            : 'No readings stored for this range yet. The core keeps them from the time it was installed.'}
        </p>
      ) : table ? (
        <div className={cn('transition-opacity', dimmed && 'opacity-50')}>
          <ReadingsTable samples={samples} spanMs={option.spanMs} />
        </div>
      ) : (
        <div className={cn('grid gap-6 transition-opacity md:grid-cols-2', dimmed && 'opacity-50')}>
          {CHARTS.map((chart) => {
            const series: ChartSeries[] = chart.series.map(({ detail, ...item }, slot) => ({
              key: item.key,
              label: item.label,
              color: categorical[slot],
              values: samples.map(item.pick),
              detail: detail && ((at) => detail(samples[at])),
            }));
            const yMax = chart.percent ? 100 : niceRateMax(series.flatMap((item) => item.values));
            const format = chart.percent ? formatPercent : formatRate;
            return (
              <div key={chart.key} className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="text-sm font-medium text-foreground">{chart.title}</h4>
                  <Legend series={series} />
                </div>
                <MetricChart
                  title={chart.title}
                  times={times}
                  series={series}
                  yMax={yMax}
                  formatValue={format}
                  formatTick={chart.percent ? wholePercent : formatRate}
                  formatTime={(at) => formatPointTime(at, option.spanMs)}
                  axisTimes={(at) => formatAxisTime(at, option.spanMs)}
                />
              </div>
            );
          })}
        </div>
      )}
    </DeployCard>
  );
}
