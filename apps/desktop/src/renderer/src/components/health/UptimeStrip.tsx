import type { HealthProbeState, HealthSample } from '@runova/core';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatClock, formatLatency, HEALTH_STATE_META, healthBucket } from './healthView';

/**
 * The last checks as a row of bars, oldest on the left, the way status pages draw them. A bar's
 * colour follows its state and its tooltip says the state, the time and the latency in words, and
 * the whole strip has a spoken summary, so nothing rests on colour alone.
 */

const BAR_TONE: Record<ReturnType<typeof healthBucket>, string> = {
  healthy: 'bg-success/75 hover:bg-success',
  degraded: 'bg-warning/85 hover:bg-warning',
  down: 'bg-destructive/85 hover:bg-destructive',
  paused: 'bg-muted-foreground/40',
  pending: 'bg-muted-foreground/40',
};

function summary(list: readonly HealthSample[]): string {
  let healthy = 0;
  let degraded = 0;
  let problem = 0;
  for (const sample of list) {
    const bucket = healthBucket(sample.state);
    if (bucket === 'healthy') healthy += 1;
    else if (bucket === 'degraded') degraded += 1;
    else problem += 1;
  }
  const parts = [`${healthy} healthy`];
  if (degraded > 0) parts.push(`${degraded} degraded`);
  if (problem > 0) parts.push(`${problem} with a problem`);
  return `Last ${list.length} check${list.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

function BarTip({ sample }: { sample: HealthSample }): React.JSX.Element {
  return (
    <div className="space-y-0.5 text-left">
      <p className="font-medium">{HEALTH_STATE_META[sample.state as HealthProbeState].label}</p>
      <p className="font-normal text-muted-foreground">
        {formatClock(sample.at)}, {formatLatency(sample.latencyMs)}
      </p>
    </div>
  );
}

export function UptimeStrip({
  samples,
  slots = 50,
  className,
  barClassName = 'h-6',
}: {
  samples: readonly HealthSample[];
  slots?: number;
  className?: string;
  barClassName?: string;
}): React.JSX.Element {
  const shown = samples.slice(-slots);
  const padding = Math.max(0, slots - shown.length);
  return (
    <div
      role="img"
      aria-label={shown.length === 0 ? 'No checks yet' : summary(shown)}
      className={cn('flex w-full items-end gap-[2px]', className)}
    >
      {Array.from({ length: padding }, (_, i) => `empty-${i}`).map((slot) => (
        <span
          key={slot}
          data-testid="uptime-empty"
          aria-hidden
          className={cn('min-w-0 flex-1 rounded-[2px] bg-foreground/[0.07]', barClassName)}
        />
      ))}
      {shown.map((sample) => (
        <SimpleTooltip key={sample.at} label={<BarTip sample={sample} />} delayDuration={60}>
          <span
            data-testid="uptime-bar"
            className={cn(
              'min-w-0 flex-1 rounded-[2px] transition-colors',
              BAR_TONE[healthBucket(sample.state)],
              barClassName,
            )}
          />
        </SimpleTooltip>
      ))}
    </div>
  );
}
