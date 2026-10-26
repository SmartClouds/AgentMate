import type { ContainerSummary } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { SparklineChart } from '@/components/dashboard/SparklineChart';
import { ChartColumn } from '@/components/icons';
import { EmptyState, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { useChartColors } from '@/lib/chartColors';
import { cpuText, memoryShare, ratesOf, type StatsHistory } from '@/lib/deploy/containers/stats';
import { formatRate } from '@/lib/deploy/overview/metrics';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * A container's live figures (E06 T8), the way `docker stats` computes them: processor (100% is
 * one core), memory against its limit, network and disk traffic per second, and processes. Each
 * chart is one measure on its own scale, with the current figure in text above it.
 */

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function Chart({
  label,
  value,
  detail,
  timestamps,
  series,
  domainMax,
  format,
}: {
  label: string;
  value: string;
  detail?: string;
  timestamps: number[];
  series: Array<{ key: string; label: string; color: string; values: number[] }>;
  domainMax?: number;
  format: (value: number) => string;
}): React.JSX.Element {
  return (
    <div className={cn(SECTION_WELL, 'space-y-2')} role="group" aria-label={label}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={SECTION_HEADING}>{label}</span>
        <span
          className="text-sm font-semibold tabular-nums text-foreground"
          data-testid={`stat-${label}`}
        >
          {value}
        </span>
      </div>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      <SparklineChart
        timestamps={timestamps}
        series={series}
        height={72}
        domainMax={domainMax}
        formatValue={format}
        formatTime={clock}
      />
      {series.length > 1 && (
        <ul
          className="flex flex-wrap gap-3 text-[11px] text-muted-foreground"
          aria-label={`${label} legend`}
        >
          {series.map((one) => (
            <li key={one.key} className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: one.color }} />
              {one.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ContainerStatsTab({
  container,
  history,
  ready,
  error,
}: {
  container: ContainerSummary;
  history: StatsHistory;
  ready: boolean;
  error: string | null;
}): React.JSX.Element {
  const { categorical } = useChartColors();
  const samples = [...(history.get(container.id) ?? [])];
  const latest = samples.at(-1);

  if (container.state !== 'running') {
    return (
      <EmptyState
        size="sm"
        icon={ChartColumn}
        title="No live figures"
        description={`${container.name} is not running, so there are no live figures. Start it to see them.`}
      />
    );
  }
  if (!latest) {
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        Live figures are not coming in: {error}
      </p>
    ) : (
      <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
        {ready && <p className="text-sm text-muted-foreground">Waiting for the first reading.</p>}
      </div>
    );
  }

  const times = samples.map((sample) => sample.atUnixMs);
  const rates = ratesOf(samples);
  const last = (values: number[]) => values.at(-1) ?? 0;

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-xs text-warning">
          Live figures stopped for now: {error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Chart
          label="Processor"
          value={cpuText(latest.cpuPercent)}
          detail={`${latest.onlineCpus} core${latest.onlineCpus === 1 ? '' : 's'} available, 100% is one core`}
          timestamps={times}
          series={[
            {
              key: 'cpu',
              label: 'Processor',
              color: categorical[0],
              values: samples.map((s) => s.cpuPercent),
            },
          ]}
          format={cpuText}
        />
        <Chart
          label="Memory"
          value={formatBytes(latest.memoryUsedBytes)}
          detail={`${memoryShare(latest).toFixed(1)}% of ${formatBytes(latest.memoryLimitBytes)}`}
          timestamps={times}
          series={[
            {
              key: 'memory',
              label: 'Memory',
              color: categorical[1],
              values: samples.map((s) => s.memoryUsedBytes),
            },
          ]}
          domainMax={latest.memoryLimitBytes}
          format={formatBytes}
        />
        <Chart
          label="Network"
          value={`${formatRate(last(rates.receive))} in`}
          detail={`${formatRate(last(rates.transmit))} out`}
          timestamps={rates.atUnixMs}
          series={[
            { key: 'in', label: 'Received', color: categorical[2], values: rates.receive },
            { key: 'out', label: 'Sent', color: categorical[3], values: rates.transmit },
          ]}
          format={formatRate}
        />
        <Chart
          label="Disk"
          value={`${formatRate(last(rates.read))} read`}
          detail={`${formatRate(last(rates.write))} written, ${latest.pids} processes`}
          timestamps={rates.atUnixMs}
          series={[
            { key: 'read', label: 'Read', color: categorical[4], values: rates.read },
            { key: 'write', label: 'Written', color: categorical[5], values: rates.write },
          ]}
          format={formatRate}
        />
      </div>
    </div>
  );
}
