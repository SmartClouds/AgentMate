import { FABLE_WEEK_LABEL, getUsageProvider, type SubscriptionWindowKey } from '@runova/core';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
import { showOsNotification } from '../notifications/osNotification';
import { store } from '../store';
import { getProviderUsage } from './index';

// OS-level "you're near your limit" alerts. Unlike reset alerts, there is no
// moment to count down to. Each tick just compares the window's current
// `percent` against the threshold. What needs remembering is which window
// already fired, keyed by that window's `resetAt`: a window sitting above the
// threshold must not re-announce itself every tick, but once it rolls over
// (a new `resetAt`, or the percent drops back below threshold) it is free to
// fire again next time it crosses.

const TICK_MS = 60_000;

const WINDOW_LABELS: Record<SubscriptionWindowKey, string> = {
  session: 'Session (5h)',
  week: 'Weekly',
  'week-fable': FABLE_WEEK_LABEL,
  month: 'Monthly',
  'month-auto': 'Auto',
  'month-api': 'API',
};

let timer: NodeJS.Timeout | null = null;
const fired = new Map<SubscriptionWindowKey, string | null>();

function broadcast(channel: string, payload: unknown): void {
  broadcastToWindows(channel, payload);
}

/**
 * OS notification when the platform supports one; an in-app toast otherwise. Clicking it
 * brings the app forward on the Token Usage page, scrolled to the provider that fired.
 */
function notify(title: string, body: string, providerId: string): void {
  const route = `/usage?provider=${encodeURIComponent(providerId)}`;
  if (showOsNotification({ title, body, route })) return;
  broadcast(IPC.usage.onThresholdAlert, { title, body, providerId });
}

async function tick(): Promise<void> {
  const settings = await store.getSettings();
  const alerts = settings.usageThresholdAlerts;
  if (!alerts?.enabled) {
    fired.clear();
    return;
  }

  const config = settings.usageProviderConfigs?.[alerts.providerId];
  let windows;
  try {
    const usage = await getProviderUsage(alerts.providerId, config);
    windows = usage.subscription?.windows ?? [];
  } catch {
    // Offline, an expired grant, or a log scan that threw. The next tick retries.
    return;
  }

  const providerName = getUsageProvider(alerts.providerId)?.name ?? alerts.providerId;
  for (const key of new Set(alerts.windows)) {
    const window = windows.find((w) => w.key === key);
    if (!window || window.percent < alerts.threshold) {
      fired.delete(key);
      continue;
    }
    if (fired.has(key) && fired.get(key) === window.resetAt) continue; // already announced

    fired.set(key, window.resetAt);
    const pct = Math.round(window.percent);
    notify(
      `${providerName}: ${window.label} at ${pct}%`,
      `You've used ${pct}% of your ${window.label.toLowerCase()} limit.`,
      alerts.providerId,
    );
  }
}

export function startThresholdAlertWatcher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  // Never hold the process open on this alone.
  timer.unref?.();
  void tick();
}

export function stopThresholdAlertWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
  fired.clear();
}

/**
 * Send the notification the user would get at the real threshold, so they can
 * confirm OS notifications (or the in-app fallback) work without waiting for
 * real usage to climb.
 */
export async function sendThresholdAlertTest(): Promise<{ ok: boolean; error?: string }> {
  const settings = await store.getSettings();
  const alerts = settings.usageThresholdAlerts;
  const providerName = getUsageProvider(alerts.providerId)?.name ?? alerts.providerId;
  const key = alerts.windows[0] ?? 'session';
  const label = WINDOW_LABELS[key] ?? 'Session (5h)';
  notify(
    `🧪 Test: ${providerName} · ${label}`,
    `This is what an alert looks like at ${alerts.threshold}% usage.`,
    alerts.providerId,
  );
  return { ok: true };
}
