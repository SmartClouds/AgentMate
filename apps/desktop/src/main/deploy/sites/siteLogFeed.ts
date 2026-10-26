import type { IStreamResult } from '@microsoft/signalr';
import type {
  SiteLogBatch,
  SiteLogKind,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { hubMessage } from '../connection/hubErrors';
import type { LinkFeed } from '../live/feeds';

/**
 * One site's access or error log, followed for as long as someone watches it. A log has no cursor
 * the core could resume from, so a stream opened again (after a drop or a reboot) starts with the
 * last lines once more, and its first batch is marked `reset`: the window replaces what it shows
 * rather than showing those lines twice. A rotated file comes marked the same way by the core.
 */

export interface SiteLogFeedEvents {
  lines(lines: string[], reset: boolean): void;
  /** The log is over: the site went away, or the core refused to show it. */
  ended(end: { error?: string }): void;
}

const REOPEN_AFTER_END_MS = 1_000;
const REOPEN_AFTER_FAILURE_MS = 5_000;
/** The core refuses a stream over its per-connection limit, and counts a closed one a moment more. */
const STREAMS_BUSY = /streams open/;
export const DEFAULT_TAIL_LINES = 200;

export class SiteLogFeed implements LinkFeed<SiteLogBatch> {
  private opened = 0;
  private fresh = false;

  constructor(
    readonly siteId: string,
    readonly kind: SiteLogKind,
    private readonly tailLines: number,
    private readonly events: SiteLogFeedEvents,
  ) {}

  open(hub: ICoreHub): IStreamResult<SiteLogBatch> {
    this.opened += 1;
    // Every stream after the first starts over with the tail, which replaces what was shown.
    this.fresh = this.opened > 1;
    return hub.streamSiteLog({
      siteId: this.siteId,
      kind: this.kind,
      tailLines: this.tailLines,
      follow: true,
    });
  }

  next(batch: SiteLogBatch): void {
    const reset = batch.reset || this.fresh;
    this.fresh = false;
    if (batch.lines.length === 0 && !reset) return;
    this.events.lines(batch.lines, reset);
  }

  ended(): number {
    // A followed log ends only when the core let go of it; the next stream carries on.
    return REOPEN_AFTER_END_MS;
  }

  failed(error: Error): number | null {
    if (STREAMS_BUSY.test(error.message)) return REOPEN_AFTER_FAILURE_MS;
    this.events.ended({ error: hubMessage(error) });
    return null;
  }
}
