import {
  getUsageProvider,
  isAutoConnected,
  type ProviderUsage,
  USAGE_PROVIDER_REGISTRY,
  type UsageProviderConfig,
} from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { queryKeys } from '@/lib/queryKeys';

function isDisplayed(id: string, configs: Record<string, UsageProviderConfig>): boolean {
  const def = getUsageProvider(id);
  if (!def) return false;
  if (isAutoConnected(def)) return true;
  return !!configs[id]?.enabled;
}

export interface AgentUsageRow {
  id: string;
  name: string;
  accentColor: string;
  todayTokens: number;
  weekTokens: number;
  monthTokens: number;
  todayCost: number | null;
  weekCost: number | null;
  monthCost: number | null;
}

export interface UsageSummary {
  todayTokens: number;
  weekTokens: number;
  monthTokens: number;
  /** Today’s cost; kept for the dashboard tiles that already read `cost`. */
  cost: number;
  todayCost: number;
  weekCost: number;
  monthCost: number;
  hasCost: boolean;
  trackedCount: number;
  totalCount: number;
  okCount: number;
  series: number[];
  costSeries: number[];
  agents: AgentUsageRow[];
  isPending: boolean;
}

function sumSeries(items: Array<number[] | undefined>): number[] {
  let len = 0;
  for (const item of items) {
    if (item && item.length > len) len = item.length;
  }
  const out = new Array<number>(len).fill(0);
  for (const item of items) {
    if (!item) continue;
    for (let i = 0; i < item.length; i++) out[i] += item[i] ?? 0;
  }
  return out;
}

/**
 * Aggregate Token Usage totals across every tracked provider, using the same
 * numbers the Usage page's summary tiles show, computed independently so the
 * dashboard's pinned copies of those tiles don't depend on that page being
 * mounted.
 */
export function useUsageSummary(enabled = true): UsageSummary {
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    enabled,
  });
  const usageQuery = useQuery({
    queryKey: queryKeys.usageList,
    queryFn: () => window.runova.usage.list(),
    refetchInterval: 45_000,
    enabled,
  });

  const configs = settingsQuery.data?.usageProviderConfigs ?? {};
  const displayedIds = useMemo(
    () => USAGE_PROVIDER_REGISTRY.filter((d) => isDisplayed(d.id, configs)).map((d) => d.id),
    [configs],
  );
  const usageById = useMemo(() => {
    const map = new Map<string, ProviderUsage>();
    for (const u of usageQuery.data ?? []) map.set(u.providerId, u);
    return map;
  }, [usageQuery.data]);

  const totals = useMemo(() => {
    let todayTokens = 0;
    let weekTokens = 0;
    let monthTokens = 0;
    let todayCost = 0;
    let weekCost = 0;
    let monthCost = 0;
    let hasCost = false;
    const agents: AgentUsageRow[] = [];
    const tokenSeries: Array<number[] | undefined> = [];
    const costSeries: Array<number[] | undefined> = [];

    for (const id of displayedIds) {
      const u = usageById.get(id);
      const def = getUsageProvider(id);
      if (!u || u.status !== 'ok' || !def) continue;
      todayTokens += u.today.tokens.total;
      weekTokens += u.last7d.tokens.total;
      monthTokens += u.last30d.tokens.total;
      if (u.today.costUsd != null) {
        todayCost += u.today.costUsd;
        hasCost = true;
      }
      if (u.last7d.costUsd != null) {
        weekCost += u.last7d.costUsd;
        hasCost = true;
      }
      if (u.last30d.costUsd != null) {
        monthCost += u.last30d.costUsd;
        hasCost = true;
      }
      tokenSeries.push(u.series);
      costSeries.push(u.costSeries);
      agents.push({
        id,
        name: def.name,
        accentColor: def.accentColor,
        todayTokens: u.today.tokens.total,
        weekTokens: u.last7d.tokens.total,
        monthTokens: u.last30d.tokens.total,
        todayCost: u.today.costUsd,
        weekCost: u.last7d.costUsd,
        monthCost: u.last30d.costUsd,
      });
    }

    agents.sort((a, b) => b.weekTokens - a.weekTokens);

    return {
      todayTokens,
      weekTokens,
      monthTokens,
      cost: todayCost,
      todayCost,
      weekCost,
      monthCost,
      hasCost,
      okCount: agents.length,
      series: sumSeries(tokenSeries),
      costSeries: sumSeries(costSeries),
      agents,
    };
  }, [displayedIds, usageById]);

  return {
    ...totals,
    trackedCount: displayedIds.length,
    totalCount: USAGE_PROVIDER_REGISTRY.length,
    isPending: usageQuery.isPending || settingsQuery.isPending,
  };
}
