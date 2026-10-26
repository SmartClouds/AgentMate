import type {
  AlertInfo,
  MetricsSample,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type { DeployConnection } from '../../../shared/deployTypes';
import type { LiveHubSession } from '../connection/liveHub';
import { CoreLink } from './coreLink';
import { AlertsFeed, JobFeed, type JobFeedEvents, type LinkFeed, MetricsFeed } from './feeds';
import type { BlockedState } from './linkFailures';

/**
 * Every server's link, and the streams on it that are shared. The core allows each connection
 * two metrics streams, four job streams and two alerts streams, so metrics run once per interval
 * (two intervals at most), the app's windows share one alerts stream and the alert watcher has
 * the other, and job logs stop at four. A shared stream outlives its last listener by a few
 * seconds, so a window that mounts twice in a row does not open and close it twice.
 */

const MAX_METRICS_INTERVALS = 2;
const MAX_JOB_LOGS = 4;
const LINGER_MS = 5_000;

export interface CoreLinksDeps {
  open: (serverId: string) => Promise<LiveHubSession>;
  onState?: (connection: DeployConnection) => void;
  now?: () => number;
}

interface Shared<F> {
  feed: F;
  detach: () => void;
  linger: ReturnType<typeof setTimeout> | null;
}

function once(run: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    run();
  };
}

export class CoreLinks {
  private readonly links = new Map<string, CoreLink>();
  private readonly metrics = new Map<string, Map<number, Shared<MetricsFeed>>>();
  private readonly alerts = new Map<string, Shared<AlertsFeed>>();
  private readonly jobLogs = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: CoreLinksDeps) {
    this.now = deps.now ?? Date.now;
  }

  link(serverId: string): CoreLink {
    let link = this.links.get(serverId);
    if (!link) {
      link = new CoreLink({
        serverId,
        open: () => this.deps.open(serverId),
        onState: this.deps.onState,
        now: this.now,
      });
      this.links.set(serverId, link);
    }
    return link;
  }

  info(serverId: string): DeployConnection {
    return this.links.get(serverId)?.info ?? { serverId, state: 'offline', since: this.now() };
  }

  isOnline(serverId: string): boolean {
    return this.links.get(serverId)?.online ?? false;
  }

  call<T>(serverId: string, work: (hub: ICoreHub) => Promise<T>): Promise<T> {
    return this.link(serverId).call(work);
  }

  /** Live samples at `intervalMs`; a listener that joins a running stream starts after `since`. */
  watchMetrics(
    serverId: string,
    intervalMs: number,
    listener: (sample: MetricsSample) => void,
    sinceUnixMs?: number,
  ): () => void {
    let byInterval = this.metrics.get(serverId);
    if (!byInterval) {
      byInterval = new Map();
      this.metrics.set(serverId, byInterval);
    }
    let shared = byInterval.get(intervalMs);
    let stop: () => void;
    if (shared) {
      if (shared.linger) clearTimeout(shared.linger);
      shared.linger = null;
      stop = shared.feed.listen(listener, sinceUnixMs);
    } else {
      if (byInterval.size >= MAX_METRICS_INTERVALS) this.evictIdleMetrics(byInterval);
      if (byInterval.size >= MAX_METRICS_INTERVALS) {
        throw new Error(
          'Live metrics already run at two intervals on this server. Watch at one of those.',
        );
      }
      const feed = new MetricsFeed(intervalMs, sinceUnixMs);
      stop = feed.listen(listener);
      shared = { feed, detach: this.link(serverId).attach(feed), linger: null };
      byInterval.set(intervalMs, shared);
    }
    const current = shared;
    const intervals = byInterval;
    return once(() => {
      stop();
      if (current.feed.listeners > 0) return;
      current.linger = setTimeout(() => {
        current.linger = null;
        if (current.feed.listeners > 0) return;
        current.detach();
        if (intervals.get(intervalMs) === current) intervals.delete(intervalMs);
      }, LINGER_MS);
    });
  }

  /** Every open alert first, then each change as it happens. Shared by the app's windows. */
  watchAlerts(serverId: string, listener: (alert: AlertInfo) => void): () => void {
    let shared = this.alerts.get(serverId);
    if (!shared) {
      const feed = new AlertsFeed({ keepOpen: true });
      shared = { feed, detach: this.link(serverId).attach(feed), linger: null };
      this.alerts.set(serverId, shared);
    } else if (shared.linger) {
      clearTimeout(shared.linger);
      shared.linger = null;
    }
    const current = shared;
    const stop = current.feed.listen(listener, { replayOpen: true });
    return once(() => {
      stop();
      if (current.feed.listeners > 0) return;
      current.linger = setTimeout(() => {
        current.linger = null;
        if (current.feed.listeners > 0) return;
        current.detach();
        if (this.alerts.get(serverId) === current) this.alerts.delete(serverId);
      }, LINGER_MS);
    });
  }

  /** A feed of the caller's own on the server's link, such as the alert watcher's. */
  attachAlerts(serverId: string, feed: AlertsFeed): () => void {
    return this.link(serverId).attach(feed);
  }

  /** Any other feed on the server's link, such as a site's log; the caller keeps its limits. */
  attachFeed(serverId: string, feed: LinkFeed): () => void {
    return this.link(serverId).attach(feed);
  }

  /** One job's log after line `afterSeq`, until the job is over. */
  watchJob(serverId: string, jobId: string, afterSeq: number, events: JobFeedEvents): () => void {
    const open = this.jobLogs.get(serverId) ?? 0;
    if (open >= MAX_JOB_LOGS) {
      throw new Error('Four job logs are already open for this server. Close one first.');
    }
    this.jobLogs.set(serverId, open + 1);
    const release = once(() => this.jobLogs.set(serverId, (this.jobLogs.get(serverId) ?? 1) - 1));
    const feed = new JobFeed(jobId, afterSeq, {
      lines: (lines, job) => events.lines(lines, job),
      ended: (end) => {
        release();
        events.ended(end);
      },
    });
    const detach = this.link(serverId).attach(feed);
    return once(() => {
      detach();
      release();
    });
  }

  /** Starts the server's link over, as after a sign-in, a sign-out or a removal. */
  reset(serverId: string): void {
    this.links.get(serverId)?.reset();
  }

  /** Tries the server's connection again now. */
  retry(serverId: string): void {
    this.link(serverId).retry();
  }

  /** Tries again every link that waits in `state`, such as 'locked' once the vault opens. */
  wake(state: BlockedState): void {
    for (const link of this.links.values()) link.wake(state);
  }

  closeAll(): void {
    for (const byInterval of this.metrics.values()) {
      for (const shared of byInterval.values()) if (shared.linger) clearTimeout(shared.linger);
    }
    for (const shared of this.alerts.values()) if (shared.linger) clearTimeout(shared.linger);
    for (const link of this.links.values()) link.close();
  }

  private evictIdleMetrics(byInterval: Map<number, Shared<MetricsFeed>>): void {
    for (const [interval, shared] of byInterval) {
      if (shared.feed.listeners > 0) continue;
      if (shared.linger) clearTimeout(shared.linger);
      shared.detach();
      byInterval.delete(interval);
      return;
    }
  }
}
