import type { SftpBatchView, SftpConflict, SftpQueueSnapshot } from '@shared/sftpTypes';
import { describe, expect, it } from 'vitest';
import {
  isBatchActive,
  summarizeTransfers,
  type TransferSource,
  type TransferSummary,
} from './transferSummary';

function batch(over: Partial<SftpBatchView> = {}): SftpBatchView {
  return {
    batchId: 'b1',
    kind: 'upload',
    label: 'site',
    source: 'C:\\site',
    target: '/var/www',
    state: 'running',
    totalItems: 10,
    doneItems: 0,
    failedItems: 0,
    skippedItems: 0,
    totalBytes: 1000,
    transferredBytes: 250,
    bytesPerSecond: 100,
    etaSeconds: 7,
    running: [],
    failures: [],
    failuresTruncated: false,
    createdAt: 0,
    finishedAt: null,
    ...over,
  };
}

const CONFLICT: SftpConflict = {
  conflictId: 'c1',
  batchId: 'b1',
  itemId: 'i1',
  direction: 'upload',
  name: 'index.html',
  relPath: 'index.html',
  targetDir: '/var/www',
  source: { size: 1, mtimeMs: 1 },
  target: { size: 2, mtimeMs: 2, isDirectory: false },
  renameTo: 'index (1).html',
  remainingInBatch: 0,
};

function queue(
  batches: SftpBatchView[],
  conflict: SftpConflict | null = null,
  pendingConflicts = 0,
): SftpQueueSnapshot {
  return { sessionId: 's', batches, conflict, pendingConflicts };
}

function source(
  serverId: string,
  snapshot: SftpQueueSnapshot | null,
  names: { session?: string; server?: string } = { session: serverId },
): TransferSource {
  return {
    serverId,
    session: names.session ? { nickname: names.session } : null,
    server: names.server ? { nickname: names.server } : null,
    queue: snapshot,
  };
}

const NOTHING: TransferSummary = {
  active: 0,
  running: 0,
  waiting: 0,
  totalBytes: 0,
  transferredBytes: 0,
  bytesPerSecond: 0,
  direction: null,
  perServer: [],
};

describe('isBatchActive', () => {
  it('counts every state that is not over', () => {
    for (const state of ['expanding', 'queued', 'running', 'waiting'] as const) {
      expect(isBatchActive(state)).toBe(true);
    }
    for (const state of ['done', 'failed', 'cancelled'] as const) {
      expect(isBatchActive(state)).toBe(false);
    }
  });
});

