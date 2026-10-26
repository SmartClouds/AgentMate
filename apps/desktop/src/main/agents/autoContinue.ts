import {
  type AgentStatus,
  AUTO_CONTINUE_TEXT,
  type AutoContinueKind,
  type AutoContinueOptions,
  type AutoContinuePending,
  type AutoContinueSignal,
  detectAutoContinueSignal,
  terminalPlainText,
} from '@runova/core';
import type { AgentSessionEntry, AutoContinuePendingMap } from '../../shared/apiTypes';

/**
 * Types "continue" into an agent tab that stopped on a usage limit (once the limit resets) or
 * on a network error (a few minutes later), for tabs whose user turned that on. Watches the
 * same raw output the status tracker does, so it works for tabs that are not on screen and
 * with the window hidden.
 */

/** Recent plain text kept per tab, enough to hold a limit message and its reset time. */
const BUFFER_CHARS = 2000;
/** A resize makes a TUI repaint old lines, which must not count as a fresh error. */
const RESIZE_QUIET_MS = 1500;
/** Sent this long after the reset time the CLI printed, so the new window is surely open. */
const LIMIT_GRACE_MS = 90_000;
/** How long to wait between tries when a limit message gave no time the app could read. */
const LIMIT_UNKNOWN_RETRY_MS = 30 * 60_000;
/** Tries with an unreadable reset time before giving up (six hours of half-hour tries). */
const LIMIT_UNKNOWN_MAX_ATTEMPTS = 12;
/** Wait before each network retry: a few minutes first, then backing off. */
export const NETWORK_RETRY_DELAYS_MS = [3, 5, 10, 15, 20].map((minutes) => minutes * 60_000);
/** A network error this long after the last continue starts a fresh run of retries. */
const EPISODE_RESET_MS = 30 * 60_000;
/** Pause between the keys, so the CLI sees an Escape, then typing, then Enter. */
const KEY_GAP_MS = 250;

