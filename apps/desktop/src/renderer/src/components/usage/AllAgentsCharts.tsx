import type { WidgetPeriod } from '@runova/core';
import { motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { SparklineChart } from '@/components/dashboard/SparklineChart';
import { ChartColumn } from '@/components/icons';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { type AgentUsageRow, useUsageSummary } from '@/hooks/useUsageSummary';
import { useChartColors, useReadableAccent } from '@/lib/chartColors';
import { formatCost, formatTokens } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';
import { CountUp } from './CountUp';
import { PeriodChips, PeriodTotalsCompare, periodDays } from './PeriodCompare';

function tokensFor(row: AgentUsageRow, period: WidgetPeriod): number {
  if (period === 'week') return row.weekTokens;
  if (period === 'month') return row.monthTokens;
  return row.todayTokens;
}

function costFor(row: AgentUsageRow, period: WidgetPeriod): number | null {
  if (period === 'week') return row.weekCost;
  if (period === 'month') return row.monthCost;
  return row.todayCost;
}

/**
 * Combined usage, average, and cost across every tracked agent. Used on the
 * Token Usage page and as the All agents desktop widget. Spotlight glass and
 * count-up figures follow the same React Bits language as the per-provider cards.
 */
export function AllAgentsCharts({
  compact = false,
  framed = true,
  period: periodProp,
  onPeriodChange,
  actions,
  className,
}: {
  compact?: boolean;
  /** Wrap in a glass card (Usage page). The desktop widget already has glass. */
  framed?: boolean;
  period?: WidgetPeriod;
  onPeriodChange?: (period: WidgetPeriod) => void;
  actions?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const summary = useUsageSummary();
  const { green } = useChartColors();
  const [localPeriod, setLocalPeriod] = useState<WidgetPeriod>(periodProp ?? 'week');
  const period = onPeriodChange ? (periodProp ?? 'week') : localPeriod;

  function setPeriod(next: WidgetPeriod): void {
    if (onPeriodChange) onPeriodChange(next);
    else setLocalPeriod(next);
  }

  const tokens =
    period === 'week'
      ? summary.weekTokens
      : period === 'month'
        ? summary.monthTokens
        : summary.todayTokens;
  const costUsd =
    period === 'week'
      ? summary.weekCost
      : period === 'month'
        ? summary.monthCost
        : summary.todayCost;
  const label = period === 'day' ? 'today' : period === 'week' ? 'this week' : 'this month';
  const days = periodDays(period);
  const avgTokens = days > 1 ? tokens / days : null;
  const avgCost = days > 1 && summary.hasCost ? costUsd / days : null;
  const perAgentTokens = summary.okCount > 0 ? tokens / summary.okCount : null;
  const perAgentCost = summary.hasCost && summary.okCount > 0 ? costUsd / summary.okCount : null;

  const body = summary.isPending ? (
    <div className="space-y-3">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  ) : summary.okCount === 0 ? (
    <p className="text-sm text-muted-foreground">
      Track a provider to see combined usage, averages, and cost across your agents.
    </p>
  ) : (
    <div className="flex min-h-0 grow flex-col gap-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <CountUp
          value={tokens}
          format={formatTokens}
          className="widget-gradient-text text-2xl font-semibold tabular-nums tracking-tight"
        />
        <span className="shrink-0 text-[11px] text-muted-foreground">tokens {label}</span>
        {summary.hasCost && (
          <CountUp
            value={costUsd}
            format={(n) => formatCost(n) ?? '$0.00'}
            className="ml-auto shrink-0 text-sm font-medium tabular-nums"
          />
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {avgTokens != null && (
          <span>
            avg {formatTokens(avgTokens)} / day
            {avgCost != null ? ` · ${formatCost(avgCost)}` : ''}
          </span>
        )}
        {perAgentTokens != null && (
          <span>
            avg {formatTokens(perAgentTokens)} / agent
            {perAgentCost != null ? ` · ${formatCost(perAgentCost)}` : ''}
          </span>
        )}
        <span>
          {summary.okCount} agent{summary.okCount === 1 ? '' : 's'}
        </span>
      </div>

      <PeriodTotalsCompare
        tokens={{
          day: summary.todayTokens,
          week: summary.weekTokens,
          month: summary.monthTokens,
        }}
        costs={
          summary.hasCost
            ? {
                day: summary.todayCost,
                week: summary.weekCost,
                month: summary.monthCost,
              }
            : null
        }
        accent={green}
        compact={compact}
      />

      <AgentBreakdown agents={summary.agents} period={period} compact={compact} />

      {!compact && summary.series.length > 1 && (
        <div className="flex min-h-0 grow flex-col gap-1">
          <SparklineChart
            className="min-h-[44px] grow"
            height={44}
            timestamps={summary.series.map((_, i) => i)}
            domainMin={0}
            formatValue={formatTokens}
            series={[{ key: 'all', label: 'Tokens', color: green, values: summary.series }]}
          />
          {summary.hasCost && summary.costSeries.some((n) => n > 0) && (
            <SparklineChart
              className="h-9 shrink-0"
              height={36}
              timestamps={summary.costSeries.map((_, i) => i)}
              domainMin={0}
              formatValue={(n) => formatCost(n) ?? '$0.00'}
              series={[
                { key: 'all-cost', label: 'Cost', color: green, values: summary.costSeries },
              ]}
            />
          )}
          <div className="shrink-0 text-[10px] text-muted-foreground">
            14-day trend across all agents
          </div>
        </div>
      )}
    </div>
  );

  const header = (
    <div className="mb-2 flex items-center gap-2">
      <ChartColumn className="h-4 w-4 shrink-0 text-primary" />
      <span className="truncate text-sm font-semibold">All agents</span>
      <PeriodChips value={period} onChange={setPeriod} className="ml-1" />
      {actions && <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span>}
    </div>
  );

  if (!framed) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {body}
      </div>
    );
  }

  return (
    <Card className={cn('glass', className)}>
      <CardContent className="flex h-full min-h-0 flex-col p-4">
        {header}
        {body}
      </CardContent>
    </Card>
  );
}

function AgentBreakdown({
  agents,
  period,
  compact,
}: {
  agents: AgentUsageRow[];
  period: WidgetPeriod;
  compact: boolean;
}): React.JSX.Element | null {
  const rows = agents
    .map((agent) => ({
      ...agent,
      tokens: tokensFor(agent, period),
      cost: costFor(agent, period),
    }))
    .filter((row) => row.tokens > 0 || (row.cost ?? 0) > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const visible = compact ? rows.slice(0, 4) : rows;
  const max = Math.max(1, ...visible.map((row) => row.tokens));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        By agent
      </div>
      {visible.map((row, index) => (
        <AgentBar key={row.id} row={row} max={max} index={index} />
      ))}
    </div>
  );
}

function AgentBar({
  row,
  max,
  index,
}: {
  row: AgentUsageRow & { tokens: number; cost: number | null };
  max: number;
  index: number;
}): React.JSX.Element {
  const accent = useReadableAccent(row.accentColor);
  const cost = formatCost(row.cost);
  const reduce = useReducedMotion();

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: reduce ? 0 : Math.min(index * 0.04, 0.24), duration: 0.25 }}
      className="grid grid-cols-[minmax(0,5.5rem)_1fr_auto] items-center gap-1.5"
    >
      <span className="truncate text-[11px] text-muted-foreground">{row.name}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
        <div
          className="bar-shine h-full rounded-full"
          style={{
            width: `${Math.max(row.tokens > 0 ? 4 : 0, (row.tokens / max) * 100)}%`,
            backgroundColor: accent,
          }}
        />
      </div>
      <span className="shrink-0 text-right text-[11px] tabular-nums">
        {formatTokens(row.tokens)}
        {cost ? <span className="text-muted-foreground"> · {cost}</span> : null}
      </span>
    </motion.div>
  );
}
