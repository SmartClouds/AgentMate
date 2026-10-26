import type {
  ProviderUsage,
  SubscriptionUsage,
  SubscriptionWindow,
  UsageProviderDefinition,
  UsageSegment,
  WidgetMode,
  WidgetPeriod,
  WidgetStyle,
} from '@runova/core';
import { useState } from 'react';
import { SparklineChart } from '@/components/dashboard/SparklineChart';
import { ProviderLogo } from '@/components/providerLogos';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useReadableAccent } from '@/lib/chartColors';
import {
  formatCost,
  formatCountdown,
  formatPercent,
  formatReset,
  formatTokens,
} from '@/lib/usageFormat';
import { CountUp } from './CountUp';
import { PeriodChips, PeriodCompare, periodDays, periodOf } from './PeriodCompare';

export interface UsageCardBodyProps {
  usage: ProviderUsage;
  def: UsageProviderDefinition;
  /** 'mono' tints everything with the foreground color; 'colorful' uses the brand accent. */
  style?: WidgetStyle;
  /** Compact drops the sparkline + secondary stats (small widget). */
  compact?: boolean;
  /** Hide the logo + name row when the host already renders the title (Usage page). */
  hideHeader?: boolean;
  /** Which of the two widgets this is. Defaults to the original tokens view. */
  mode?: WidgetMode;
  /** Headline window for tokens/cost. Uncontrolled on the Usage page. */
  period?: WidgetPeriod;
  onPeriodChange?: (period: WidgetPeriod) => void;
}

/**
 * The card body's shape while the scan is still running: the headline number,
 * a limit bar and the sparkline's row, all in their final positions so the card
 * doesn't jump when the real figures arrive. Each card shows this on its own,
 * since providers land one at a time, and the ones already in never go blank.
 */
export function UsageCardBodySkeleton({
  compact = false,
}: {
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="ml-auto h-4 w-12" />
      </div>
      <div className="space-y-1">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
      {!compact && <Skeleton className="mt-auto h-11 w-full" />}
    </div>
  );
}

/** Subscription limits are only worth showing when the account actually has them. */
export function hasSubscriptionView(usage: ProviderUsage): boolean {
  const sub = usage.subscription;
  return (
    !!sub && sub.mode === 'subscription' && Array.isArray(sub.windows) && sub.windows.length > 0
  );
}

/**
 * The inner content of a Token Usage card. Renders whichever of the two widgets
 * `mode` asks for: the original token view (tokens + cost + burn-rate
 * sparkline), or the subscription view (the plan's rolling limits and their
 * reset countdowns). The token view is the default and is deliberately
 * untouched by the subscription feature, right down to the header, which only
 * grows a plan badge in subscription mode.
 */
