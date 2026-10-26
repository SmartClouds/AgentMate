import {
  type ActivityState,
  advanceDocker,
  advanceEmulators,
  appendBounded,
  createActivityState,
  DEFAULT_IDLE_RESOURCE_MINUTES,
  type DockerObservation,
  describeIdleAlert,
  describeResources,
  type EmulatorObservation,
  forgetResources,
  type ResourceActivitySnapshot,
  type ResourceRef,
  type ResourceSourceStatus,
  type ResourceStopOutcome,
  type ResourceStopResult,
  type ResourceUsagePoint,
  resourceKey,
  takeNewlyIdle,
  usagePoint,
} from '@runova/core';

/**
 * Watches the running Docker containers and Android emulators in the background and remembers
 * when each last did anything, so the Dashboard can list the ones nobody is using.
 *
 * It has to live in the main process: an idle clock that only ran while the Dashboard was open
 * would restart every time the user looked away. Nothing here touches Electron, Docker or adb
 * directly; those arrive as dependencies so the whole class runs under fake timers in its test.
 *
 * What counts as "being used" is decided by the pure reducers in core. This class only schedules
 * the reads, keeps the state and the chart history, and turns idle transitions into alerts.
 */

export interface TrackerSettings {
  idleMinutes: number;
  notify: boolean;
}

export interface TrackerDeps {
  /** `available: false` when the Docker CLI or daemon cannot be reached. */
  sampleDocker(): Promise<{ available: boolean; containers: DockerObservation[] }>;
  /** Null when emulators cannot be looked at at all (no adb server, no SDK). */
  sampleEmulators(): Promise<EmulatorObservation[] | null>;
  getSettings(): Promise<TrackerSettings>;
  notify(alert: { title: string; body: string }): void;
  stopContainer(id: string): Promise<{ ok: boolean; error?: string }>;
  stopEmulator(serial: string): Promise<{ ok: boolean; message?: string }>;
  now?: () => number;
  /** Time between readings. */
  tickMs?: number;
  /** Delay before the first reading after `start`, so startup is not the busiest moment. */
  firstTickMs?: number;
  /** How long to leave Docker alone after it could not be reached. */
  dockerRetryMs?: number;
}

export const DEFAULT_TICK_MS = 30_000;
const DEFAULT_FIRST_TICK_MS = 10_000;
const DEFAULT_DOCKER_RETRY_MS = 2 * 60_000;
/** A Stop all across a big machine should not fire dozens of `docker stop` at once. */
const STOP_CONCURRENCY = 4;

export interface SnapshotOptions {
  /** Take a new reading first instead of answering from the last one. */
  fresh?: boolean;
}

export interface StopOptions {
  /** Skip anything that is no longer idle, for "stop all" after a confirm. */
  onlyIfIdle?: boolean;
}

export class ResourceActivityTracker {
  private state: ActivityState = createActivityState();
  private history: ResourceUsagePoint[] = [];
  private dockerStatus: ResourceSourceStatus = 'pending';
  private emulatorStatus: ResourceSourceStatus = 'pending';
  private dockerRetryAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private hasSampled = false;
  private lastSampleAt = 0;
  private started = false;
  private disposed = false;
  private readonly watchingSince: number;

