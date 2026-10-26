import type { IStreamResult } from '@microsoft/signalr';
import type {
  AlertInfo,
  JobInfo,
  JobLogLine,
  JobStreamItem,
  MetricsSample,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { hubMessage } from '../connection/hubErrors';

/**
 * The hub streams a server's link keeps open, each with its replay cursor: the time of the last
 * metrics sample, the last job log line, the highest alert revision. A feed opens its next stream
 * from that cursor and drops whatever it already passed on, so moving to a new connection (after
 * a drop, a reboot or a token running out) neither skips nor repeats anything.
 */

export interface LinkFeed<T = unknown> {
  /** The feed's stream on a connection, from where the last one left off. */
  open(hub: ICoreHub): IStreamResult<T>;
  next(item: T): void;
  /** The core ended the stream: how long to wait before opening it again, or null when done. */
  ended(): number | null;
  /** The core failed the stream while the connection stayed up; answered as `ended`. */
  failed(error: Error): number | null;
}

/** As long as the core keeps live samples, so a late listener gets what a reconnect would. */
const LIVE_WINDOW_MS = 15 * 60_000;
const MAX_KEPT_SAMPLES = 1_000;
const REOPEN_AFTER_END_MS = 1_000;
const REOPEN_AFTER_FAILURE_MS = 5_000;
/** An alerts stream ends when it fell behind; the next one starts after the highest revision. */
const REOPEN_ALERTS_MS = 250;
/** The core refuses a stream over its per-connection limit, and counts a closed one a moment more. */
const STREAMS_BUSY = /streams open/;

type Listener<T> = (item: T) => void;

/** Live metrics at one interval, shared by everyone who watches the server at that interval. */
export class MetricsFeed implements LinkFeed<MetricsSample> {
  private last: number | undefined;
  private readonly recent: MetricsSample[] = [];
  private readonly subscribers = new Set<Listener<MetricsSample>>();

  constructor(
    readonly intervalMs: number,
    sinceUnixMs?: number,
  ) {
    this.last = sinceUnixMs;
  }

  get listeners(): number {
    return this.subscribers.size;
  }

  open(hub: ICoreHub): IStreamResult<MetricsSample> {
    return hub.streamMetrics(
      this.last === undefined
        ? { intervalMs: this.intervalMs }
        : { intervalMs: this.intervalMs, sinceUnixMs: this.last },
    );
  }

  next(sample: MetricsSample): void {
    if (this.last !== undefined && sample.atUnixMs <= this.last) return;
    this.last = sample.atUnixMs;
    this.recent.push(sample);
    const oldest = sample.atUnixMs - LIVE_WINDOW_MS;
    while (
      this.recent.length > MAX_KEPT_SAMPLES ||
      (this.recent.length > 0 && this.recent[0].atUnixMs < oldest)
    ) {
      this.recent.shift();
    }
    for (const listener of [...this.subscribers]) listener(sample);
  }

  ended(): number {
    return REOPEN_AFTER_END_MS;
  }

  failed(_error?: Error): number {
    return REOPEN_AFTER_FAILURE_MS;
  }

  /** Hands over what came after `sinceUnixMs` (as far back as it keeps), then every new sample. */
  listen(listener: Listener<MetricsSample>, sinceUnixMs?: number): () => void {
    if (sinceUnixMs !== undefined) {
      for (const sample of this.recent) if (sample.atUnixMs > sinceUnixMs) listener(sample);
    }
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
}

/**
 * Alert changes in revision order. With no revision to start after, the first stream begins
 * with every open alert. `keepOpen` keeps the open ones, for listeners that join later.
 */
export class AlertsFeed implements LinkFeed<AlertInfo> {
  private highest: number | undefined;
  private readonly current = new Map<number, AlertInfo>();
  private readonly keepOpen: boolean;
  private readonly subscribers = new Set<Listener<AlertInfo>>();

  constructor(options: { afterRevision?: number; keepOpen?: boolean } = {}) {
    this.highest = options.afterRevision;
    this.keepOpen = options.keepOpen ?? false;
  }

  get listeners(): number {
    return this.subscribers.size;
  }

  open(hub: ICoreHub): IStreamResult<AlertInfo> {
    return hub.streamAlerts(this.highest === undefined ? {} : { afterRevision: this.highest });
  }

  next(alert: AlertInfo): void {
    if (this.highest !== undefined && alert.revision <= this.highest) return;
    this.highest = alert.revision;
    if (this.keepOpen) {
      if (alert.resolvedAtUnixMs) this.current.delete(alert.id);
      else this.current.set(alert.id, alert);
    }
    for (const listener of [...this.subscribers]) listener(alert);
  }

  ended(): number {
    return REOPEN_ALERTS_MS;
  }

  failed(_error?: Error): number {
    return REOPEN_AFTER_FAILURE_MS;
  }

  listen(listener: Listener<AlertInfo>, options: { replayOpen?: boolean } = {}): () => void {
    if (options.replayOpen) {
      const open = [...this.current.values()].sort((a, b) => a.revision - b.revision);
      for (const alert of open) listener(alert);
    }
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
}

export interface JobFeedEvents {
  /** New log lines (possibly none), with the job when the core sent it along. */
  lines(lines: JobLogLine[], job?: JobInfo): void;
  /** The log is over: the job reached its final state, or the core refused to show it. */
  ended(end: { job?: JobInfo; error?: string }): void;
}

/** One job's log from a given line on, until the job is over. */
export class JobFeed implements LinkFeed<JobStreamItem> {
  private lastSeq: number;
  private job: JobInfo | undefined;

  constructor(
    readonly jobId: string,
    afterSeq: number,
    private readonly events: JobFeedEvents,
  ) {
    this.lastSeq = afterSeq;
  }

  open(hub: ICoreHub): IStreamResult<JobStreamItem> {
    return hub.streamJob(this.jobId, this.lastSeq);
  }

  next(item: JobStreamItem): void {
    const fresh = item.lines.filter((line) => line.seq > this.lastSeq);
    if (fresh.length > 0) this.lastSeq = fresh[fresh.length - 1].seq;
    if (item.job) this.job = item.job;
    if (fresh.length > 0 || item.job) this.events.lines(fresh, item.job);
  }

  ended(): number | null {
    if (this.job && this.job.state !== 'running') {
      this.events.ended({ job: this.job });
      return null;
    }
    // The stream stopped before the job did; the next one carries on from the last line.
    return REOPEN_AFTER_END_MS;
  }

  failed(error: Error): number | null {
    if (STREAMS_BUSY.test(error.message)) return REOPEN_AFTER_FAILURE_MS;
    this.events.ended({ ...(this.job ? { job: this.job } : {}), error: hubMessage(error) });
    return null;
  }
}
