import { cn } from '@/lib/utils';

function costTone(level: number): string {
  if (level <= 2) return 'bg-success';
  if (level === 3) return 'bg-warning';
  return 'bg-destructive';
}

/**
 * Five rising bars, filled up to `level` (1 cheapest, 5 priciest) in green, amber or red. Purely
 * decorative: whatever it sits beside has to say the same thing in words.
 */
export function CostMeter({
  level,
  className,
}: {
  level: number;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-end gap-[2px]', className)} aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={cn(
            'w-[3px] rounded-sm transition-colors',
            i <= level ? costTone(level) : 'bg-foreground/15',
          )}
          style={{ height: `${4 + i * 2}px` }}
        />
      ))}
    </span>
  );
}
