import { randomUUID } from 'node:crypto';
import type { IStreamResult } from '@microsoft/signalr';
import type {
  JournalBatch,
  JournalLine,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployJournalEvent,
  DeployJournalWatchInput,
} from '../../../shared/deployAssistantTypes';
import { IPC } from '../../../shared/ipcChannels';
import { hubMessage } from '../connection/hubErrors';
import type { CoreLinks } from '../live/coreLinks';
import type { LinkFeed } from '../live/feeds';
import type { SubscriptionOwner } from '../live/subscriptions';

/**
 * A systemd unit's journal in the logs center (E09 T1). Each belongs to the window that opened it
 * and ends with it. A followed journal that reopens after a drop resumes from the last line's time,
 * so nothing is shown twice.
 * The core redacts every line; the renderer shows them as text only.
 */

const FLUSH_MS = 100;
/** The core allows two journals per connection; the windows share them. */
const MAX_PER_SERVER = 2;
const REOPEN_AFTER_END_MS = 1_000;
const REOPEN_AFTER_FAILURE_MS = 5_000;
const STREAMS_BUSY = /streams open/;

export interface JournalFeedEvents {
  lines(lines: JournalLine[]): void;
  ended(end: { error?: string }): void;
}

export class JournalFeed implements LinkFeed<JournalBatch> {
  private lastAt: number | null = null;

  constructor(
    private readonly input: DeployJournalWatchInput,
    private readonly events: JournalFeedEvents,
  ) {}

  open(hub: ICoreHub): IStreamResult<JournalBatch> {
    const resume = this.lastAt;
    return hub.streamJournal({
      unit: this.input.unit,
      follow: this.input.follow,
      ...(resume === null
        ? {
            ...(this.input.lines === undefined ? {} : { lines: this.input.lines }),
            ...(this.input.sinceUnixMs === undefined
              ? {}
              : { sinceUnixMs: this.input.sinceUnixMs }),
          }
        : { sinceUnixMs: resume, lines: 2_000 }),
    });
  }

  next(batch: JournalBatch): void {
    // journald's --since is a whole second, so lines from that second come again: skip them.
    const fresh =
      this.lastAt === null
        ? batch.lines
        : batch.lines.filter((l) => l.atUnixMs > (this.lastAt ?? 0));
    const last = fresh.at(-1);
    if (last) this.lastAt = last.atUnixMs;
    if (fresh.length > 0) this.events.lines(fresh);
  }

  ended(): number | null {
    if (!this.input.follow) {
      this.events.ended({});
      return null;
    }
    return REOPEN_AFTER_END_MS;
  }

  failed(error: Error): number | null {
    if (STREAMS_BUSY.test(error.message)) return REOPEN_AFTER_FAILURE_MS;
    this.events.ended({ error: hubMessage(error) });
    return null;
  }
}

export interface JournalSubscriptionsDeps {
  links: Pick<CoreLinks, 'attachFeed'>;
  flushMs?: number;
  newId?: () => string;
}

interface Entry {
  ownerId: number;
  serverId: string;
  stop: () => void;
}

export class JournalSubscriptions {
  private readonly entries = new Map<string, Entry>();
  private readonly flushMs: number;
  private readonly newId: () => string;

  constructor(private readonly deps: JournalSubscriptionsDeps) {
    this.flushMs = deps.flushMs ?? FLUSH_MS;
    this.newId = deps.newId ?? randomUUID;
  }

  watch(owner: SubscriptionOwner, input: DeployJournalWatchInput): string {
    const open = [...this.entries.values()].filter((entry) => entry.serverId === input.serverId);
    if (open.length >= MAX_PER_SERVER) {
      throw new Error('Two journals are already open for this server. Close one first.');
    }
    const id = this.newId();
    let lines: JournalLine[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = (ended?: { error?: string }) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!ended && lines.length === 0) return;
      const event: DeployJournalEvent = {
        subscriptionId: id,
        serverId: input.serverId,
        unit: input.unit,
        lines,
        ...(ended ? { ended } : {}),
      };
      lines = [];
      owner.send(IPC.deployLogs.onJournal, event);
    };
    const feed = new JournalFeed(input, {
      lines: (batch) => {
        lines.push(...batch);
        timer ??= setTimeout(() => send(), this.flushMs);
      },
      ended: (end) => {
        send(end);
        this.entries.get(id)?.stop();
        this.entries.delete(id);
      },
    });
    const detach = this.deps.links.attachFeed(input.serverId, feed);
    this.entries.set(id, {
      ownerId: owner.id,
      serverId: input.serverId,
      stop: () => {
        if (timer) clearTimeout(timer);
        timer = null;
        detach();
      },
    });
    return id;
  }

  unwatch(owner: SubscriptionOwner, subscriptionId: string): boolean {
    const entry = this.entries.get(subscriptionId);
    if (!entry || entry.ownerId !== owner.id) return false;
    this.entries.delete(subscriptionId);
    entry.stop();
    return true;
  }

  dropOwner(ownerId: number): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.ownerId !== ownerId) continue;
      this.entries.delete(id);
      entry.stop();
    }
  }

  count(): number {
    return this.entries.size;
  }
}
