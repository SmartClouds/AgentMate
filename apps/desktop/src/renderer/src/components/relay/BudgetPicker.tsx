import { formatTokenCount, RELAY_BUDGET_CHOICES } from '@agentmat/core';
import { cn } from '@/lib/utils';

/** The session budget, as a row of the choices the board knows. */
export function BudgetPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Session budget"
      className="field-surface inline-flex h-8 items-stretch gap-0.5 rounded-full p-0.5"
    >
      {RELAY_BUDGET_CHOICES.map((choice) => {
        const selected = value === choice;
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={formatTokenCount(choice)}
            disabled={disabled}
            onClick={() => onChange(choice)}
            className={cn(
              'min-w-12 cursor-pointer rounded-full px-2.5 font-mono text-xs tabular-nums transition-colors disabled:pointer-events-none',
              selected
                ? 'bg-primary/15 font-medium text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
                : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
            )}
          >
            {formatTokenCount(choice)}
          </button>
        );
      })}
    </div>
  );
}