export interface AutoContinueDeps {
  /** Writes to the tab's shell without counting as the user typing. */
  write(sessionId: string, data: string): void;
  statusOf(sessionId: string): AgentStatus | undefined;
  /** Tells the renderer which tabs have a continue scheduled; null means none any more. */
  broadcast(changes: AutoContinuePendingMap): void;
  /** Holds the machine awake while anything is scheduled, so the continue actually happens. */
  setBusy(busy: boolean): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Watch {
  options: AutoContinueOptions;
  buffer: string;
  lastResizeAt: number;
  pending: (AutoContinuePending & { timer: unknown }) | null;
  /** Continues already sent for the current run of trouble, and when the last one went. */
  attempts: number;
  lastFiredAt: number;
  lastKind: AutoContinueKind | null;
}

export interface AutoContinue {
  sync(entries: AgentSessionEntry[]): void;
  output(sessionId: string, data: string): void;
  resize(sessionId: string): void;
  /** The user typed into the tab; a submitted line means they took over. */
  userInput(sessionId: string, data: string): void;
  exit(sessionId: string): void;
  /** Drops a scheduled continue without turning the option off. */
  cancel(sessionId: string): void;
  list(): AutoContinuePendingMap;
}

function wants(options: AutoContinueOptions, kind: AutoContinueKind): boolean {
  return kind === 'limit' ? Boolean(options.afterLimitReset) : Boolean(options.afterNetworkError);
}

export function createAutoContinue(deps: AutoContinueDeps): AutoContinue {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const watches = new Map<string, Watch>();

  function publicPending(watch: Watch | undefined): AutoContinuePending | null {
    if (!watch?.pending) return null;
    const { kind, fireAt, attempt } = watch.pending;
    return { kind, fireAt, attempt };
  }

  function announce(sessionId: string): void {
    deps.broadcast({ [sessionId]: publicPending(watches.get(sessionId)) });
    deps.setBusy([...watches.values()].some((watch) => watch.pending));
  }

  function clearPending(sessionId: string, watch: Watch): void {
    if (!watch.pending) return;
    clearTimer(watch.pending.timer);
    watch.pending = null;
    announce(sessionId);
  }

  function send(sessionId: string): void {
    // An Escape first closes anything the CLI put up with the error (Claude Code's
    // "what do you want to do" limit menu, say). At an empty prompt it does nothing.
    deps.write(sessionId, '\x1b');
    setTimer(() => {
      if (!watches.has(sessionId)) return;
      deps.write(sessionId, AUTO_CONTINUE_TEXT);
      setTimer(() => {
        if (watches.has(sessionId)) deps.write(sessionId, '\r');
      }, KEY_GAP_MS);
    }, KEY_GAP_MS);
  }

  function fire(sessionId: string): void {
    const watch = watches.get(sessionId);
    if (!watch?.pending) return;
    const { kind } = watch.pending;
    watch.pending = null;
    const status = deps.statusOf(sessionId);
    // Busy again means the CLI recovered by itself or the user already carried on; exited
    // means there is nothing left to type into.
    if (status === 'working' || status === 'exited' || !wants(watch.options, kind)) {
      watch.attempts = 0;
      announce(sessionId);
      return;
    }
    watch.attempts += 1;
    watch.lastFiredAt = now();
    watch.lastKind = kind;
    watch.buffer = '';
    announce(sessionId);
    send(sessionId);
  }

  function schedule(sessionId: string, watch: Watch, signal: AutoContinueSignal): void {
    const at = now();
    // A limit wait outranks a network retry; the continue after the reset covers both.
    if (signal.kind === 'network' && watch.pending?.kind === 'limit') return;
    if (watch.lastKind !== signal.kind || at - watch.lastFiredAt > EPISODE_RESET_MS) {
      watch.attempts = 0;
    }

    let fireAt: number;
    if (signal.kind === 'limit') {
      if (signal.resetAt !== null) {
        fireAt = Math.max(signal.resetAt, at) + LIMIT_GRACE_MS;
      } else {
        if (watch.attempts >= LIMIT_UNKNOWN_MAX_ATTEMPTS) return;
        fireAt = at + LIMIT_UNKNOWN_RETRY_MS;
      }
    } else {
      const delay = NETWORK_RETRY_DELAYS_MS[watch.attempts];
      // Out of retries: the network is not coming back soon, so leave it to the user.
      if (delay === undefined) return;
      // The same error repainted while a retry is already waiting changes nothing.
      if (watch.pending?.kind === 'network') return;
      fireAt = at + delay;
    }

    if (watch.pending) clearTimer(watch.pending.timer);
    watch.pending = {
      kind: signal.kind,
      fireAt,
      attempt: watch.attempts + 1,
      timer: setTimer(() => fire(sessionId), Math.max(0, fireAt - at)),
    };
    watch.lastKind = signal.kind;
    announce(sessionId);
  }

  function forget(sessionId: string): void {
    const watch = watches.get(sessionId);
    if (!watch) return;
    watches.delete(sessionId);
    if (watch.pending) {
      clearTimer(watch.pending.timer);
      watch.pending = null;
      announce(sessionId);
    }
  }

  return {
    sync(entries) {
      const wanted = new Map<string, AutoContinueOptions>();
      for (const entry of entries) {
        const options = entry.autoContinue;
        if (entry.cliId && (options?.afterLimitReset || options?.afterNetworkError)) {
          wanted.set(entry.sessionId, options);
        }
      }
      for (const sessionId of [...watches.keys()]) {
        if (!wanted.has(sessionId)) forget(sessionId);
      }
      for (const [sessionId, options] of wanted) {
        const watch = watches.get(sessionId);
        if (!watch) {
          watches.set(sessionId, {
            options,
            buffer: '',
            lastResizeAt: 0,
            pending: null,
            attempts: 0,
            lastFiredAt: 0,
            lastKind: null,
          });
          continue;
        }
        watch.options = options;
        if (watch.pending && !wants(options, watch.pending.kind)) clearPending(sessionId, watch);
      }
    },

    output(sessionId, data) {
      const watch = watches.get(sessionId);
      if (!watch) return;
      const at = now();
      if (at - watch.lastResizeAt < RESIZE_QUIET_MS) return;
      watch.buffer = (watch.buffer + terminalPlainText(data)).slice(-BUFFER_CHARS);
      const signal = detectAutoContinueSignal(watch.buffer, at);
      if (!signal) return;
      // Seen once is enough; the next chunks must bring a new message to count again.
      watch.buffer = '';
      if (wants(watch.options, signal.kind)) schedule(sessionId, watch, signal);
    },

    resize(sessionId) {
      const watch = watches.get(sessionId);
      if (!watch) return;
      watch.lastResizeAt = now();
      watch.buffer = '';
    },

    userInput(sessionId, data) {
      const watch = watches.get(sessionId);
      if (!watch || !data.includes('\r')) return;
      watch.attempts = 0;
      clearPending(sessionId, watch);
    },

    exit(sessionId) {
      forget(sessionId);
    },

    cancel(sessionId) {
      const watch = watches.get(sessionId);
      if (watch) clearPending(sessionId, watch);
    },

    list() {
      const map: AutoContinuePendingMap = {};
      for (const [sessionId, watch] of watches) {
        const pending = publicPending(watch);
        if (pending) map[sessionId] = pending;
      }
      return map;
    },
  };
}
