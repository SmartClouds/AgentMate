import { formatTokenCount } from '@runova/core';
import { cn } from '@/lib/utils';

export type FuelLevel = 'calm' | 'warm' | 'hot' | 'unknown';

/** Past this share of the budget the ring warms, so the hand-off never comes as a surprise. */
const WARM_SHARE = 0.6;

export function fuelLevel(used: number | null, budget: number, guardAt: number | null): FuelLevel {
  if (used === null) return 'unknown';
  if (guardAt !== null && used >= guardAt) return 'hot';
  return used >= budget * WARM_SHARE ? 'warm' : 'calm';
}

const STROKE: Record<FuelLevel, string> = {
  calm: 'stroke-emerald-500',
  warm: 'stroke-amber-500',
  hot: 'stroke-rose-500',
  unknown: 'stroke-muted-foreground/40',
};

/** A point on the ring at `share` of a turn, clockwise from the top. */
function polar(share: number, radius: number, center: number): { x: number; y: number } {
  const angle = share * 2 * Math.PI - Math.PI / 2;
  return { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) };
}

/**
 * How full a leg's context is, drawn as the ring around its station on the track. The arc fills
 * toward the budget; a tick marks where the guard tells the session to write its handoff.
 */
export function FuelRing({
  used,
  budget,
  guardAt,
  size = 28,
  className,
  children,
}: {
  used: number | null;
  budget: number;
  guardAt: number | null;
  size?: number;
  className?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const level = fuelLevel(used, budget, guardAt);
  const stroke = 2.5;
  const center = size / 2;
  const radius = center - stroke;
  const circumference = 2 * Math.PI * radius;
  const share = used === null ? 0 : Math.min(1, used / budget);
  const percent = Math.round(share * 100);
  const guardShare = guardAt !== null ? Math.min(1, guardAt / budget) : null;
  const inner = guardShare !== null ? polar(guardShare, radius - 3.5, center) : null;
  const outer = guardShare !== null ? polar(guardShare, radius + 2, center) : null;

  return (
    <span
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={budget}
      aria-valuenow={used ?? undefined}
      aria-valuetext={
        used === null
          ? 'Not reported by this CLI'
          : `${formatTokenCount(used)} of ${formatTokenCount(budget)} tokens, ${percent}%`
      }
      data-level={level}
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden
        className="absolute inset-0"
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-foreground/10"
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * share} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
          className={cn('transition-[stroke-dasharray] duration-700 ease-out', STROKE[level])}
        />
        {inner && outer ? (
          <line
            data-guard-tick
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
            strokeWidth={1.5}
            strokeLinecap="round"
            className="stroke-foreground/60"
          />
        ) : null}
      </svg>
      {children}
    </span>
  );
}
