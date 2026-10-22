import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A hand-drawn line chart for one measure over time, on one axis: 2px lines over a 10% wash,
 * solid hairline grid, an end dot ringed in the card colour, and a crosshair that snaps to the
 * nearest reading. The same readout follows the arrow keys when the chart has focus, and the
 * card around it offers the readings as a table, so nothing is only reachable by hovering.
 */

/** A stretch of time to shade behind the lines, such as an outage. */
export interface ChartBand {
  key: string;
  from: number;
  to: number;
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
  /** Words for the reading at an index, shown under its value, e.g. "7.3 GB of 8 GB". */
  detail?: (index: number) => string;
}

const WIDTH = 600;
const PAD_TOP = 6;
const PAD_BOTTOM = 2;

export function MetricChart({
  title,
  times,
  series,
  yMax,
  formatValue,
  formatTick = formatValue,
  formatTime,
  axisTimes,
  height = 132,
  bands = [],
  className,
}: {
  title: string;
  times: number[];
  series: ChartSeries[];
  yMax: number;
  formatValue: (value: number) => string;
  formatTick?: (value: number) => string;
  /** For the readout: the reading's moment. */
  formatTime: (unixMs: number) => string;
  /** For the axis under the plot. */
  axisTimes: (unixMs: number) => string;
  height?: number;
  /** Shaded behind the lines in the destructive tone, clipped to the plotted time. */
  bands?: ChartBand[];
  className?: string;
}): React.JSX.Element {
  const [index, setIndex] = useState<number | null>(null);
  const n = times.length;
  const first = times[0] ?? 0;
  const last = times[n - 1] ?? 0;
  const span = Math.max(1, last - first);
  const top = yMax > 0 ? yMax : 1;

  const x = (i: number) => (n <= 1 ? WIDTH : ((times[i] - first) / span) * WIDTH);
  const y = (value: number) =>
    PAD_TOP + (1 - Math.min(1, Math.max(0, value / top))) * (height - PAD_TOP - PAD_BOTTOM);
  const xAt = (time: number) => ((time - first) / span) * WIDTH;
  const shaded = n === 0 ? [] : bands.filter((band) => band.to > first && band.from < last);
  const line = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = (values: number[]) =>
    values.length === 0
      ? ''
      : `${line(values)} L${x(values.length - 1).toFixed(1)} ${height} L${x(0).toFixed(1)} ${height} Z`;

  const latest = series.map(
    (item) =>
      `${item.label} ${formatValue(item.values[n - 1] ?? 0)}${n > 0 && item.detail ? ` (${item.detail(n - 1)})` : ''}`,
  );
  const summary =
    n === 0
      ? `${title}: no readings yet`
      : `${title}, ${n} readings from ${formatTime(first)} to ${formatTime(last)}. Latest: ${latest.join(', ')}.`;

  function pick(clientX: number, target: HTMLElement): void {
    if (n === 0) return;
    const rect = target.getBoundingClientRect();
    const at = first + ((clientX - rect.left) / Math.max(1, rect.width)) * span;
    let best = 0;
    for (let i = 1; i < n; i += 1) {
      if (Math.abs(times[i] - at) < Math.abs(times[best] - at)) best = i;
    }
    setIndex(best);
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (n === 0) return;
    const current = index ?? n - 1;
    const moves: Record<string, number> = {
      ArrowLeft: Math.max(0, current - 1),
      ArrowRight: Math.min(n - 1, current + 1),
      Home: 0,
      End: n - 1,
    };
    if (event.key === 'Escape') {
      setIndex(null);
      return;
    }
    if (!(event.key in moves)) return;
    event.preventDefault();
    setIndex(moves[event.key]);
  }

  const shown = index !== null && index < n ? index : null;
  const leftPct = shown === null ? 0 : (x(shown) / WIDTH) * 100;
  const ticks = [top, top / 2, 0];

  return (
    <figure className={cn('min-w-0', className)} aria-label={title}>
      <div className="flex gap-2">
        <div
          className="flex shrink-0 flex-col justify-between py-0.5 text-right text-[10px] tabular-nums text-muted-foreground"
          style={{ height }}
          aria-hidden
        >
          {ticks.map((tick) => (
            <span key={tick} className="leading-none">
              {formatTick(tick)}
            </span>
          ))}
        </div>
        <div
          role="img"
          aria-label={summary}
          tabIndex={0}
          className="relative min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ height }}
          onPointerMove={(event) => pick(event.clientX, event.currentTarget)}
          onPointerLeave={() => setIndex(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setIndex(null)}
        >
          <svg
            viewBox={`0 0 ${WIDTH} ${height}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
            aria-hidden
          >
            {shaded.map((band) => {
              const from = xAt(Math.max(first, band.from));
              const to = xAt(Math.min(last, band.to));
              return (
                <rect
                  key={band.key}
                  data-band={band.key}
                  x={from.toFixed(1)}
                  y={0}
                  width={Math.max(0, to - from).toFixed(1)}
                  height={height}
                  fill="hsl(var(--destructive))"
                  fillOpacity={0.12}
                />
              );
            })}
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={WIDTH}
                y1={y(tick)}
                y2={y(tick)}
                stroke="hsl(var(--border))"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.map((item) => (
              <path
                key={`a-${item.key}`}
                d={area(item.values)}
                fill={item.color}
                fillOpacity={0.1}
              />
            ))}
            {series.map((item) => (
              <path
                key={`l-${item.key}`}
                data-series={item.key}
                d={line(item.values)}
                fill="none"
                stroke={item.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {shown !== null && (
              <line
                x1={x(shown)}
                x2={x(shown)}
                y1={0}
                y2={height}
                stroke="hsl(var(--muted-foreground) / 0.5)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {n > 0 &&
            series.map((item) => {
              const at = shown ?? n - 1;
              return (
                <span
                  key={`d-${item.key}`}
                  className="pointer-events-none absolute h-2.5 w-2.5 rounded-full border-2"
                  style={{
                    left: `${(x(at) / WIDTH) * 100}%`,
                    top: `${(y(item.values[at] ?? 0) / height) * 100}%`,
                    transform: 'translate(-50%, -50%)',
                    backgroundColor: item.color,
                    borderColor: 'hsl(var(--card))',
                  }}
                />
              );
            })}
          {shown !== null && (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-1 z-10 min-w-max rounded-lg border border-border bg-popover px-2 py-1.5 text-xs shadow-md"
              style={
                leftPct > 60
                  ? { right: `calc(${100 - leftPct}% + 10px)` }
                  : { left: `calc(${leftPct}% + 10px)` }
              }
            >
              <div className="mb-1 text-[10px] text-muted-foreground">
                {formatTime(times[shown])}
              </div>
              {series.map((item) => (
                <div key={item.key}>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-0.5 w-3 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="font-semibold text-popover-foreground">
                      {formatValue(item.values[shown] ?? 0)}
                    </span>
                    <span className="text-muted-foreground">{item.label}</span>
                  </div>
                  {item.detail && (
                    <div className="pl-[1.125rem] text-[11px] tabular-nums text-muted-foreground">
                      {item.detail(shown)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        className="mt-1 flex justify-between pl-10 text-[10px] tabular-nums text-muted-foreground"
        aria-hidden
      >
        <span>{n > 0 ? axisTimes(first) : ''}</span>
        <span>{n > 0 ? axisTimes(first + span / 2) : ''}</span>
        <span>{n > 0 ? axisTimes(last) : ''}</span>
      </div>
    </figure>
  );
}
