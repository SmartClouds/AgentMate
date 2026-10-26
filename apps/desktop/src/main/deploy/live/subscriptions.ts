import { randomUUID } from 'node:crypto';
import type {
  AlertInfo,
  JobInfo,
  JobLogLine,
  MetricsSample,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployAlertsEvent,
  DeployJobEvent,
  DeployJobWatchInput,
  DeployMetricsEvent,
  DeployMetricsWatchInput,
} from '../../../shared/deployTypes';
import { IPC } from '../../../shared/ipcChannels';
import type { CoreLinks } from './coreLinks';

/**
 * The renderer's live subscriptions: metrics, job logs and alerts. Each belongs to the window
 * that made it, sends to that window alone, and ends when the window goes away (the IPC layer
 * calls `dropOwner`). Events go out in batches, so a burst (the samples a reconnect replays, a
 * chatty apt run) is one message rather than hundreds. What reaches the window is the core's
 * own text, which the core has already redacted.
 */

export interface SubscriptionOwner {
  /** The same for every subscription of one window. */
  id: number;
  send: (channel: string, payload: unknown) => void;
}

export type SubscriptionKind = 'metrics' | 'job' | 'alerts';

const FLUSH_MS = 100;
const MAX_PER_OWNER = 32;
const DEFAULT_INTERVAL_MS = 2_000;

export interface DeploySubscriptionsDeps {
  links: Pick<CoreLinks, 'watchMetrics' | 'watchAlerts' | 'watchJob'>;
  flushMs?: number;
  maxPerOwner?: number;
  newId?: () => string;
}

interface Entry {
  kind: SubscriptionKind;
  ownerId: number;
  stop: () => void;
  /** Drops whatever is waiting to be sent. */
  cancel: () => void;
}

/** Items that go out together a moment after the first of them arrived. */
export class Batch<T> {
  private items: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushMs: number,
    private readonly send: (items: T[]) => void,
  ) {}

  push(item: T): void {
    this.items.push(item);
    this.timer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    this.cancelTimer();
    if (this.items.length === 0) return;
    const items = this.items;
    this.items = [];
    this.send(items);
  }

  cancel(): void {
    this.cancelTimer();
    this.items = [];
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export class DeploySubscriptions {
  private readonly entries = new Map<string, Entry>();
  private readonly flushMs: number;
  private readonly maxPerOwner: number;
  private readonly newId: () => string;

  constructor(private readonly deps: DeploySubscriptionsDeps) {
    this.flushMs = deps.flushMs ?? FLUSH_MS;
    this.maxPerOwner = deps.maxPerOwner ?? MAX_PER_OWNER;
    this.newId = deps.newId ?? randomUUID;
  }

  watchMetrics(owner: SubscriptionOwner, input: DeployMetricsWatchInput): string {
    const id = this.reserve(owner);
    const batch = new Batch<MetricsSample>(this.flushMs, (samples) => {
      const event: DeployMetricsEvent = { subscriptionId: id, serverId: input.serverId, samples };
      owner.send(IPC.deploySystem.onMetrics, event);
    });
    const stop = this.deps.links.watchMetrics(
      input.serverId,
      input.intervalMs ?? DEFAULT_INTERVAL_MS,
      (sample) => batch.push(sample),
      input.sinceUnixMs,
    );
    this.entries.set(id, {
      kind: 'metrics',
      ownerId: owner.id,
      stop,
      cancel: () => batch.cancel(),
    });
    return id;
  }

  watchAlerts(owner: SubscriptionOwner, serverId: string): string {
    const id = this.reserve(owner);
    const batch = new Batch<AlertInfo>(this.flushMs, (alerts) => {
      const event: DeployAlertsEvent = { subscriptionId: id, serverId, alerts };
      owner.send(IPC.deployAlerts.onChanged, event);
    });
    const stop = this.deps.links.watchAlerts(serverId, (alert) => batch.push(alert));
    this.entries.set(id, { kind: 'alerts', ownerId: owner.id, stop, cancel: () => batch.cancel() });
    return id;
  }

  watchJob(owner: SubscriptionOwner, input: DeployJobWatchInput): string {
    const id = this.reserve(owner);
    let lines: JobLogLine[] = [];
    let job: JobInfo | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      lines = [];
      job = undefined;
    };
    const send = (ended?: { error?: string }) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!ended && lines.length === 0 && !job) return;
      const event: DeployJobEvent = {
        subscriptionId: id,
        serverId: input.serverId,
        jobId: input.jobId,
        lines,
        ...(job ? { job } : {}),
        ...(ended ? { ended } : {}),
      };
      lines = [];
      job = undefined;
      owner.send(IPC.deployJobs.onLog, event);
    };
    const stop = this.deps.links.watchJob(input.serverId, input.jobId, input.afterSeq ?? 0, {
      lines: (batch, latest) => {
        lines.push(...batch);
        if (latest) job = latest;
        timer ??= setTimeout(() => send(), this.flushMs);
      },
      ended: (end) => {
        done = true;
        if (end.job) job = end.job;
        send(end.error ? { error: end.error } : {});
        this.entries.delete(id);
      },
    });
    if (!done) this.entries.set(id, { kind: 'job', ownerId: owner.id, stop, cancel });
    return id;
  }

  /** Ends one of the window's own subscriptions. False when it has none by that id and kind. */
  unwatch(owner: SubscriptionOwner, kind: SubscriptionKind, subscriptionId: string): boolean {
    const entry = this.entries.get(subscriptionId);
    if (!entry || entry.ownerId !== owner.id || entry.kind !== kind) return false;
    this.remove(subscriptionId, entry);
    return true;
  }

  /** Ends every subscription of a window that closed, reloaded or crashed. */
  dropOwner(ownerId: number): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.ownerId === ownerId) this.remove(id, entry);
    }
  }

  count(ownerId?: number): number {
    return [...this.entries.values()].filter(
      (entry) => ownerId === undefined || entry.ownerId === ownerId,
    ).length;
  }

  private reserve(owner: SubscriptionOwner): string {
    if (this.count(owner.id) >= this.maxPerOwner) {
      throw new Error('Too many live subscriptions are open in this window.');
    }
    return this.newId();
  }

  private remove(id: string, entry: Entry): void {
    this.entries.delete(id);
    entry.cancel();
    entry.stop();
  }
}
