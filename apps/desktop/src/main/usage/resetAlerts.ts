import {
  getUsageProvider,
  type SubscriptionUsage,
  type SubscriptionWindow,
  type SubscriptionWindowKey,
  type UsageResetAlertSettings,
} from '@runova/core';
import { sendTelegramMessage } from '../notifications/telegramApi';
import { store } from '../store';
import { getProviderUsage } from './index';

// Telegram announcements for rate-limit rollovers.
//
// There is no schedule to author here: a window already carries the moment it
// resets (`SubscriptionWindow.resetAt`), whether that came from the account's
// own quota endpoint or from the local estimate. So the job is to hold onto
// those moments and fire once each has passed.
//
// The loop deliberately separates the two costs. Noticing a rollover is a
// timestamp comparison, so it runs every minute and keeps the alert within a
// minute of the real reset. Re-deriving the schedule means rescanning
// transcripts, so it runs an order of magnitude less often. Announcing happens
// before rescanning within a tick, which is what stops a rollover from being
// overwritten by the fresh schedule that replaces it.

const TICK_MS = 60_000;
const RESCAN_MS = 10 * 60_000;

interface TrackedWindow {
  label: string;
  /** Epoch ms this window rolls over. */
  resetAt: number;
  /** Plan label at the time it was scheduled, for the message body. */
  planLabel: string | null;
}

let timer: NodeJS.Timeout | null = null;
let lastScanAt = 0;
const tracked = new Map<SubscriptionWindowKey, TrackedWindow>();

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function renderResetMessage(
  providerName: string,
  window: TrackedWindow,
  key: SubscriptionWindowKey,
  nextResetAt: number | null,
): string {
  const lines = [
    `🔄 ${providerName}: ${window.label} limit reset`,
    window.planLabel ? `Plan: ${window.planLabel}` : null,
    `Reset at: ${formatTime(window.resetAt)}`,
    '',
    key === 'session'
      ? 'Your 5-hour session window has rolled over. Full quota is available again.'
      : 'This window has rolled over. Full quota is available again.',
  ];
  if (nextResetAt !== null) lines.push(`Next reset: ${formatTime(nextResetAt)}`);
  return lines.filter((line) => line !== null).join('\n');
}

/** Resolve where reset messages go, or null when Telegram isn't set up yet. */
async function resolveTarget(
  alerts: UsageResetAlertSettings,
): Promise<{ botToken: string; chatId: string } | null> {
  const settings = await store.getSettings();
  const botToken = settings.telegramBotToken;
  const chatId = alerts.chatId ?? settings.telegramChatId;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

async function readSubscription(
  providerId: string,
  force: boolean,
): Promise<SubscriptionUsage | null> {
  const settings = await store.getSettings();
  const config = settings.usageProviderConfigs?.[providerId];
  try {
    const usage = await getProviderUsage(providerId, config, force);
    return usage.subscription ?? null;
  } catch {
    // Offline, an expired grant, or a log scan that threw. The next tick
    // retries, and a missed schedule refresh is not worth surfacing.
    return null;
  }
}

function pickWindow(
  windows: SubscriptionWindow[],
  key: SubscriptionWindowKey,
): SubscriptionWindow | undefined {
  return windows.find((window) => window.key === key);
}

/**
 * Re-derive which rollovers are still ahead of us. Windows the plan doesn't
 * report, and ones with no reset moment to count down to (an idle account has
 * no session block in progress), are dropped rather than kept stale.
 */
async function refreshSchedule(alerts: UsageResetAlertSettings, force: boolean): Promise<void> {
  lastScanAt = Date.now();
  const subscription = await readSubscription(alerts.providerId, force);
  if (!subscription) return;

  const now = Date.now();
  const planLabel = subscription.plan?.label ?? null;
  for (const key of new Set(alerts.windows)) {
    const window = pickWindow(subscription.windows, key);
    const resetAt = window?.resetAt ? Date.parse(window.resetAt) : NaN;
    if (!window || Number.isNaN(resetAt) || resetAt <= now) {
      tracked.delete(key);
      continue;
    }
    tracked.set(key, { label: window.label, resetAt, planLabel });
  }

  // Drop windows the user has since unchecked.
  for (const key of tracked.keys()) {
    if (!alerts.windows.includes(key)) tracked.delete(key);
  }
}

async function announce(
  alerts: UsageResetAlertSettings,
  due: [SubscriptionWindowKey, TrackedWindow][],
): Promise<void> {
  const target = await resolveTarget(alerts);
  if (!target) return;
  const providerName = getUsageProvider(alerts.providerId)?.name ?? alerts.providerId;

  for (const [key, window] of due) {
    // The window that just closed is followed by a new one only once the user
    // is active again, so the next reset is often genuinely unknown here.
    const next = tracked.get(key)?.resetAt ?? null;
    await sendTelegramMessage(
      target.botToken,
      target.chatId,
      renderResetMessage(providerName, window, key, next),
    );
  }
}

async function tick(): Promise<void> {
  const settings = await store.getSettings();
  const alerts = settings.usageResetAlerts;
  if (!alerts?.enabled) {
    tracked.clear();
    return;
  }

  const now = Date.now();
  const due: [SubscriptionWindowKey, TrackedWindow][] = [];
  for (const [key, window] of tracked) {
    if (window.resetAt <= now) {
      due.push([key, window]);
      tracked.delete(key);
    }
  }

  // Refresh before announcing so the message can name the next reset. `due` is
  // already captured, so the rebuilt schedule can't swallow the rollover.
  // A rollover invalidates the cached scan, so force past it; otherwise only
  // refresh on the slow cadence.
  if (due.length > 0 || now - lastScanAt >= RESCAN_MS) {
    await refreshSchedule(alerts, due.length > 0);
  }
  if (due.length > 0) await announce(alerts, due);
}

/** Re-read settings and rebuild the schedule now, e.g. after the user toggles the switch. */
export async function refreshResetAlerts(): Promise<void> {
  const settings = await store.getSettings();
  const alerts = settings.usageResetAlerts;
  if (!alerts?.enabled) {
    tracked.clear();
    return;
  }
  await refreshSchedule(alerts, false);
}

export function startResetAlertWatcher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // Never hold the process open on this alone.
  timer.unref?.();
  void refreshResetAlerts();
}

export function stopResetAlertWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
  tracked.clear();
  lastScanAt = 0;
}

/**
 * Send the message the user would get at the next rollover, so they can confirm
 * the bot and chat are wired up without waiting hours for a real reset.
 */
export async function sendResetAlertTest(): Promise<{ ok: boolean; error?: string }> {
  const settings = await store.getSettings();
  const alerts = settings.usageResetAlerts;
  const target = await resolveTarget(alerts);
  if (!target) {
    return {
      ok: false,
      error: 'Set a Telegram bot token and chat ID in Settings first.',
    };
  }

  const subscription = await readSubscription(alerts.providerId, false);
  const providerName = getUsageProvider(alerts.providerId)?.name ?? alerts.providerId;
  const key = alerts.windows[0] ?? 'session';
  const window = subscription ? pickWindow(subscription.windows, key) : undefined;
  const preview: TrackedWindow = {
    label: window?.label ?? 'Session (5h)',
    resetAt: window?.resetAt ? Date.parse(window.resetAt) : Date.now(),
    planLabel: subscription?.plan?.label ?? null,
  };

  const result = await sendTelegramMessage(
    target.botToken,
    target.chatId,
    `🧪 Test: this is what a reset alert looks like.\n\n${renderResetMessage(providerName, preview, key, null)}`,
  );
  return { ok: result.ok, error: result.error };
}
