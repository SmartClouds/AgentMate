import type { MetricsSample } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployConnectionState } from '@shared/deployTypes';
import {
  CircleCheck,
  CircleX,
  Cpu,
  MemoryStick,
  NetworkIcon,
  TriangleAlert,
} from '@/components/icons';
import { GLASS_CARD } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { CountUp } from '@/components/usage/CountUp';
import { useChartColors } from '@/lib/chartColors';
import { HEALTH_RULES, type Health } from '@/lib/deploy/overview/health';
import { formatRate, memoryPercent, wholePercent } from '@/lib/deploy/overview/metrics';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The top of a server's Overview: one number for how it is doing, and the last two minutes of
 * processor, memory and network as ribbons that move with every sample. The score explains
 * itself in a tooltip; the band is said in words and with its own icon, not only a colour.
 */

/** Two minutes of samples at the stream's 2 seconds. */
const RIBBON_POINTS = 60;

function Ribbon({ values, max, color }: { values: number[]; max: number; color: string }) {
  const width = 120;
  const height = 28;
  if (values.length < 2) {
    return <div className="h-7 w-full rounded-md bg-foreground/[0.05]" aria-hidden />;
  }
  const top = Math.max(max, 1);
  const points = values.map((value, i) => {
    const px = (i / (values.length - 1)) * width;
    const py = 2 + (1 - Math.min(1, value / top)) * (height - 4);
    return `${px.toFixed(1)} ${py.toFixed(1)}`;
  });
  const line = `M${points.join(' L')}`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-7 w-full"
      aria-hidden
    >
      <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={color} fillOpacity={0.1} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Pulse({
  icon,
  label,
  value,
  detail,
  values,
  max,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  detail?: string;
  values: number[];
  max: number;
  color: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-1.5" aria-label={label} role="group">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:text-primary">
        {icon} {label}
      </div>
      <div className="flex items-baseline gap-2">
        {value === null ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <span className="text-lg font-semibold text-foreground" data-testid={`pulse-${label}`}>
            {value}
          </span>
        )}
        {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      </div>
      <Ribbon values={values} max={max} color={color} />
    </div>
  );
}

const BAND_ICON = { good: CircleCheck, fair: TriangleAlert, poor: CircleX } as const;
const BAND_TONE = { good: 'text-success', fair: 'text-warning', poor: 'text-destructive' } as const;

export function PulseHeader({
  samples,
  ready,
  health,
  connection,
}: {
  samples: MetricsSample[];
  ready: boolean;
  health: Health | null;
  connection: DeployConnectionState | undefined;
}): React.JSX.Element {
  const { categorical } = useChartColors();
  const recent = samples.slice(-RIBBON_POINTS);
  const latest = recent.at(-1);
  const network = recent.map(
    (sample) => sample.networkReceiveBytesPerSecond + sample.networkTransmitBytesPerSecond,
  );
  const live = connection === 'online';
  const Icon = health ? BAND_ICON[health.band] : null;

  const tooltip = (
    <div className="space-y-1.5 text-left">
      {health && health.findings.length > 0 ? (
        <ul className="space-y-0.5">
          {health.findings.map((finding) => (
            <li key={finding.label}>
              {finding.label}: -{finding.points}
            </li>
          ))}
        </ul>
      ) : (
        <p>Nothing to take points off for.</p>
      )}
      <p className="font-normal text-muted-foreground">{HEALTH_RULES}</p>
    </div>
  );

  return (
    <section
      className={cn(GLASS_CARD, 'grid gap-5 p-4 md:grid-cols-[auto_minmax(0,1fr)] md:items-center')}
      aria-label="Pulse"
    >
      <SimpleTooltip label={tooltip} className="max-w-sm">
        <button
          type="button"
          className="flex min-w-44 cursor-help items-center gap-3 rounded-xl px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={
            health
              ? `Health score ${health.score} of 100, ${health.label}. ${health.findings.map((f) => f.label).join(', ')}`
              : 'Health score: waiting for the first reading'
          }
        >
          {health && Icon ? (
            <>
              <span className="text-5xl font-semibold leading-none tracking-tight text-foreground tabular-nums">
                <CountUp value={health.score} format={(n) => String(Math.round(n))} />
              </span>
              <span className="space-y-0.5">
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-sm font-medium',
                    BAND_TONE[health.band],
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="text-foreground">{health.label}</span>
                </span>
                <span className="block text-xs text-muted-foreground">
                  Health score
                  {health.findings.length > 0 ? `, ${health.findings.length} to look at` : ''}
                </span>
              </span>
            </>
          ) : (
            <span className="space-y-2">
              <Skeleton className="h-10 w-16" />
              <span className="block text-xs text-muted-foreground">Health score</span>
            </span>
          )}
        </button>
      </SimpleTooltip>
      <div
        className={cn(
          'grid gap-4 transition-opacity sm:grid-cols-3',
          !live && ready && 'opacity-50',
        )}
      >
        <Pulse
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="Processor"
          value={latest ? wholePercent(latest.cpuPercent) : ready ? 'No data' : null}
          detail={latest ? `load ${latest.load1.toFixed(2)}` : undefined}
          values={recent.map((sample) => sample.cpuPercent)}
          max={100}
          color={categorical[0]}
        />
        <Pulse
          icon={<MemoryStick className="h-3.5 w-3.5" />}
          label="Memory"
          value={latest ? wholePercent(memoryPercent(latest)) : ready ? 'No data' : null}
          detail={
            latest
              ? `${formatBytes(latest.memoryUsedBytes)} of ${formatBytes(latest.memoryTotalBytes)}`
              : undefined
          }
          values={recent.map(memoryPercent)}
          max={100}
          color={categorical[0]}
        />
        <Pulse
          icon={<NetworkIcon className="h-3.5 w-3.5" />}
          label="Network"
          value={
            latest
              ? formatRate(
                  latest.networkReceiveBytesPerSecond + latest.networkTransmitBytesPerSecond,
                )
              : ready
                ? 'No data'
                : null
          }
          detail={latest ? 'in and out' : undefined}
          values={network}
          max={Math.max(...network, 1)}
          color={categorical[0]}
        />
      </div>
    </section>
  );
}
