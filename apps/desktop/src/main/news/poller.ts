/**
 * When the news client fetches (E42). The first fetch waits a little so start-up stays quick, then
 * one runs every 30 minutes while the app is open. Three failures in a row slow it to every 2
 * hours, and the first success brings it back.
 */

const START_DELAY_MS = 30 * 1000;
const INTERVAL_MS = 30 * 60 * 1000;
const BACKOFF_MS = 2 * 60 * 60 * 1000;
const FAILURES_BEFORE_BACKOFF = 3;

export interface NewsPoller {
  start(): void;
  stop(): void;
  /** Fetches now and starts the wait over. Resolves to whether the fetch succeeded. */
  refreshNow(): Promise<boolean>;
}

export function createNewsPoller(deps: {
  /** One fetch. Resolves to false (or throws) when it failed. */
  poll: () => Promise<boolean>;
}): NewsPoller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let failures = 0;
  let inFlight: Promise<boolean> | null = null;

  function schedule(delayMs: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runOnce();
    }, delayMs);
  }

  function runOnce(): Promise<boolean> {
    if (inFlight) return inFlight;
    const run = deps
      .poll()
      .catch(() => false)
      .then((ok) => {
        failures = ok ? 0 : failures + 1;
        if (running) schedule(failures >= FAILURES_BEFORE_BACKOFF ? BACKOFF_MS : INTERVAL_MS);
        return ok;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = run;
    return run;
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule(START_DELAY_MS);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    refreshNow: runOnce,
  };
}
