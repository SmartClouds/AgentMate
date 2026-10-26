import { estimateStrength, STRENGTH_LABELS, scoreForBits } from '@runova/core';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

const SEGMENTS = 5;

const SCORE_COLOR = [
  'bg-destructive',
  'bg-destructive',
  'bg-warning',
  'bg-success',
  'bg-success',
] as const;

/**
 * Five segments that fill with the score. `bits` replaces the estimate for passwords the
 * generator made, whose real entropy is known exactly.
 */
export function PasswordStrengthMeter({
  password,
  context,
  bits,
  showWarning = true,
  className,
}: {
  password: string;
  context?: string[];
  bits?: number;
  showWarning?: boolean;
  className?: string;
}): React.JSX.Element | null {
  const result = useMemo(() => {
    if (bits !== undefined) {
      const score = scoreForBits(bits);
      return { bits, score, label: STRENGTH_LABELS[score], warnings: [] as string[] };
    }
    return estimateStrength(password, context);
  }, [password, context, bits]);

  if (!password) return null;

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center gap-3">
        <div
          role="meter"
          aria-label="Password strength"
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={result.score}
          aria-valuetext={result.label}
          className="flex flex-1 gap-1"
        >
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <span
              key={i}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors duration-300',
                i <= result.score ? SCORE_COLOR[result.score] : 'bg-foreground/10',
              )}
            />
          ))}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {result.label}
          {bits !== undefined && ` · ${Math.round(result.bits)} bits`}
        </span>
      </div>
      {/* Past "Fair" a pattern warning would only contradict the label. */}
      {showWarning && result.score < 3 && result.warnings[0] && (
        <p className="text-xs text-muted-foreground">{result.warnings[0]}</p>
      )}
    </div>
  );
}
