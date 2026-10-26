import type { ProviderUsage, WidgetPeriod } from '@runova/core';
import { formatCost, formatTokens } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';

export const WIDGET_PERIODS: { id: WidgetPeriod; label: string; days: number }[] = [
  { id: 'day', label: 'Day', days: 1 },
  { id: 'week', label: 'Week', days: 7 },
  { id: 'month', label: 'Month', days: 30 },
];

export function periodDays(period: WidgetPeriod): number {
  return WIDGET_PERIODS.find((p) => p.id === period)?.days ?? 1;
}

export function periodOf(usage: ProviderUsage, period: WidgetPeriod) {
  if (period === 'week') return usage.last7d;
  if (period === 'month') return usage.last30d;
  return usage.today;
}

export function PeriodChips({
  value,
  onChange,
  className,
}: {
  value: WidgetPeriod;
  onChange: (period: WidgetPeriod) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn('inline-flex rounded-full bg-foreground/8 p-0.5', className)}
      role="tablist"
      aria-label="Usage period"
    >
      {WIDGET_PERIODS.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
              active
                ? 'bg-background/80 text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Side-by-side day / week / month bars for tokens and cost, so a glance
 * compares the three windows without opening another view.
 */
export function PeriodCompare({
  usage,
  accent,
  compact = false,
}: {
  usage: ProviderUsage;
  accent: string;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <PeriodTotalsCompare
      tokens={{
        day: usage.today.tokens.total,
        week: usage.last7d.tokens.total,
        month: usage.last30d.tokens.total,
      }}
      costs={
        usage.today.costUsd != null || usage.last7d.costUsd != null || usage.last30d.costUsd != null
          ? {
              day: usage.today.costUsd ?? 0,
              week: usage.last7d.costUsd ?? 0,
              month: usage.last30d.costUsd ?? 0,
            }
          : null
      }
      accent={accent}
      compact={compact}
    />
  );
}

/** Same bars as {@link PeriodCompare}, fed from already-summed totals. */
export function PeriodTotalsCompare({
  tokens,
  costs,
  accent,
  compact = false,
}: {
  tokens: { day: number; week: number; month: number };
  costs?: { day: number; week: number; month: number } | null;
  accent: string;
  compact?: boolean;
}): React.JSX.Element {
  const tokenRows = WIDGET_PERIODS.map((option) => ({
    label: option.label,
    value: tokens[option.id === 'day' ? 'day' : option.id === 'week' ? 'week' : 'month'],
  }));
  const maxTokens = Math.max(1, ...tokenRows.map((row) => row.value));
  const costRows = costs
    ? WIDGET_PERIODS.map((option) => ({
        label: option.label,
        value: costs[option.id === 'day' ? 'day' : option.id === 'week' ? 'week' : 'month'],
      }))
    : [];
  const maxCost = Math.max(0.01, ...costRows.map((row) => row.value));

  return (
    <div className={cn('grid gap-2', compact ? 'grid-cols-1' : 'grid-cols-2')}>
      <CompareColumn
        title="Usage"
        accent={accent}
        rows={tokenRows.map((row) => ({
          ...row,
          max: maxTokens,
          display: formatTokens(row.value),
        }))}
      />
      {costRows.length > 0 && (
        <CompareColumn
          title="Cost"
          accent={accent}
          rows={costRows.map((row) => ({
            ...row,
            max: maxCost,
            display: formatCost(row.value) ?? '$0.00',
          }))}
        />
      )}
    </div>
  );
}

function CompareColumn({
  title,
  accent,
  rows,
}: {
  title: string;
  accent: string;
  rows: { label: string; value: number; max: number; display: string }[];
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[2.6rem_1fr_auto] items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{row.label}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <div
              className="bar-shine h-full rounded-full transition-[width] duration-300"
              style={{
                width: `${Math.max(row.value > 0 ? 4 : 0, (row.value / row.max) * 100)}%`,
                backgroundColor: accent,
              }}
            />
          </div>
          <span className="min-w-[2.75rem] text-right text-[11px] tabular-nums">{row.display}</span>
        </div>
      ))}
    </div>
  );
}
