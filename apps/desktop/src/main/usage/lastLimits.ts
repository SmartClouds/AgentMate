import type { LastKnownLimits, ProviderUsage, SubscriptionWindow } from '@agentmat/core';

// The plan limits a provider last reported, kept in the main process so a failed read can still
// hand them back. A failure must not take a provider's limits off the status bar, but stale numbers
// must never pass for current ones: they only travel as `lastLimits`, which the status bar draws
// dimmed and marked.
//
// Every read that finishes is one of three things:
//   fresh    live windows came back: remember them.
//   none     the plan has no limits right now (unlimited, API billed, a Codex window between
//            resets) or the account is signed out: forget what was remembered.
//   unknown  the limits could not be read (`limitsError`, an error with no subscription, or windows
//            estimated from local logs because the account did not answer): hand back the
//            remembered windows that have not reset yet. An estimate is never remembered, so it
//            cannot replace numbers the account really reported.

type ReadKind = 'fresh' | 'none' | 'unknown';

/** The windows a snapshot can draw now: a reset time to count down to, or some of the limit used. */
function liveWindows(usage: ProviderUsage): SubscriptionWindow[] {
  return (usage.subscription?.windows ?? []).filter((w) => w.resetAt || w.percent > 0);
}

function readKind(usage: ProviderUsage): ReadKind {
  if (usage.subscription?.source === 'estimate') return 'unknown';
  if (liveWindows(usage).length > 0) return 'fresh';
  if (usage.status === 'connect') return 'none';
  // An error that still carries a subscription means the limits were read and came back empty,
  // which is how an unlimited plan looks when its token feed fails.
  if (
    usage.limitsError === undefined &&
    (usage.status === 'ok' || usage.subscription !== undefined)
  ) {
    return 'none';
  }
  return 'unknown';
}

interface Remembered {
  plan: LastKnownLimits['plan'];
  windows: SubscriptionWindow[];
  readAt: string;
  /** `readAt` as epoch ms, so an older read that finishes late can be told apart from a newer one. */
  readMs: number;
}

export interface LimitsMemory {
  /** Records a read that finished, so that the next failed read can fall back to it. */
  observe(providerId: string, usage: ProviderUsage, now?: number): void;
  /** The snapshot with the remembered limits attached, when this read could not get its own. */
  attach(providerId: string, usage: ProviderUsage, now?: number): ProviderUsage;
}

export function createLimitsMemory(): LimitsMemory {
  const remembered = new Map<string, Remembered>();

  return {
    observe(providerId, usage, now = Date.now()) {
      const kind = readKind(usage);
      if (kind === 'unknown') return;
      const prior = remembered.get(providerId);
      // When the windows were read, which can be before the scan that carries them.
      const readAt = usage.subscription?.readAt ?? usage.updatedAt;
      const readMs = Date.parse(readAt) || now;
      // Lists and refreshes race, so a read that finishes late must not overwrite a newer one.
      if (prior && readMs < prior.readMs) return;
      if (kind === 'none') {
        remembered.delete(providerId);
        return;
      }
      remembered.set(providerId, {
        plan: usage.subscription?.plan ?? null,
        windows: liveWindows(usage),
        readAt,
        readMs,
      });
    },

    attach(providerId, usage, now = Date.now()) {
      if (readKind(usage) !== 'unknown') return usage;
      const prior = remembered.get(providerId);
      if (!prior) return usage;
      // A window stops being worth showing once its reset time has passed. One with no reset
      // time stays, and the status bar marks it as out of date.
      const windows = prior.windows.filter((w) => !w.resetAt || Date.parse(w.resetAt) > now);
      if (windows.length === 0) {
        remembered.delete(providerId);
        return usage;
      }
      return { ...usage, lastLimits: { plan: prior.plan, windows, readAt: prior.readAt } };
    },
  };
}
