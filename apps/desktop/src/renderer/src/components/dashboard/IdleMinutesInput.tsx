import {
  MAX_IDLE_RESOURCE_MINUTES,
  MIN_IDLE_RESOURCE_MINUTES,
  normalizeIdleResourceMinutes,
} from '@runova/core';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A minutes box that only saves when you are done typing (Enter or leaving it), clamped into the
 * allowed range. Saving on every keystroke would turn "30" into a save of 3 along the way.
 */
export function IdleMinutesInput({
  value,
  onCommit,
  id,
  ariaLabel,
  className,
}: {
  value: number;
  onCommit: (minutes: number) => void;
  id?: string;
  ariaLabel?: string;
  className?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);

  function commit(): void {
    if (draft === null) return;
    const parsed = Number.parseInt(draft, 10);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    const next = normalizeIdleResourceMinutes(parsed);
    if (next !== value) onCommit(next);
  }

  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={MIN_IDLE_RESOURCE_MINUTES}
      max={MAX_IDLE_RESOURCE_MINUTES}
      aria-label={ariaLabel}
      className={cn('h-8 w-20', className)}
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}
