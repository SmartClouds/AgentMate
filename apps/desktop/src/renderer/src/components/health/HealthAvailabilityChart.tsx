import { type HealthDayBucket, healthDays, mergeHealthDays } from '@runova/core';
import type { HealthTargetSummary } from '@shared/healthTypes';
import { useState } from 'react';
import { GLASS_CARD, PillTabs, SECTION_HEADING } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatUptime } from './healthView';

/**
 * Availability by day: one bar per calendar day for the targets in view, so "how was this week"
 * is one glance. A day that had failed checks can be picked to list the targets behind it, each
 * opening its panel. The days come from the main process's hourly roll-ups, already split at
 * local midnight.
 */

type Range = '7' | '30';
type Tone = 'good' | 'warning' | 'bad' | 'none';

const TONE_CLASS: Record<Tone, string> = {
  good: 'bg-success/70',
  warning: 'bg-warning/85',
  bad: 'bg-destructive/85',
  none: 'bg-transparent',
};

interface DayFailure {
  id: string;
  name: string;
  failures: number;
}

function uptimeOf(day: { checks: number; failures: number }): number | null {
  return day.checks === 0 ? null : (day.checks - day.failures) / day.checks;
}

function toneOf(uptime: number | null): Tone {
  if (uptime === null) return 'none';
  if (uptime >= 0.999) return 'good';
  if (uptime >= 0.99) return 'warning';
  return 'bad';
}

/**
 * Bar height in percent. Real days sit between 90 and 100% up, where a linear 0 to 100 scale
 * would draw every bar the same height, so the scale starts at 90%: anything at or below it gets
 * the shortest bar and its colour says how bad it was. Days without checks get a stub.
 */
function heightOf(uptime: number | null): number {
  if (uptime === null) return 6;
  const share = Math.min(1, Math.max(0, (uptime - 0.9) / 0.1));
  return 12 + share * 88;
}