  constructor(private readonly deps: TrackerDeps) {
    this.watchingSince = this.now();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get tickMs(): number {
    return this.deps.tickMs ?? DEFAULT_TICK_MS;
  }

  /** Begins reading on a timer. Safe to call twice. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.schedule(this.deps.firstTickMs ?? DEFAULT_FIRST_TICK_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // A chain of timeouts rather than an interval, so a slow read can never overlap the next one.
  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sampleNow().finally(() => {
        if (this.started && !this.disposed) this.schedule(this.tickMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  /** Reads both sources once. Callers that ask while a reading is under way share it. */
  sampleNow(): Promise<void> {
    this.inflight ??= this.sample()
      .catch(() => {
        // A failed reading is a missed point, never a crash in the main process.
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async sample(): Promise<void> {
    const [docker, emulators] = await Promise.all([this.readDocker(), this.readEmulators()]);
    // Stamped after the slow reads, so the rates measure the time between readings, not between
    // the moments they began.
    const at = this.now();
    let state = this.state;

    if (docker !== 'skipped') {
      this.dockerStatus = docker.available ? 'ready' : 'unavailable';
      if (!docker.available) this.dockerRetryAt = at + this.dockerRetryMs;
      state = advanceDocker(state, docker.available ? docker.containers : null, at, this.tickMs);
    }
    this.emulatorStatus = emulators === null ? 'unavailable' : 'ready';
    state = advanceEmulators(state, emulators, at, this.tickMs);

    this.state = state;
    this.hasSampled = true;
    this.lastSampleAt = at;
    this.history = appendBounded(this.history, usagePoint(state, at));

    const settings = await this.settings();
    const taken = takeNewlyIdle(this.state, at, settings.idleMinutes);
    this.state = taken.state;
    if (settings.notify && taken.newlyIdle.length > 0) {
      this.deps.notify(describeIdleAlert(taken.newlyIdle, settings.idleMinutes));
    }
  }

  private get dockerRetryMs(): number {
    return this.deps.dockerRetryMs ?? DEFAULT_DOCKER_RETRY_MS;
  }

  private async readDocker(): Promise<
    { available: boolean; containers: DockerObservation[] } | 'skipped'
  > {
    // After Docker could not be reached it is left alone for a while, so a machine without it
    // does not spawn a failing process every half minute.
    if (this.now() < this.dockerRetryAt) return 'skipped';
    try {
      return await this.deps.sampleDocker();
    } catch {
      return { available: false, containers: [] };
    }
  }

  private async readEmulators(): Promise<EmulatorObservation[] | null> {
    try {
      return await this.deps.sampleEmulators();
    } catch {
      return null;
    }
  }

  private async settings(): Promise<TrackerSettings> {
    try {
      return await this.deps.getSettings();
    } catch {
      return { idleMinutes: DEFAULT_IDLE_RESOURCE_MINUTES, notify: false };
    }
  }

  /**
   * Readings that stopped arriving (the computer slept, or a reading hung) leave the clocks
   * measuring against old data, which would call everything idle. Past two ticks it is better
   * to read again; that reading sees the gap and starts the clocks over.
   */
  private isStale(): boolean {
    return this.now() - this.lastSampleAt > 2 * this.tickMs;
  }

  /**
   * Everything tracked, with idleness judged against today's threshold. The first call waits for
   * a reading so the Dashboard never shows "nothing is running" about something it has not looked
   * at yet, and so does one that finds the last reading too old to trust.
   */
  async snapshot(options: SnapshotOptions = {}): Promise<ResourceActivitySnapshot> {
    if (options.fresh || !this.hasSampled || this.isStale()) await this.sampleNow();
    const { idleMinutes } = await this.settings();
    return this.buildSnapshot(idleMinutes);
  }

  private buildSnapshot(idleMinutes: number): ResourceActivitySnapshot {
    const now = this.now();
    return {
      generatedAt: now,
      watchingSince: this.watchingSince,
      idleMinutes,
      docker: this.dockerStatus,
      emulators: this.emulatorStatus,
      resources: describeResources(this.state, now, idleMinutes),
      history: this.history,
    };
  }

  /**
   * Stops containers and emulators by reference. Only things the tracker currently knows about
   * can be stopped, so a renderer cannot use this to stop an arbitrary container.
   */
  async stop(refs: ResourceRef[], options: StopOptions = {}): Promise<ResourceStopOutcome> {
    const { idleMinutes } = await this.settings();
    const known = new Map(
      describeResources(this.state, this.now(), idleMinutes).map((one) => [one.key, one]),
    );

    const unique = new Map(refs.map((ref) => [resourceKey(ref.kind, ref.id), ref]));
    const results: ResourceStopResult[] = [];
    const queue = [...unique.entries()];

    const stopOne = async ([key, ref]: [string, ResourceRef]): Promise<void> => {
      const resource = known.get(key);
      if (!resource) {
        results.push({ ref, name: ref.id, ok: false, skipped: 'gone' });
        return;
      }
      // Idleness is judged now, not when the user opened the confirm, so something that became
      // busy while the dialog was up is left running.
      if (options.onlyIfIdle && !resource.idle) {
        results.push({ ref, name: resource.name, ok: false, skipped: 'active' });
        return;
      }
      try {
        if (ref.kind === 'docker') {
          const outcome = await this.deps.stopContainer(ref.id);
          results.push({ ref, name: resource.name, ok: outcome.ok, message: outcome.error });
        } else {
          const outcome = await this.deps.stopEmulator(ref.id);
          results.push({ ref, name: resource.name, ok: outcome.ok, message: outcome.message });
        }
      } catch (error) {
        results.push({
          ref,
          name: resource.name,
          ok: false,
          message: error instanceof Error ? error.message : 'Could not stop it.',
        });
      }
    };

    const workers = Array.from({ length: Math.min(STOP_CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await stopOne(next);
    });
    await Promise.all(workers);

    // Put back in the order they were asked for, since the workers finish in any order.
    const order = [...unique.keys()];
    results.sort(
      (a, b) =>
        order.indexOf(resourceKey(a.ref.kind, a.ref.id)) -
        order.indexOf(resourceKey(b.ref.kind, b.ref.id)),
    );

    // A stopped resource disappears from the list straight away instead of lingering until the
    // next reading, when it would still look idle.
    this.state = forgetResources(
      this.state,
      results.filter((one) => one.ok).map((one) => resourceKey(one.ref.kind, one.ref.id)),
    );
    return { results, snapshot: this.buildSnapshot(idleMinutes) };
  }
}
