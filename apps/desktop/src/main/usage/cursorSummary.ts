import type { SubscriptionWindow, UsageWindow } from '@runova/core';

// Cursor's usage-based plans (Pro, Pro+, Ultra since mid-2025) meter spend
// rather than requests, so the old `/api/usage` request counter reads 0 with no
// cap for them. `/api/usage-summary` is what the dashboard's own "Usage" meter
// reads: the share of the plan's included usage spent this billing cycle, in
// total and split into Auto and API (named models), plus when the cycle ends.
// It is not a published contract, so every field is read defensively.

export interface CursorPlanLimits {
  /** The token-view card's limit bar. */
  window: UsageWindow;
  /** Total first, so the status bar leads with it; all share the cycle's end. */
  windows: SubscriptionWindow[];
}

function percent(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * The plan's limits from a usage-summary answer, or null when it has none to
 * show: an unlimited plan, a disabled plan bucket, or a shape we don't know.
 */
export function cursorPlanLimits(payload: unknown): CursorPlanLimits | null {
  if (payload === null || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (root.isUnlimited === true) return null;

  const individual = root.individualUsage as Record<string, unknown> | undefined;
  const plan = individual?.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== 'object' || plan.enabled === false) return null;

  const total = percent(plan.totalPercentUsed);
  if (total == null) return null;
  const resetAt = isoDate(root.billingCycleEnd);

  const windows: SubscriptionWindow[] = [
    { key: 'month', label: 'Monthly usage', percent: total, resetAt },
  ];
  const auto = percent(plan.autoPercentUsed);
  if (auto != null) windows.push({ key: 'month-auto', label: 'Auto', percent: auto, resetAt });
  const api = percent(plan.apiPercentUsed);
  if (api != null) windows.push({ key: 'month-api', label: 'API', percent: api, resetAt });

  return {
    window: { label: 'Plan usage', used: Math.round(total), total: 100, percent: total, resetAt },
    windows,
  };
}
