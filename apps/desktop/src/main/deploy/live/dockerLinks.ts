import type { ConsoleRequest } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { CoreLinks } from './coreLinks';
import {
  ConsoleFeed,
  type ConsoleFeedEvents,
  ContainerLogsFeed,
  type ContainerLogsFeedEvents,
  type ContainerLogsOptions,
  ContainerStatsFeed,
  DockerEventsFeed,
  type StatsListener,
} from './dockerFeeds';
import type { LinkFeed } from './feeds';

/**
 * Docker's streams on every server's link (E06). The core allows each connection two stats
 * streams, four container logs, two events streams and two consoles, eight streams in all, and the
 * Overview and the alert watcher hold some of those. So the app runs one stats stream (every
 * running container) and one events stream per server, shared by every window, and stops logs at
 * four and consoles at two. A shared stream outlives its last listener by a few seconds, so a
 * screen that mounts twice in a row does not open and close it twice.
 */

const MAX_LOGS = 4;
const MAX_CONSOLES = 2;
const LINGER_MS = 5_000;

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

/** A console that is open: what to type into it, resize it with, and how to end it. */
export interface ConsoleHandle {
  write(data: string): boolean;
  resize(columns: number, rows: number): boolean;
  close(): void;
}

export class DockerLinks {
  private readonly stats = new Map<string, Shared<ContainerStatsFeed>>();
  private readonly events = new Map<string, Shared<DockerEventsFeed>>();
  private readonly logs = new Map<string, number>();
  private readonly consoles = new Map<string, number>();

  constructor(private readonly links: Pick<CoreLinks, 'link'>) {}

  /** Every running container's figures: the last couple of minutes first, then each batch. */
  watchStats(serverId: string, listener: StatsListener): () => void {
    const shared = this.shared(this.stats, serverId, () => new ContainerStatsFeed());
    const stop = shared.feed.listen(listener);
    return once(() => {
      stop();
      this.release(this.stats, serverId, shared);
    });
  }

  /** Engine events from now on, each once. */
  watchEvents(serverId: string, listener: Parameters<DockerEventsFeed['listen']>[0]): () => void {
    const shared = this.shared(this.events, serverId, () => new DockerEventsFeed());
    const stop = shared.feed.listen(listener);
    return once(() => {
      stop();
      this.release(this.events, serverId, shared);
    });
  }

  /** One container's log until it is over or the returned call. */
  watchLogs(
    serverId: string,
    options: ContainerLogsOptions,
    events: ContainerLogsFeedEvents,
  ): () => void {
    const release = this.count(
      this.logs,
      serverId,
      MAX_LOGS,
      'Four container logs are already open for this server. Close one first.',
    );
    const feed = new ContainerLogsFeed(options, {
      lines: (lines) => events.lines(lines),
      ended: (end) => {
        release();
        events.ended(end);
      },
    });
    const detach = this.links.link(serverId).attach(feed);
    return once(() => {
      detach();
      release();
    });
  }

  /** A terminal in a container, until its shell exits or it is closed. */
  openConsole(serverId: string, request: ConsoleRequest, events: ConsoleFeedEvents): ConsoleHandle {
    const release = this.count(
      this.consoles,
      serverId,
      MAX_CONSOLES,
      'Two consoles are already open on this server. Close one first.',
    );
    const feed = new ConsoleFeed(request, {
      output: (data, restarted) => events.output(data, restarted),
      ended: (end) => {
        release();
        events.ended(end);
      },
    });
    const detach = this.links.link(serverId).attach(feed);
    return {
      write: (data) => feed.write(data),
      resize: (columns, rows) => feed.resize(columns, rows),
      close: once(() => {
        feed.close();
        detach();
        release();
      }),
    };
  }

  closeAll(): void {
    for (const shared of [...this.stats.values(), ...this.events.values()]) {
      if (shared.linger) clearTimeout(shared.linger);
    }
  }

  private shared<F extends LinkFeed & { listeners: number }>(
    map: Map<string, Shared<F>>,
    serverId: string,
    create: () => F,
  ): Shared<F> {
    let shared = map.get(serverId);
    if (!shared) {
      const feed = create();
      shared = { feed, detach: this.links.link(serverId).attach(feed), linger: null };
      map.set(serverId, shared);
    } else if (shared.linger) {
      clearTimeout(shared.linger);
      shared.linger = null;
    }
    return shared;
  }

  private release<F extends { listeners: number }>(
    map: Map<string, Shared<F>>,
    serverId: string,
    shared: Shared<F>,
  ): void {
    if (shared.feed.listeners > 0) return;
    shared.linger = setTimeout(() => {
      shared.linger = null;
      if (shared.feed.listeners > 0) return;
      shared.detach();
      if (map.get(serverId) === shared) map.delete(serverId);
    }, LINGER_MS);
  }

  private count(
    counts: Map<string, number>,
    serverId: string,
    max: number,
    refusal: string,
  ): () => void {
    const open = counts.get(serverId) ?? 0;
    if (open >= max) throw new Error(refusal);
    counts.set(serverId, open + 1);
    return once(() => counts.set(serverId, (counts.get(serverId) ?? 1) - 1));
  }
}
