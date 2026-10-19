import {
  getUsageProvider,
  type ProviderUsage,
  STATUS_BAR_USAGE_PROVIDERS,
  type SubscriptionWindow,
} from '@agentmat/core';

/**
 * ok: the account's own numbers. estimate: worked out from local logs because the account did not
 * answer. stale: the last numbers the account gave, from an earlier read. unavailable: nothing to show.
 */
export type LimitState = 'ok' | 'estimate' | 'stale' | 'unavailable';

/** One provider's item in the status bar, worked out from its usage snapshot. */
export interface LimitChip {
  providerId: string;
  name: string;
  plan: string | null;
  state: LimitState;
  /** The limits to draw: the live ones when the read worked, the last known ones when it did not. */
  windows: SubscriptionWindow[];
  /** ISO time the drawn limits were read, when known. */
  asOf: string | null;
  /** What went wrong, for the panel. Null when the numbers are the account's own and current. */
  problem: string | null;
}

/** The windows a snapshot can draw now: a reset time to count down to, or some of the limit used. */
export function liveWindows(usage: ProviderUsage): SubscriptionWindow[] {
  return (usage.subscription?.windows ?? []).filter((w) => w.resetAt || w.percent > 0);
}

/**
 * One chip per AI subscription, in a fixed order, minus any switched off in Settings. A read that
 * failed keeps its chip: with the last limits it dims, and with none it shows a warning. A chip
 * only goes when the account has nothing to count down to, so a provider never vanishes because
 * a read failed.
 */
export function buildLimitChips(
  list: ProviderUsage[] | undefined,
  shown: Partial<Record<string, boolean>> | undefined,
): LimitChip[] {
  const chips: LimitChip[] = [];
  for (const providerId of STATUS_BAR_USAGE_PROVIDERS) {
    if (shown?.[providerId] === false) continue;
    const usage = list?.find((u) => u.providerId === providerId);
    if (!usage) continue;

    const name = getUsageProvider(providerId)?.name ?? providerId;
    const plan = usage.subscription?.plan?.label ?? null;
    const live = liveWindows(usage);
    const estimated = usage.subscription?.source === 'estimate';

    // An estimate is a guess from local logs. The last reading the account itself gave is closer to
    // the truth, so it wins while it lasts, marked as out of date.
    if (estimated && usage.lastLimits) {
      chips.push({
        providerId,
        name,
        plan: usage.lastLimits.plan?.label ?? plan,
        state: 'stale',
        windows: usage.lastLimits.windows,
        asOf: usage.lastLimits.readAt,
        problem: usage.subscription?.estimateReason ?? 'account unreachable',
      });
      continue;
    }

    if (estimated && live.length > 0) {
      chips.push({
        providerId,
        name,
        plan,
        state: 'estimate',
        windows: live,
        asOf: usage.subscription?.readAt ?? usage.updatedAt,
        problem: usage.subscription?.estimateReason ?? 'account unreachable',
      });
      continue;
    }

    if (live.length > 0) {
      chips.push({
        providerId,
        name,
        plan,
        state: 'ok',
        windows: live,
        // When the limits were read, not when the snapshot was put together: the account's answer
        // is held between reads, and Codex only reports on its own turns.
        asOf: usage.subscription?.readAt ?? usage.updatedAt,
        problem: null,
      });
      continue;
    }

    const problem = usage.limitsError ?? usage.error ?? 'No reading came back.';
    if (usage.lastLimits) {
      chips.push({
        providerId,
        name,
        plan: usage.lastLimits.plan?.label ?? plan,
        state: 'stale',
        windows: usage.lastLimits.windows,
        asOf: usage.lastLimits.readAt,
        problem,
      });
    } else if (usage.limitsError !== undefined || usage.status === 'error') {
      chips.push({
        providerId,
        name,
        plan,
        state: 'unavailable',
        windows: [],
        asOf: null,
        problem,
      });
    }
  }
  return chips;
}

/** The list with one provider's snapshot swapped in, or added when the list has none for it. */
export function mergeProviderUsage(list: ProviderUsage[], next: ProviderUsage): ProviderUsage[] {
  if (!list.some((u) => u.providerId === next.providerId)) return [...list, next];
  return list.map((u) => (u.providerId === next.providerId ? next : u));
}