function dayName(start: number): string {
  return new Date(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dayLabel(day: HealthDayBucket): string {
  const uptime = uptimeOf(day);
  if (uptime === null) return `${dayName(day.start)}: no checks`;
  return `${dayName(day.start)}: ${formatUptime(uptime)} up, ${day.failures} of ${day.checks} checks failed`;
}

function failuresOn(start: number, targets: readonly HealthTargetSummary[]): DayFailure[] {
  return targets
    .map((one) => ({
      id: one.id,
      name: one.name,
      failures: one.daily.find((day) => day.start === start)?.failures ?? 0,
    }))
    .filter((one) => one.failures > 0)
    .sort((a, b) => b.failures - a.failures || a.name.localeCompare(b.name));
}

function DayTip({
  day,
  failures,
}: {
  day: HealthDayBucket;
  failures: DayFailure[];
}): React.JSX.Element {
  const uptime = uptimeOf(day);
  return (
    <div className="space-y-1 text-xs">
      <p className="font-medium">{dayName(day.start)}</p>
      {uptime === null ? (
        <p className="text-muted-foreground">No checks</p>
      ) : (
        <p className="text-muted-foreground">
          {formatUptime(uptime)} up, {day.failures} of {day.checks} checks failed
        </p>
      )}
      {failures.slice(0, 3).map((one) => (
        <p key={one.id} className="flex justify-between gap-3">
          <span className="truncate">{one.name}</span>
          <span className="tabular-nums text-muted-foreground">{one.failures} failed</span>
        </p>
      ))}
    </div>
  );
}

export function HealthAvailabilityChart({
  targets,
  loading,
  now,
  onOpenTarget,
}: {
  /** The targets in view: the page's project and environment filters already applied. */
  targets: readonly HealthTargetSummary[];
  loading: boolean;
  now: number;
  onOpenTarget: (targetId: string) => void;
}): React.JSX.Element {
  const [range, setRange] = useState<Range>('7');
  const [picked, setPicked] = useState<number | null>(null);
  const count = Number(range);

  const merged = mergeHealthDays(targets.map((one) => one.daily));
  const days = (merged.length > 0 ? merged : healthDays([], { days: count, now })).slice(-count);
  const checks = days.reduce((sum, day) => sum + day.checks, 0);
  const failures = days.reduce((sum, day) => sum + day.failures, 0);
  const overall = uptimeOf({ checks, failures });
  const pickedDay = days.find((day) => day.start === picked) ?? null;
  const pickedFailures = pickedDay ? failuresOn(pickedDay.start, targets) : [];

  return (
    <section aria-label="Availability by day" className={cn(GLASS_CARD, 'space-y-3 p-4')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 className={SECTION_HEADING}>Availability by day</h2>
          {loading ? (
            <Skeleton className="h-4 w-40" />
          ) : (
            <p className="text-sm">
              {overall === null ? (
                <span className="text-muted-foreground">No checks in the last {count} days</span>
              ) : (
                <>
                  <span className="font-semibold tabular-nums">{formatUptime(overall)}</span>
                  <span className="text-muted-foreground"> up over {count} days</span>
                </>
              )}
            </p>
          )}
        </div>
        <PillTabs
          id="health-availability-range"
          kind="toggle"
          size="xs"
          label="Range"
          value={range}
          onChange={(next) => {
            setRange(next);
            setPicked(null);
          }}
          items={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
          ]}
        />
      </div>

      {loading ? (
        <div
          role="status"
          aria-label="Loading availability"
          className="flex h-16 items-end gap-1.5"
        >
          {Array.from({ length: 14 }, (_, i) => (
            <Skeleton
              key={i}
              className="flex-1 rounded-md"
              style={{ height: `${55 + ((i * 37) % 45)}%` }}
            />
          ))}
        </div>
      ) : (
        <>
          <div role="group" aria-label="Days" className="flex h-16 items-end gap-1.5">
            {days.map((day) => {
              const uptime = uptimeOf(day);
              const tone = toneOf(uptime);
              const canPick = day.failures > 0;
              const isPicked = picked === day.start;
              return (
                <SimpleTooltip
                  key={day.start}
                  label={<DayTip day={day} failures={failuresOn(day.start, targets)} />}
                >
                  <button
                    type="button"
                    aria-label={dayLabel(day)}
                    aria-pressed={canPick ? isPicked : undefined}
                    data-tone={tone}
                    onClick={() => {
                      if (canPick) setPicked(isPicked ? null : day.start);
                    }}
                    className={cn(
                      // The faint track is the full 100%, so a short bar reads as a dip.
                      'group relative flex h-full min-w-0 flex-1 items-end overflow-hidden rounded-md bg-foreground/[0.05] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                      canPick ? 'cursor-pointer' : 'cursor-default',
                    )}
                  >
                    <span
                      className={cn(
                        'block w-full rounded-md transition-opacity',
                        TONE_CLASS[tone],
                        picked !== null && !isPicked ? 'opacity-40' : 'group-hover:opacity-80',
                      )}
                      style={{ height: `${heightOf(uptime)}%` }}
                    />
                  </button>
                </SimpleTooltip>
              );
            })}
          </div>
          <div
            className="flex justify-between text-[10px] tabular-nums text-muted-foreground"
            aria-hidden
          >
            <span>{days[0] ? dayName(days[0].start) : ''}</span>
            <span>Today</span>
          </div>
        </>
      )}

      {pickedDay && pickedFailures.length > 0 && (
        <ul
          aria-label={`Failed checks on ${dayName(pickedDay.start)}`}
          className="flex flex-wrap gap-1.5 pt-1"
        >
          {pickedFailures.map((one) => (
            <li key={one.id}>
              <button
                type="button"
                onClick={() => onOpenTarget(one.id)}
                className="flex items-center gap-2 rounded-full bg-destructive/10 px-2.5 py-1 text-xs ring-1 ring-inset ring-destructive/20 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span className="font-medium">{one.name}</span>
                <span className="tabular-nums text-muted-foreground">{one.failures} failed</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
