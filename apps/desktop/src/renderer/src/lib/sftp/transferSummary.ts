import type { SftpBatchState, SftpQueueSnapshot } from '@shared/sftpTypes';

/**
 * What the SFTP file manager's transfers add up to across every server (E25), for the status
 * bar, which shows them wherever the user is. Pure and deterministic: the same queues give the
 * same summary whatever order the servers come in, so a selector can compare it as a JSON string
 * while the queue objects themselves change on every snapshot.
 */

/** The parts of a server's file manager state the summary reads (a `ServerFiles` fits). */
export interface TransferSource {
  serverId: string;
  session: { nickname: string } | null;
  server: { nickname: string } | null;
  queue: SftpQueueSnapshot | null;
}

export interface TransferServerSummary {
  serverId: string;
  /** The session's name for the server, else the saved server's, else its id. */
  nickname: string;
  /** Its batches that are not over. */
  active: number;
  /** A conflict waits for an answer on this server. */
  conflict: boolean;
}

export interface TransferSummary {
  /** Batches not over (expanding, queued, running or waiting), delete and chmod included. */
  active: number;
  /** Batches moving now. */
  running: number;
  /** Conflicts waiting for an answer: the one each queue shows plus those behind it. */
  waiting: number;
  /**
   * Bytes of the active batches. One still expanding has no total yet and adds nothing, so the
   * total can grow while the transfer runs, and it is 0 when only deletes and chmods run.
   */
  totalBytes: number;
  transferredBytes: number;
  /** The rates of the active batches that have one, added up; 0 when none does. */
  bytesPerSecond: number;
  /** Which way the active uploads and downloads go; null when none is active. */
  direction: 'up' | 'down' | 'both' | null;
  /** The servers with an active batch or a waiting conflict, by id. */
  perServer: TransferServerSummary[];
}

const ACTIVE_STATES: ReadonlySet<SftpBatchState> = new Set([
  'expanding',
  'queued',
  'running',
  'waiting',
]);

/** Whether a batch in this state is still going (a conflict waiting counts). */
export function isBatchActive(state: SftpBatchState): boolean {
  return ACTIVE_STATES.has(state);
}

export function summarizeTransfers(servers: Record<string, TransferSource>): TransferSummary {
  const summary: TransferSummary = {
    active: 0,
    running: 0,
    waiting: 0,
    totalBytes: 0,
    transferredBytes: 0,
    bytesPerSecond: 0,
    direction: null,
    perServer: [],
  };
  let up = false;
  let down = false;
  const entries = Object.values(servers).sort((a, b) =>
    a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0,
  );
  for (const entry of entries) {
    const queue = entry.queue;
    if (!queue) continue;
    let active = 0;
    for (const batch of queue.batches) {
      if (!isBatchActive(batch.state)) continue;
      active += 1;
      if (batch.state === 'running') summary.running += 1;
      summary.totalBytes += batch.totalBytes ?? 0;
      summary.transferredBytes += batch.transferredBytes;
      summary.bytesPerSecond += batch.bytesPerSecond ?? 0;
      if (batch.kind === 'upload') up = true;
      else if (batch.kind === 'download') down = true;
    }
    const conflict = queue.conflict !== null;
    summary.active += active;
    summary.waiting += (conflict ? 1 : 0) + queue.pendingConflicts;
    if (active > 0 || conflict) {
      summary.perServer.push({
        serverId: entry.serverId,
        nickname: entry.session?.nickname ?? entry.server?.nickname ?? entry.serverId,
        active,
        conflict,
      });
    }
  }
  summary.direction = up && down ? 'both' : up ? 'up' : down ? 'down' : null;
  return summary;
}