describe('summarizeTransfers', () => {
  it('says nothing runs when there are no servers, no queues or only finished batches', () => {
    expect(summarizeTransfers({})).toEqual(NOTHING);
    expect(summarizeTransfers({ a: source('a', null) })).toEqual(NOTHING);
    expect(
      summarizeTransfers({
        a: source('a', queue([batch({ state: 'done' }), batch({ state: 'failed' })])),
      }),
    ).toEqual(NOTHING);
  });

  it('adds up one running upload', () => {
    expect(summarizeTransfers({ a: source('a', queue([batch()])) })).toEqual({
      active: 1,
      running: 1,
      waiting: 0,
      totalBytes: 1000,
      transferredBytes: 250,
      bytesPerSecond: 100,
      direction: 'up',
      perServer: [{ serverId: 'a', nickname: 'a', active: 1, conflict: false }],
    });
  });

  it('leaves finished batches out of the bytes and the rate', () => {
    const summary = summarizeTransfers({
      a: source(
        'a',
        queue([
          batch({ batchId: 'old', state: 'done', totalBytes: 9999, transferredBytes: 9999 }),
          batch({ batchId: 'now' }),
        ]),
      ),
    });
    expect(summary.totalBytes).toBe(1000);
    expect(summary.transferredBytes).toBe(250);
    expect(summary.active).toBe(1);
  });

  it('counts queued and expanding batches as active but not running', () => {
    const summary = summarizeTransfers({
      a: source(
        'a',
        queue([
          batch({ batchId: 'q', state: 'queued', bytesPerSecond: null, transferredBytes: 0 }),
          // Still walking its folders: no totals yet, so it adds no bytes.
          batch({
            batchId: 'e',
            state: 'expanding',
            totalBytes: null,
            totalItems: null,
            bytesPerSecond: null,
            transferredBytes: 0,
          }),
        ]),
      ),
    });
    expect(summary).toMatchObject({
      active: 2,
      running: 0,
      totalBytes: 1000,
      transferredBytes: 0,
      bytesPerSecond: 0,
      direction: 'up',
    });
  });

  it('says down for downloads and both when they mix', () => {
    const down = batch({ batchId: 'd', kind: 'download' });
    expect(summarizeTransfers({ a: source('a', queue([down])) }).direction).toBe('down');
    expect(summarizeTransfers({ a: source('a', queue([batch(), down])) }).direction).toBe('both');
    // Across servers too.
    expect(
      summarizeTransfers({ a: source('a', queue([batch()])), b: source('b', queue([down])) })
        .direction,
    ).toBe('both');
  });

  it('gives no direction for delete and chmod batches, which still count as active', () => {
    const summary = summarizeTransfers({
      a: source(
        'a',
        queue([
          batch({ batchId: 'x', kind: 'delete', totalBytes: 0, transferredBytes: 0 }),
          batch({ batchId: 'y', kind: 'chmod', totalBytes: 0, transferredBytes: 0 }),
        ]),
      ),
    });
    expect(summary).toMatchObject({ active: 2, running: 2, direction: null, totalBytes: 0 });
  });

  it('counts the conflict shown and those behind it as waiting', () => {
    const summary = summarizeTransfers({
      a: source('a', queue([batch({ state: 'waiting' })], CONFLICT, 2)),
      b: source('b', queue([batch({ state: 'waiting' })], { ...CONFLICT, conflictId: 'c2' })),
    });
    expect(summary.waiting).toBe(4);
    expect(summary.running).toBe(0);
    expect(summary.active).toBe(2);
    expect(summary.perServer.map((one) => one.conflict)).toEqual([true, true]);
  });

  it('lists the servers with something going, by id, named as the session or the saved server says', () => {
    const summary = summarizeTransfers({
      zed: source('zed', queue([batch()]), { session: 'Zed box' }),
      idle: source('idle', queue([batch({ state: 'done' })])),
      alpha: source('alpha', queue([batch(), batch({ batchId: 'b2' })]), { server: 'Alpha' }),
      bare: source('bare', queue([batch()]), {}),
    });
    expect(summary.perServer).toEqual([
      { serverId: 'alpha', nickname: 'Alpha', active: 2, conflict: false },
      { serverId: 'bare', nickname: 'bare', active: 1, conflict: false },
      { serverId: 'zed', nickname: 'Zed box', active: 1, conflict: false },
    ]);
    expect(summary.active).toBe(4);
  });

  it('keeps a server whose conflict waits even when no batch counts as active', () => {
    // A snapshot can carry the conflict a beat before its batch says waiting.
    const summary = summarizeTransfers({
      a: source('a', queue([batch({ state: 'done' })], CONFLICT)),
    });
    expect(summary.perServer).toEqual([
      { serverId: 'a', nickname: 'a', active: 0, conflict: true },
    ]);
    expect(summary.waiting).toBe(1);
  });

  it('answers the same summary whatever order the servers come in, so a JSON selector stays put', () => {
    const a = source('a', queue([batch()]));
    const b = source('b', queue([batch({ kind: 'download' })], CONFLICT));
    const one = JSON.stringify(summarizeTransfers({ a, b }));
    const two = JSON.stringify(summarizeTransfers({ b, a }));
    expect(one).toBe(two);
    expect(JSON.stringify(summarizeTransfers({ a, b }))).toBe(one);
  });
});
