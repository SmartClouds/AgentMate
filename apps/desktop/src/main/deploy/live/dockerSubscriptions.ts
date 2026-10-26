import { randomUUID } from 'node:crypto';
import type {
  ContainerLogLine,
  ContainerStatsBatch,
  DockerEvent,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployConsoleEvent,
  DeployConsoleOpenInput,
  DeployContainerLogsEvent,
  DeployContainerLogsWatchInput,
  DeployContainerStatsEvent,
  DeployDockerEventsEvent,
} from '../../../shared/deployDockerTypes';
import { IPC } from '../../../shared/ipcChannels';
import type { ConsoleHandle, DockerLinks } from './dockerLinks';
import { Batch, type SubscriptionOwner } from './subscriptions';

/**
 * The Containers screen's live subscriptions (E06): stats, a container's log, engine events and
 * consoles. Like the Overview's, each belongs to the window that made it, sends to that window
 * alone, and ends when the window goes away. Stats, logs and events go out in batches; a
 * console's screen goes out within a few milliseconds, since a person is typing into it.
 */

export type DockerSubscriptionKind = 'stats' | 'logs' | 'events' | 'console';

const FLUSH_MS = 100;
const CONSOLE_FLUSH_MS = 8;
const MAX_PER_OWNER = 32;

export interface DockerSubscriptionsDeps {
  links: Pick<DockerLinks, 'watchStats' | 'watchEvents' | 'watchLogs' | 'openConsole'>;
  flushMs?: number;
  consoleFlushMs?: number;
  maxPerOwner?: number;
  newId?: () => string;
}

interface Entry {
  kind: DockerSubscriptionKind;
  ownerId: number;
  stop: () => void;
  cancel: () => void;
  console?: ConsoleHandle;
}

export class DockerSubscriptions {
  private readonly entries = new Map<string, Entry>();
  private readonly flushMs: number;
  private readonly consoleFlushMs: number;
  private readonly maxPerOwner: number;
  private readonly newId: () => string;

  constructor(private readonly deps: DockerSubscriptionsDeps) {
    this.flushMs = deps.flushMs ?? FLUSH_MS;
    this.consoleFlushMs = deps.consoleFlushMs ?? CONSOLE_FLUSH_MS;
    this.maxPerOwner = deps.maxPerOwner ?? MAX_PER_OWNER;
    this.newId = deps.newId ?? randomUUID;
  }

  watchStats(owner: SubscriptionOwner, serverId: string): string {
    const id = this.reserve(owner);
    const batch = new Batch<ContainerStatsBatch>(this.flushMs, (batches) => {
      const event: DeployContainerStatsEvent = { subscriptionId: id, serverId, batches };
      owner.send(IPC.deployDocker.onStats, event);
    });
    const stop = this.deps.links.watchStats(serverId, {
      batch: (item) => batch.push(item),
      failed: (error) => {
        batch.flush();
        const event: DeployContainerStatsEvent = {
          subscriptionId: id,
          serverId,
          batches: [],
          error,
        };
        owner.send(IPC.deployDocker.onStats, event);
      },
    });
    this.entries.set(id, { kind: 'stats', ownerId: owner.id, stop, cancel: () => batch.cancel() });
    return id;
  }

  watchEvents(owner: SubscriptionOwner, serverId: string): string {
    const id = this.reserve(owner);
    const batch = new Batch<DockerEvent>(this.flushMs, (events) => {
      const event: DeployDockerEventsEvent = { subscriptionId: id, serverId, events };
      owner.send(IPC.deployDocker.onEvents, event);
    });
    const stop = this.deps.links.watchEvents(serverId, (item) => batch.push(item));
    this.entries.set(id, { kind: 'events', ownerId: owner.id, stop, cancel: () => batch.cancel() });
    return id;
  }

  watchLogs(owner: SubscriptionOwner, input: DeployContainerLogsWatchInput): string {
    const id = this.reserve(owner);
    const { serverId, containerId } = input;
    let lines: ContainerLogLine[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      lines = [];
    };
    const send = (ended?: { error?: string }) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!ended && lines.length === 0) return;
      const event: DeployContainerLogsEvent = {
        subscriptionId: id,
        serverId,
        containerId,
        lines,
        ...(ended ? { ended } : {}),
      };
      lines = [];
      owner.send(IPC.deployDocker.onLogs, event);
    };
    const stop = this.deps.links.watchLogs(
      serverId,
      {
        containerId,
        follow: input.follow,
        ...(input.tail === undefined ? {} : { tail: input.tail }),
        ...(input.sinceUnixMs === undefined ? {} : { sinceUnixMs: input.sinceUnixMs }),
      },
      {
        lines: (batch) => {
          lines.push(...batch);
          timer ??= setTimeout(() => send(), this.flushMs);
        },
        ended: (end) => {
          done = true;
          send(end.error ? { error: end.error } : {});
          this.entries.delete(id);
        },
      },
    );
    if (!done) this.entries.set(id, { kind: 'logs', ownerId: owner.id, stop, cancel });
    return id;
  }

  openConsole(owner: SubscriptionOwner, input: DeployConsoleOpenInput): string {
    const id = this.reserve(owner);
    const { serverId } = input;
    let pending = '';
    let restarted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!pending) return;
      const event: DeployConsoleEvent = {
        subscriptionId: id,
        serverId,
        data: pending,
        ...(restarted ? { restarted } : {}),
      };
      pending = '';
      restarted = false;
      owner.send(IPC.deployDocker.onConsole, event);
    };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = '';
    };
    const handle = this.deps.links.openConsole(
      serverId,
      {
        containerId: input.containerId,
        columns: input.columns,
        rows: input.rows,
        ...(input.command ? { command: input.command } : {}),
        ...(input.user ? { user: input.user } : {}),
      },
      {
        output: (data, fresh) => {
          // A new shell's first screen goes out on its own, marked, after the old one's last.
          if (fresh) {
            flush();
            restarted = true;
          }
          pending += data;
          timer ??= setTimeout(flush, this.consoleFlushMs);
        },
        ended: (end) => {
          done = true;
          flush();
          const event: DeployConsoleEvent = { subscriptionId: id, serverId, ended: end };
          owner.send(IPC.deployDocker.onConsole, event);
          this.entries.delete(id);
        },
      },
    );
    if (!done) {
      this.entries.set(id, {
        kind: 'console',
        ownerId: owner.id,
        stop: () => handle.close(),
        cancel,
        console: handle,
      });
    }
    return id;
  }

  /** Keystrokes for one of the window's own consoles. False when it has none by that id. */
  consoleInput(owner: SubscriptionOwner, subscriptionId: string, data: string): boolean {
    return this.consoleOf(owner, subscriptionId)?.write(data) ?? false;
  }

  consoleResize(
    owner: SubscriptionOwner,
    subscriptionId: string,
    columns: number,
    rows: number,
  ): boolean {
    return this.consoleOf(owner, subscriptionId)?.resize(columns, rows) ?? false;
  }

  /** Ends one of the window's own subscriptions. False when it has none by that id and kind. */
  unwatch(owner: SubscriptionOwner, kind: DockerSubscriptionKind, subscriptionId: string): boolean {
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

  private consoleOf(owner: SubscriptionOwner, subscriptionId: string): ConsoleHandle | undefined {
    const entry = this.entries.get(subscriptionId);
    return entry && entry.ownerId === owner.id ? entry.console : undefined;
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