export function UsageCardBody({
  usage,
  def,
  style = 'colorful',
  compact = false,
  hideHeader = false,
  mode = 'tokens',
  period: periodProp,
  onPeriodChange,
}: UsageCardBodyProps): React.JSX.Element {
  const [localPeriod, setLocalPeriod] = useState<WidgetPeriod>(periodProp ?? 'day');
  const activePeriod = onPeriodChange ? (periodProp ?? 'day') : localPeriod;
  function setPeriod(next: WidgetPeriod): void {
    if (onPeriodChange) onPeriodChange(next);
    else setLocalPeriod(next);
  }

  // Brand hex as the registry states it, nudged only when that exact color
  // would be unreadable on the current theme's card (the many near-black
  // vendor accents against the dark surface).
  const brandAccent = useReadableAccent(def.accentColor);
  const accent = style === 'colorful' ? brandAccent : 'hsl(var(--foreground))';
  const subscription = usage.subscription;
  // The plan badge is account identity, not a limits readout, so it shows in
  // both widgets whenever the account is known: the token view of a Pro
  // account should still say Pro.
  const plan = subscription?.plan ?? null;

  const header = hideHeader ? null : (
    <div className="flex items-center gap-2">
      <ProviderLogo providerId={def.id} className="h-5 w-5" />
      <span className="truncate text-sm font-semibold">{def.name}</span>
      {plan && (
        <span
          className="ml-auto shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4"
          style={{ borderColor: `${accent}66`, color: accent }}
        >
          {plan.label}
        </span>
      )}
    </div>
  );

  if (usage.status === 'connect') {
    return (
      <div className="flex h-full flex-col gap-2">
        {header}
        <p className="text-xs text-muted-foreground">
          {def.dataSource === 'api-key'
            ? `${def.keyHint ?? 'API key'} required to track usage.`
            : def.dataSource === 'local-session'
              ? `Sign in to the ${def.name} app to track usage.`
              : 'Integration coming soon.'}
        </p>
      </div>
    );
  }

  // A read that failed but still got the plan limits draws them, with a note in place of the
  // tokens. The tokens view keeps the error text.
  const limitsView =
    mode === 'subscription' && hasSubscriptionView(usage) ? subscription : undefined;

  if (usage.status === 'error' && !limitsView) {
    return (
      <div className="flex h-full flex-col gap-2">
        {header}
        <SimpleTooltip label={usage.error}>
          <p className="truncate text-xs text-destructive">
            {usage.error ?? 'Failed to load usage.'}
          </p>
        </SimpleTooltip>
      </div>
    );
  }

  // 'subscription' is a request, not a guarantee. An API-billed account has no
  // limits to draw, so it falls back to tokens rather than rendering an empty card.
  if (limitsView) {
    return (
      <SubscriptionBody
        subscription={limitsView}
        usage={usage}
        accent={accent}
        compact={compact}
        header={header}
        tokensError={usage.status === 'error' ? usage.error : undefined}
      />
    );
  }

  const selected = periodOf(usage, activePeriod);
  const primaryTokens = selected.tokens.total;
  const primaryLabel =
    activePeriod === 'day' ? 'today' : activePeriod === 'week' ? 'this week' : 'this month';
  const costUsd = selected.costUsd;
  const cost = formatCost(costUsd);
  const days = periodDays(activePeriod);
  const avgTokens = days > 1 ? primaryTokens / days : null;
  const avgCost = days > 1 && costUsd != null ? costUsd / days : null;
  // Segments partition the period the headline number came from, so the rows
  // below always add up to it. Empty slices are dropped rather than shown as 0.
  const segments = (selected.segments ?? []).filter(
    (s) => s.tokens.total > 0 || (s.requests ?? 0) > 0,
  );
  const series = usage.series ?? [];
  const costSeries = usage.costSeries ?? [];
  const hasCostSeries = costSeries.some((n) => n > 0);
  const window = usage.window;
  const reset = formatReset(window?.resetAt);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {header}

      <PeriodChips value={activePeriod} onChange={setPeriod} />

      <div className="flex min-w-0 items-baseline gap-2">
        {/* Cost leads the headline in the provider accent; usage follows it. Without a
            price the tokens keep the headline on their own, as before. */}
        {cost ? (
          <>
            <span
              className="shrink-0 text-2xl font-semibold tabular-nums tracking-tight"
              style={{ color: accent }}
            >
              <CountUp
                value={costUsd ?? 0}
                format={(n) => formatCost(n) ?? '$0.00'}
                className="tabular-nums"
              />
            </span>
            <CountUp
              value={primaryTokens}
              format={formatTokens}
              className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground"
            />
            <span className="shrink-0 text-[11px] text-muted-foreground">
              tokens {primaryLabel}
            </span>
          </>
        ) : (
          <>
            <CountUp
              value={primaryTokens}
              format={formatTokens}
              className="text-2xl font-semibold tabular-nums tracking-tight"
            />
            <span className="shrink-0 text-[11px] text-muted-foreground">
              tokens {primaryLabel}
            </span>
          </>
        )}
      </div>

      {(avgTokens != null || avgCost != null) && (
        <div className="text-[11px] text-muted-foreground">
          avg {formatTokens(avgTokens ?? 0)} / day
          {avgCost != null ? ` · ${formatCost(avgCost)}` : ''}
        </div>
      )}

      {window && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate">
              {window.label} {formatPercent(window.percent)}
            </span>
            {reset && <span className="shrink-0">{reset}</span>}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
            <div
              className="h-full rounded-full transition-[width]"
              style={{ width: `${window.percent}%`, backgroundColor: accent }}
            />
          </div>
        </div>
      )}

      <PeriodCompare usage={usage} accent={accent} compact={compact} />

      {segments.length > 0 && (
        <SegmentBreakdown segments={segments} total={primaryTokens} accent={accent} />
      )}

      {!compact && series.length > 1 && (
        <div className="mt-auto space-y-2">
          <SparklineChart
            height={44}
            timestamps={series.map((_, i) => i)}
            domainMin={0}
            formatValue={formatTokens}
            series={[{ key: def.id, label: 'Tokens', color: accent, values: series }]}
          />
          {hasCostSeries && onPeriodChange && (
            <SparklineChart
              height={36}
              timestamps={costSeries.map((_, i) => i)}
              domainMin={0}
              formatValue={(n) => formatCost(n) ?? '$0.00'}
              series={[
                {
                  key: `${def.id}-cost`,
                  label: 'Cost',
                  color: accent,
                  values: costSeries,
                },
              ]}
            />
          )}
          <div className="flex justify-between gap-2 text-[10px] text-muted-foreground">
            <span>14-day trend</span>
            <span className="tabular-nums">
              7d {formatTokens(usage.last7d.tokens.total)}
              {formatCost(usage.last7d.costUsd) ? ` · ${formatCost(usage.last7d.costUsd)}` : ''}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Shades of the one accent, so a split reads as one provider's usage. */
function segmentOpacity(index: number): number {
  return [1, 0.55, 0.3, 0.18][index] ?? 0.18;
}

/**
 * How one period splits across named slices: Cursor's Auto mode versus what it
 * billed at API rates. A stacked share bar carries the ratio at a glance (the
 * part that still works at widget size), and a row per slice gives the tokens,
 * cost and request count behind it.
 */
function SegmentBreakdown({
  segments,
  total,
  accent,
}: {
  segments: UsageSegment[];
  total: number;
  accent: string;
}): React.JSX.Element {
  // The bar is a ratio of the slices themselves. Falling back to the period
  // total would leave a phantom gap when a slice has requests but no tokens.
  const barTotal = segments.reduce((sum, s) => sum + s.tokens.total, 0) || total;

  return (
    <div className="space-y-1">
      {barTotal > 0 && (
        <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-foreground/10">
          {segments.map((segment, i) => (
            <div
              key={segment.key}
              style={{
                width: `${(segment.tokens.total / barTotal) * 100}%`,
                backgroundColor: accent,
                opacity: segmentOpacity(i),
              }}
            />
          ))}
        </div>
      )}
      {segments.map((segment, i) => {
        const segmentCost = formatCost(segment.costUsd);
        return (
          <div key={segment.key} className="flex items-baseline gap-2 text-[11px]">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: accent, opacity: segmentOpacity(i) }}
              />
              <span className="truncate">{segment.label}</span>
            </span>
            <span className="ml-auto shrink-0 tabular-nums">
              {formatTokens(segment.tokens.total)}
            </span>
            {segmentCost && (
              <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                {segmentCost}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Plan name, one bar per rolling limit, and what it cost so far today. */
function SubscriptionBody({
  subscription,
  usage,
  accent,
  compact,
  header,
  tokensError,
}: {
  subscription: SubscriptionUsage;
  usage: ProviderUsage;
  accent: string;
  compact: boolean;
  header: React.ReactNode;
  /** Set when the token totals failed to load; the limits above are still good. */
  tokensError?: string;
}): React.JSX.Element {
  const estimated = subscription.source === 'estimate';
  const cost = formatCost(usage.today.costUsd);

  return (
    <div className="flex h-full flex-col gap-2">
      {header}

      <div className="flex flex-col gap-2">
        {subscription.windows.map((window) => (
          <LimitBar key={window.key} window={window} accent={accent} estimated={estimated} />
        ))}
      </div>

      {!compact && (
        <div className="mt-auto flex items-baseline gap-2 pt-1 text-[11px] text-muted-foreground">
          {tokensError ? (
            <SimpleTooltip label={tokensError}>
              <span className="truncate">Token totals could not be loaded</span>
            </SimpleTooltip>
          ) : (
            <>
              <span className="tabular-nums">
                {formatTokens(usage.today.tokens.total)} tokens today
              </span>
              {cost && <span className="tabular-nums">· {cost} equivalent</span>}
            </>
          )}
          {estimated && (
            <SimpleTooltip
              label={`Estimated from local logs: ${subscription.estimateReason ?? 'account unreachable'}.`}
            >
              <span className="ml-auto shrink-0">estimated</span>
            </SimpleTooltip>
          )}
        </div>
      )}
    </div>
  );
}

/** One rolling limit: name, share consumed, countdown, and a fill bar. */
function LimitBar({
  window,
  accent,
  estimated,
}: {
  window: SubscriptionWindow;
  accent: string;
  estimated: boolean;
}): React.JSX.Element {
  const countdown = formatCountdown(window.resetAt);
  // Near the cap the brand accent stops being the useful signal.
  const color = window.percent >= 90 ? 'hsl(var(--destructive))' : accent;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">{window.label}</span>
        <span className="font-medium tabular-nums" style={{ color }}>
          {estimated ? '~' : ''}
          {formatPercent(window.percent)}
        </span>
        {countdown && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            resets in {countdown}
          </span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${window.percent}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
