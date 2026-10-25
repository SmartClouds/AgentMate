import { hashString, seededRandom } from './motion.js';

/**
 * Virtual time for a scene page. Before any scene code runs, the page's clocks are replaced:
 * `Date`, `performance.now`, `requestAnimationFrame` and the timers all follow a clock that only
 * `advanceTo` moves, and `Math.random` is reseeded for every frame from the scene's seed and the
 * frame's time. A scene, or a library it uses, that reads the clock or rolls dice therefore draws
 * the same picture for the same moment every time, however long the real capture took.
 */

/** Virtual time starts here, so a scene that prints "today" prints the same day on every render. */
export const VIRTUAL_EPOCH = Date.UTC(2026, 0, 1);

/** A runaway timer (one that keeps scheduling more) must not hang a frame forever. */
const MAX_TIMER_RUNS = 10_000;
/** As in browsers: past five levels of timers set from timers, a delay is at least 4 ms. */
const NESTING_LEVEL = 5;
const NESTED_MIN_MS = 4;

interface Timer {
  id: number;
  at: number;
  seq: number;
  callback: (...args: unknown[]) => void;
  args: unknown[];
  interval: number | null;
  nesting: number;
}

export interface VirtualClock {
  /** Milliseconds of virtual time since the scene started. */
  now(): number;
  /** Moves time to `ms`, runs every timer due by then in order, then one animation frame. */
  advanceTo(ms: number): void;
  /** The page's own timers, for the runtime's waits that must not be virtual. */
  real: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    requestAnimationFrame: typeof requestAnimationFrame;
  };
  /** Problems found while running scene callbacks (a runaway timer, a throwing callback). */
  problems: string[];
}

type TimeWindow = Window & typeof globalThis;

export function installVirtualTime(win: TimeWindow, options: { seed: string }): VirtualClock {
  let current = 0;
  let nextId = 1;
  let seq = 0;
  /** How deep the timer now running sits in a chain of timers set from timers. */
  let nesting = 0;
  const timers = new Map<number, Timer>();
  let frames = new Map<number, FrameRequestCallback>();
  const problems: string[] = [];
  const real = {
    setTimeout: win.setTimeout.bind(win) as typeof setTimeout,
    clearTimeout: win.clearTimeout.bind(win) as typeof clearTimeout,
    requestAnimationFrame: win.requestAnimationFrame.bind(win) as typeof requestAnimationFrame,
  };
  const seed = hashString(options.seed);

  const RealDate = win.Date;
  class VirtualDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(VIRTUAL_EPOCH + current);
      else super(...(args as [number]));
    }
    static override now(): number {
      return VIRTUAL_EPOCH + current;
    }
  }
  win.Date = VirtualDate as unknown as DateConstructor;

  Object.defineProperty(win.performance, 'now', { value: () => current, configurable: true });

  win.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  };
  win.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };

  const schedule = (
    callback: unknown,
    delay: unknown,
    args: unknown[],
    repeat: boolean,
  ): number => {
    const id = nextId++;
    if (typeof callback !== 'function') return id;
    const level = nesting + 1;
    let ms = Math.max(0, Number(delay) || 0);
    if (level > NESTING_LEVEL && ms < NESTED_MIN_MS) ms = NESTED_MIN_MS;
    timers.set(id, {
      id,
      at: current + ms,
      seq: seq++,
      callback: callback as Timer['callback'],
      args,
      interval: repeat ? Math.max(NESTED_MIN_MS, ms) : null,
      nesting: level,
    });
    return id;
  };
  win.setTimeout = ((callback: unknown, delay?: unknown, ...args: unknown[]) =>
    schedule(callback, delay, args, false)) as typeof setTimeout;
  win.setInterval = ((callback: unknown, delay?: unknown, ...args: unknown[]) =>
    schedule(callback, delay, args, true)) as typeof setInterval;
  win.clearTimeout = ((id?: number) => {
    if (id !== undefined) timers.delete(id);
  }) as typeof clearTimeout;
  win.clearInterval = win.clearTimeout as unknown as typeof clearInterval;

  const reseed = () => {
    win.Math.random = seededRandom(seed ^ hashString(String(Math.round(current * 1000))));
  };
  reseed();

  const run = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      problems.push(`${what} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    now: () => current,
    real,
    problems,
    advanceTo(ms: number) {
      const target = Math.max(0, ms);
      let runs = 0;
      for (;;) {
        let due: Timer | undefined;
        for (const timer of timers.values()) {
          if (timer.at > target) continue;
          if (!due || timer.at < due.at || (timer.at === due.at && timer.seq < due.seq))
            due = timer;
        }
        if (!due) break;
        if (++runs > MAX_TIMER_RUNS) {
          problems.push('A timer kept firing without end; it was stopped for this frame.');
          break;
        }
        current = Math.max(current, due.at);
        reseed();
        if (due.interval === null) timers.delete(due.id);
        else {
          due.at += due.interval;
          due.seq = seq++;
        }
        const timer = due;
        nesting = timer.nesting;
        run('A timer', () => timer.callback(...timer.args));
        nesting = 0;
      }
      current = target;
      reseed();
      // Callbacks queued while these run belong to the next frame.
      const queued = frames;
      frames = new Map();
      for (const callback of queued.values()) run('An animation frame', () => callback(current));
    },
  };
}
