import type { ChecklistItem } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { cn } from '@/lib/utils';

/**
 * The checklist's score as a ring cut into one arc per item, each as long as the item weighs,
 * so the ring shows where the points went: a filled arc passed, a half-filled one is worth
 * fixing, an outlined one needs fixing, a dotted one could not be checked. The number in the
 * middle is the score; screen readers hear it with the counts. Hand-drawn SVG, theme tokens only.
 */

const SIZE = 132;
const STROKE = 12;
const RADIUS = (SIZE - STROKE) / 2;
const GAP = 0.035;

const TONE: Record<ChecklistItem['status'], string> = {
  pass: 'text-success',
  warn: 'text-warning',
  fail: 'text-destructive',
  unknown: 'text-muted-foreground',
};

function arc(start: number, end: number): string {
  const point = (turn: number) => {
    const angle = turn * Math.PI * 2 - Math.PI / 2;
    return `${SIZE / 2 + RADIUS * Math.cos(angle)} ${SIZE / 2 + RADIUS * Math.sin(angle)}`;
  };
  const large = end - start > 0.5 ? 1 : 0;
  return `M ${point(start)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${point(end)}`;
}

export function ScoreRing({
  score,
  items,
}: {
  score: number;
  items: ChecklistItem[];
}): React.JSX.Element {
  const total = items.reduce((sum, item) => sum + item.weight, 0) || 1;
  const count = (status: ChecklistItem['status']) =>
    items.filter((item) => item.status === status).length;
  const label = `Score ${score} out of 100: ${count('pass')} done, ${count('warn')} worth fixing, ${count('fail')} need fixing, ${count('unknown')} not checked.`;
  let at = 0;
  return (
    <figure
      className="relative shrink-0"
      role="img"
      aria-label={label}
      style={{ width: SIZE, height: SIZE }}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        {items.map((item) => {
          const start = at / total + GAP / 2;
          at += item.weight;
          const end = at / total - GAP / 2;
          const path = arc(start, Math.max(start + 0.001, end));
          return (
            <g key={item.id} className={TONE[item.status]} data-status={item.status}>
              <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeOpacity={item.status === 'pass' ? 1 : 0.35}
                strokeWidth={item.status === 'fail' ? 2 : STROKE}
                strokeDasharray={item.status === 'unknown' ? '2 5' : undefined}
                strokeLinecap="butt"
              />
              {item.status === 'warn' && (
                <path d={path} fill="none" stroke="currentColor" strokeWidth={STROKE / 2} />
              )}
            </g>
          );
        })}
      </svg>
      <figcaption
        className="absolute inset-0 flex flex-col items-center justify-center"
        aria-hidden="true"
      >
        <span
          className={cn(
            'font-mono text-3xl font-semibold tabular-nums leading-none text-foreground',
          )}
        >
          {score}
        </span>
        <span className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
          of 100
        </span>
      </figcaption>
    </figure>
  );
}
