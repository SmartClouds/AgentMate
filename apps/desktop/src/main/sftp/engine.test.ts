import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import type { SftpBatchFinished, SftpBatchView, SftpQueueSnapshot } from '../../shared/sftpTypes';
import { encodeSshError } from '../../shared/sshErrors';
import { tempDir, writeTree } from '../../test/main/fixtures';
import type { FileUploadOptions, SftpFileClient } from './client';
import { createTransferEngine, type TransferEngine, type TransferEngineDeps } from './engine';
import { type FakeSftpClient, FakeSftpServer, SFTP_STATUS } from './testing/fakeSftpClient';

/**
 * The transfer queue of one SFTP session (E25): batches of uploads, downloads, deletes and chmods
 * run at most 3 files at a time across the session, report progress in coalesced snapshots, can
 * be cancelled and retried, ask before replacing anything (one conflict shown at a time, "apply
 * to all" per batch), never follow links to folders, and keep their own connection that is
 * released once the queue has been idle a while.
 *
 * Only timers and Date are faked; the fake server answers on microtasks and local files are real,
 * so `until` spins the real event loop.
 */

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: T0,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

async function until(check: () => boolean, what = 'the condition'): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function spin(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function caught(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

interface Harness {
  server: FakeSftpServer;
  engine: TransferEngine;
  emitted: SftpQueueSnapshot[];
  finished: SftpBatchFinished[];
  busy: boolean[];
  /** A local folder for this test. */
  local: string;
  /** Every uploadFile call the engine made: the remote path and the options. */
  uploads: { remotePath: string; options: FileUploadOptions }[];
  batch(batchId: string): SftpBatchView;
  done(batchId: string): Promise<SftpBatchFinished>;
}

type Overrides = Partial<TransferEngineDeps> & {
  /** Swaps the client the engine gets, to script one of its calls. */
  wrap?: (client: FakeSftpClient) => SftpFileClient;
  server?: FakeSftpServer;
};

/** A client that answers like `client`, except for what `overrides` replaces. */
function scripted(client: FakeSftpClient, overrides: Partial<SftpFileClient>): SftpFileClient {
  return Object.assign(Object.create(client) as SftpFileClient, overrides);
}

function setup(overrides: Overrides = {}): Harness {
  const server = overrides.server ?? new FakeSftpServer({ home: '/home/deploy' });
  server.dir('/srv/www');
  const emitted: SftpQueueSnapshot[] = [];
  const finished: SftpBatchFinished[] = [];
  const busy: boolean[] = [];
  const uploads: Harness['uploads'] = [];
  let lease: { release(): void } | null = null;
  const { wrap, server: _server, ...deps } = overrides;
  const engine = createTransferEngine({
    sessionId: 'session-1',
    transferClient: async () => {
      const opened = await server.pool.openSeparate('server-1');
      lease = opened;
      const client = opened.client as FakeSftpClient;
      const base = wrap ? wrap(client) : client;
      return scripted(client, {
        sftpListDetailed: base.sftpListDetailed.bind(base),
        sftpStat: base.sftpStat.bind(base),
        sftpMkdir: base.sftpMkdir.bind(base),
        sftpUnlink: base.sftpUnlink.bind(base),
        sftpRmdir: base.sftpRmdir.bind(base),
        sftpChmod: base.sftpChmod.bind(base),
        downloadFile: base.downloadFile.bind(base),
        uploadFile: (localPath, remotePath, options = {}) => {
          uploads.push({ remotePath, options });
          return base.uploadFile(localPath, remotePath, options);
        },
      });
    },
    releaseTransferClient: () => {
      lease?.release();
      lease = null;
    },
    emit: (snapshot) => emitted.push(snapshot),
    finished: (event) => finished.push(event),
    busy: (value) => busy.push(value),
    now: () => Date.now(),
    platform: 'linux',
    ...deps,
  });
  const batch = (batchId: string): SftpBatchView => {
    const found = engine.snapshot().batches.find((view) => view.batchId === batchId);
    if (!found) throw new Error(`no batch ${batchId}`);
    return found;
  };
  const done = async (batchId: string): Promise<SftpBatchFinished> => {
    await until(() => finished.some((event) => event.batchId === batchId), `batch ${batchId}`);
    return finished.filter((event) => event.batchId === batchId).pop() as SftpBatchFinished;
  };
  return {
    server,
    engine,
    emitted,
    finished,
    busy,
    local: tempDir('agentmate-engine-'),
    uploads,
    batch,
    done,
  };
}

function file(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('single files', () => {
  it('uploads a file and reports the remote folder', async () => {
    const h = setup();
    const source = file(h.local, 'index.html', '<h1>hi</h1>');
    const batchId = h.engine.enqueueUpload({ localPaths: [source], remoteDir: '/srv/www' });
    const event = await h.done(batchId);
    expect(event).toEqual({
      sessionId: 'session-1',
      batchId,
      kind: 'upload',
      side: 'remote',
      target: '/srv/www',
      ok: true,
      failed: 0,
    });
    expect(h.server.read('/srv/www/index.html')?.toString()).toBe('<h1>hi</h1>');
    expect(h.batch(batchId)).toMatchObject({
      kind: 'upload',
      label: 'index.html',
      source: h.local,
      target: '/srv/www',
      state: 'done',
      totalItems: 1,
      doneItems: 1,
      totalBytes: 11,
      transferredBytes: 11,
      running: [],
      failures: [],
      finishedAt: T0,
    });
    expect(h.engine.activeCount()).toBe(0);
  });

  it('downloads a file into the local folder, keeping its time, and reports the local side', async () => {
    const h = setup();
    h.server.file('/srv/www/notes.txt', 'remote words', { mtimeMs: T0 - 86_400_000 });
    const batchId = h.engine.enqueueDownload({
      remotePaths: ['/srv/www/notes.txt'],
      localDir: h.local,
    });
    const event = await h.done(batchId);
    expect(event).toMatchObject({ kind: 'download', side: 'local', target: h.local, ok: true });
    expect(readFileSync(join(h.local, 'notes.txt'), 'utf-8')).toBe('remote words');
    expect(statSync(join(h.local, 'notes.txt')).mtimeMs).toBe(T0 - 86_400_000);
    expect(h.batch(batchId)).toMatchObject({
      source: '/srv/www',
      target: h.local,
      label: 'notes.txt',
    });
  });

  it('sends the local mode on POSIX and none on Windows', async () => {
    const posix = setup({ platform: 'linux' });
    const a = file(posix.local, 'a.sh', '#!/bin/sh');
    await posix.done(posix.engine.enqueueUpload({ localPaths: [a], remoteDir: '/srv/www' }));
    expect(posix.uploads[0].options.mode).toBe(statSync(a).mode & 0o7777);

    const windows = setup({ platform: 'win32' });
    const b = file(windows.local, 'b.sh', '#!/bin/sh');
    await windows.done(windows.engine.enqueueUpload({ localPaths: [b], remoteDir: '/srv/www' }));
    expect('mode' in windows.uploads[0].options).toBe(false);
  });

  it('gives a downloaded name Windows refuses a safe one', async () => {
    const h = setup({ platform: 'win32' });
    h.server.file('/srv/www/CON', 'device?');
    const batchId = h.engine.enqueueDownload({ remotePaths: ['/srv/www/CON'], localDir: h.local });
    await h.done(batchId);
    expect(readFileSync(join(h.local, 'CON_'), 'utf-8')).toBe('device?');
  });

  it('fails with localChanged when the local file changes while it is sent', async () => {
    let calls = 0;
    const h = setup({
      localStat: async (path) => {
        calls += 1;
        const info = await stat(path);
        return { size: info.size, mtimeMs: info.mtimeMs + (calls > 1 ? 5000 : 0) };
      },
    });
    const source = file(h.local, 'log.txt', 'growing');
    const batchId = h.engine.enqueueUpload({ localPaths: [source], remoteDir: '/srv/www' });
    const event = await h.done(batchId);
    expect(event).toMatchObject({ ok: false, failed: 1 });
    const view = h.batch(batchId);
    expect(view.state).toBe('failed');
    expect(view.failures).toEqual([
      expect.objectContaining({ relPath: 'log.txt', state: 'failed', errorCode: 'localChanged' }),
    ]);
    expect(view.failures[0].error).not.toMatch(/\[files:/);
  });

  it('codes an SFTP status the server sends', async () => {
    const h = setup();
    h.server.failNext('uploadFile', SFTP_STATUS.permissionDenied);
    const source = file(h.local, 'a.txt', 'a');
    const batchId = h.engine.enqueueUpload({ localPaths: [source], remoteDir: '/srv/www' });
    await h.done(batchId);
    expect(h.batch(batchId).failures[0].errorCode).toBe('permissionDenied');
  });

  it('fails a source that is gone by the time it is read', async () => {
    const h = setup();
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'missing.txt')],
      remoteDir: '/srv/www',
    });
    await h.done(batchId);
    expect(h.batch(batchId).failures[0]).toMatchObject({
      relPath: 'missing.txt',
      errorCode: 'folderMissing',
    });
    const remote = h.engine.enqueueDownload({ remotePaths: ['/srv/www/none'], localDir: h.local });
    await h.done(remote);
    expect(h.batch(remote).failures[0].errorCode).toBe('remoteFolderMissing');
  });

  it('refuses an empty selection', () => {
    const h = setup();
    expect(
      filesErrorCode(caught(() => h.engine.enqueueUpload({ localPaths: [], remoteDir: '/srv' }))),
    ).toBe('invalidInput');
  });
});

describe('concurrency, progress and snapshots', () => {
  it('runs at most 3 transfers at once across batches', async () => {
    const h = setup();
    const gate = h.server.gate('uploadFile');
    const ids = ['1', '2', '3', '4', '5'].map((name) =>
      h.engine.enqueueUpload({
        localPaths: [file(h.local, `${name}.txt`, name)],
        remoteDir: '/srv/www',
      }),
    );
    await gate.waitFor(3);
    await spin();
    expect(gate.waiting).toBe(3);
    const running = h.engine.snapshot().batches.flatMap((view) => view.running);
    expect(running).toHaveLength(3);
    expect(h.batch(ids[4]).state).toBe('queued');
    gate.open();
    for (const id of ids) await h.done(id);
    expect(h.server.maxInFlight('uploadFile')).toBe(3);
  });

  it('honours a smaller concurrency', async () => {
    const h = setup({ concurrency: 1 });
    const gate = h.server.gate('uploadFile');
    h.engine.enqueueUpload({ localPaths: [file(h.local, 'a.txt', 'a')], remoteDir: '/srv/www' });
    h.engine.enqueueUpload({ localPaths: [file(h.local, 'b.txt', 'b')], remoteDir: '/srv/www' });
    await gate.waitFor(1);
    await spin();
    expect(gate.waiting).toBe(1);
    gate.open();
  });

  it('coalesces snapshots to one per interval, and only sends one when something changed', async () => {
    const hooks: { progress?: (sent: number) => void; finish?: () => void } = {};
    const h = setup({
      wrap: (client) =>
        scripted(client, {
          uploadFile: async (_local, _remote, options = {}) => {
            hooks.progress = (sent) => options.onProgress?.(sent);
            await new Promise<void>((resolve) => {
              hooks.finish = resolve;
            });
            const stat = { isDirectory: false, isFile: true, size: 1000, mtimeMs: T0, mode: 0o644 };
            return { stat, atomic: true, replaced: false, sha256: 'x' };
          },
        }),
      localStat: async () => ({ size: 1000, mtimeMs: T0 }),
    });
    const batchId = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'big.bin', 'x'.repeat(1000))],
      remoteDir: '/srv/www',
    });
    expect(h.emitted).toHaveLength(0);
    await until(() => hooks.progress !== undefined, 'the upload to start');
    await vi.advanceTimersByTimeAsync(100);
    const settledCount = h.emitted.length;
    expect(settledCount).toBeGreaterThanOrEqual(1);

    for (let step = 1; step <= 10; step += 1) hooks.progress?.(step * 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.emitted).toHaveLength(settledCount);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.emitted).toHaveLength(settledCount + 1);
    expect(h.emitted[h.emitted.length - 1].batches[0].running[0]).toMatchObject({
      relPath: 'big.bin',
      size: 1000,
      transferred: 500,
      state: 'running',
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.emitted).toHaveLength(settledCount + 1);

    // A second of steady progress gives a rate and a time left.
    for (let step = 1; step <= 10; step += 1) {
      await vi.advanceTimersByTimeAsync(100);
      hooks.progress?.(500 + step * 40);
    }
    const view = h.batch(batchId);
    expect(view.transferredBytes).toBe(900);
    expect(view.bytesPerSecond).toBeGreaterThan(0);
    expect(view.etaSeconds).toBeGreaterThanOrEqual(1);
    hooks.finish?.();
    await h.done(batchId);
    expect(h.batch(batchId).bytesPerSecond).toBeNull();
  });

  it('toggles busy once from idle to active and back', async () => {
    const h = setup();
    const a = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'a')],
      remoteDir: '/srv/www',
    });
    const b = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'b.txt', 'b')],
      remoteDir: '/srv/www',
    });
    await h.done(a);
    await h.done(b);
    await spin();
    expect(h.busy).toEqual([true, false]);
  });
});

describe('cancel, retry, clear', () => {
  it('cancels running and queued items as cancelled, not failed', async () => {
    const h = setup();
    writeTree(h.local, {
      'site/1.txt': '1',
      'site/2.txt': '2',
      'site/3.txt': '3',
      'site/4.txt': '4',
      'site/5.txt': '5',
    });
    const gate = h.server.gate('uploadFile');
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await gate.waitFor(3);
    h.engine.cancel({ batchId });
    const event = await h.done(batchId);
    gate.open();
    expect(event).toMatchObject({ ok: true, failed: 0 });
    const view = h.batch(batchId);
    expect(view.state).toBe('cancelled');
    expect(view.failedItems).toBe(0);
    expect(view.failures).toEqual([]);
    expect(h.server.list('/srv/www/site')).toEqual([]);
  });

  it('cancels a single queued item and lets the rest finish', async () => {
    const h = setup({ concurrency: 1 });
    writeTree(h.local, { 'site/a.txt': 'a', 'site/b.txt': 'b' });
    const gate = h.server.gate('uploadFile');
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await gate.waitFor(1);
    const snapshot = h.engine.snapshot();
    expect(snapshot.batches[0].running[0].relPath).toBe('site/a.txt');
    // Items are numbered from the root down: site, site/a.txt, site/b.txt.
    h.engine.cancel({ batchId, itemId: '3' });
    gate.open();
    await h.done(batchId);
    expect(h.server.list('/srv/www/site')).toEqual(['a.txt']);
    expect(h.batch(batchId)).toMatchObject({ state: 'cancelled', doneItems: 2 });
  });

  it('cancels everything with an empty target', async () => {
    const h = setup();
    const gate = h.server.gate('uploadFile');
    const a = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'a')],
      remoteDir: '/srv/www',
    });
    const b = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'b.txt', 'b')],
      remoteDir: '/srv/www',
    });
    await gate.waitFor(2);
    h.engine.cancel();
    await h.done(a);
    await h.done(b);
    gate.open();
    expect(h.batch(a).state).toBe('cancelled');
    expect(h.batch(b).state).toBe('cancelled');
  });

  it('retries failed items and clears finished batches', async () => {
    const h = setup();
    h.server.failNext('uploadFile', '/srv/www/a.txt', SFTP_STATUS.permissionDenied);
    const batchId = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'a')],
      remoteDir: '/srv/www',
    });
    expect(await h.done(batchId)).toMatchObject({ ok: false, failed: 1 });
    expect(h.batch(batchId)).toMatchObject({ state: 'failed', failedItems: 1 });

    h.engine.retry({ batchId });
    expect(h.batch(batchId).state).not.toBe('failed');
    await until(() => h.finished.filter((event) => event.batchId === batchId).length === 2);
    expect(h.batch(batchId)).toMatchObject({ state: 'done', failedItems: 0, finishedAt: T0 });
    expect(h.server.read('/srv/www/a.txt')?.toString()).toBe('a');

    const gate = h.server.gate('uploadFile');
    const pending = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'b.txt', 'b')],
      remoteDir: '/srv/www',
    });
    await gate.waitFor(1);
    h.engine.clearFinished();
    expect(h.engine.snapshot().batches.map((view) => view.batchId)).toEqual([pending]);
    gate.open();
    await h.done(pending);
  });

  it('retries one item, and everything with an empty target', async () => {
    const h = setup();
    h.server.failNext('uploadFile', '/srv/www/a.txt', SFTP_STATUS.permissionDenied);
    const a = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'a')],
      remoteDir: '/srv/www',
    });
    await h.done(a);
    h.engine.retry({ batchId: a, itemId: '1' });
    await until(() => h.batch(a).state === 'done');

    h.server.failNext('uploadFile', '/srv/www/b.txt', SFTP_STATUS.permissionDenied);
    const b = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'b.txt', 'b')],
      remoteDir: '/srv/www',
    });
    await h.done(b);
    h.engine.retry();
    await until(() => h.batch(b).state === 'done');
  });

  it('refuses an unknown batch or item', () => {
    const h = setup();
    expect(filesErrorCode(caught(() => h.engine.cancel({ batchId: 'nope' })))).toBe('invalidInput');
    expect(filesErrorCode(caught(() => h.engine.retry({ itemId: '1' })))).toBe('invalidInput');
    const batchId = h.engine.enqueueDelete(['/srv/www/x']);
    expect(filesErrorCode(caught(() => h.engine.cancel({ batchId, itemId: '99' })))).toBe(
      'invalidInput',
    );
  });
});

describe('the transfer connection', () => {
  it('opens one connection lazily, reuses it, and releases it after the idle delay', async () => {
    const h = setup();
    expect(h.server.pool.openedSeparate).toBe(0);
    const a = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'a')],
      remoteDir: '/srv/www',
    });
    await h.done(a);
    const b = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'b.txt', 'b')],
      remoteDir: '/srv/www',
    });
    await h.done(b);
    await spin();
    expect(h.server.pool.openedSeparate).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.server.pool.released).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.server.pool.released).toBe(1);

    const c = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'c.txt', 'c')],
      remoteDir: '/srv/www',
    });
    await h.done(c);
    expect(h.server.pool.openedSeparate).toBe(2);
  });

  it('honours a custom idle delay', async () => {
    const h = setup({ idleReleaseMs: 1000 });
    await h.done(
      h.engine.enqueueUpload({ localPaths: [file(h.local, 'a.txt', 'a')], remoteDir: '/srv/www' }),
    );
    await spin();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.server.pool.released).toBe(1);
  });

  it('retries a transfer once on a fresh connection when the connection drops', async () => {
    const h = setup();
    h.server.failNext('uploadFile', new Error('The SSH connection to fake.example closed.'));
    const batchId = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'a')],
      remoteDir: '/srv/www',
    });
    expect(await h.done(batchId)).toMatchObject({ ok: true });
    expect(h.server.pool.openedSeparate).toBe(2);
    expect(h.server.pool.released).toBe(1);
    expect(h.server.read('/srv/www/a.txt')?.toString()).toBe('a');
  });

  it('fails as unreachable when the fresh connection drops too', async () => {
    const h = setup();
    h.server.failNext('uploadFile', new Error('The SSH connection to fake.example closed.'));
    h.server.failNext('uploadFile', new Error('The SSH connection to fake.example closed.'));
    const batchId = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'a')],
      remoteDir: '/srv/www',
    });
    await h.done(batchId);
    expect(h.batch(batchId).failures[0].errorCode).toBe('unreachable');
  });

  it('opens a fresh connection when the one it had closed', async () => {
    const h = setup();
    await h.done(
      h.engine.enqueueUpload({ localPaths: [file(h.local, 'a.txt', 'a')], remoteDir: '/srv/www' }),
    );
    h.server.dropConnection();
    await h.done(
      h.engine.enqueueUpload({ localPaths: [file(h.local, 'b.txt', 'b')], remoteDir: '/srv/www' }),
    );
    expect(h.server.pool.openedSeparate).toBe(2);
  });

  it('fails the queue when the connection cannot be opened, without trying again for each file', async () => {
    let opens = 0;
    const h = setup({
      transferClient: async () => {
        opens += 1;
        throw new Error(encodeSshError('vault-locked', 'Unlock the Servers vault first.'));
      },
    });
    writeTree(h.local, {
      'site/1.txt': '1',
      'site/2.txt': '2',
      'site/3.txt': '3',
      'site/4.txt': '4',
    });
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    expect(await h.done(batchId)).toMatchObject({ ok: false, failed: 5 });
    expect(opens).toBe(1);
    expect(h.batch(batchId).failures[0]).toMatchObject({
      errorCode: 'vaultLocked',
      error: 'Unlock the Servers vault first.',
    });
  });
});

describe('connection failures', () => {
  it('fails every queued batch with one attempt to connect', async () => {
    let opens = 0;
    let refuse: () => void = () => undefined;
    const refused = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    const h = setup({
      transferClient: async () => {
        opens += 1;
        await refused;
        throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), {
          code: 'ECONNREFUSED',
        });
      },
      concurrency: 1,
    });
    const a = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'a')],
      remoteDir: '/srv/www',
    });
    const b = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'b.txt', 'b')],
      remoteDir: '/srv/www',
    });
    await until(() => h.batch(b).state === 'queued', 'both batches to be walked');
    refuse();
    await h.done(a);
    await h.done(b);
    expect(opens).toBe(1);
    expect(h.batch(b).failures[0].errorCode).toBe('unreachable');
  });

  it('fails a download when the connection for its walk cannot be opened', async () => {
    const h = setup({
      transferClient: async () => {
        throw new Error(encodeSshError('host-key-changed', 'The host key changed.'));
      },
    });
    const batchId = h.engine.enqueueDownload({
      remotePaths: ['/srv/a', '/srv/b'],
      localDir: h.local,
    });
    expect(await h.done(batchId)).toMatchObject({ ok: false, failed: 2 });
    expect(h.batch(batchId).failures.map((item) => item.errorCode)).toEqual([
      'hostKeyChanged',
      'hostKeyChanged',
    ]);
  });

  it('codes local file errors by what went wrong', async () => {
    const cases = [
      ['EACCES', 'permissionDenied'],
      ['EPERM', 'permissionDenied'],
      ['ENOSPC', 'diskFull'],
      ['EEXIST', 'exists'],
      ['EBUSY', 'server'],
      ['EIO', 'server'],
    ] as const;
    for (const [code, expected] of cases) {
      const h = setup({
        localStat: async () => {
          throw Object.assign(new Error(`${code}: failed`), { code, syscall: 'stat' });
        },
      });
      const batchId = h.engine.enqueueUpload({
        localPaths: [file(h.local, 'a.txt', 'a')],
        remoteDir: '/srv/www',
      });
      await h.done(batchId);
      expect(h.batch(batchId).failures[0].errorCode).toBe(expected);
    }
  });
});

describe('folders', () => {
  it('uploads a folder, making each folder before the files in it, empty ones too', async () => {
    const h = setup();
    writeTree(h.local, {
      'site/index.html': 'i',
      'site/css/site.css': 'c',
      'site/css/deep/x.css': 'x',
    });
    mkdirSync(join(h.local, 'site', 'empty'));
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await h.done(batchId);
    const order = h.server.calls
      .filter((call) => call.op === 'sftpMkdir' || call.op === 'uploadFile')
      .map((call) => call.path);
    expect(order.indexOf('/srv/www/site')).toBe(0);
    expect(order.indexOf('/srv/www/site/css')).toBeLessThan(
      order.indexOf('/srv/www/site/css/site.css'),
    );
    expect(order.indexOf('/srv/www/site/css/deep')).toBeLessThan(
      order.indexOf('/srv/www/site/css/deep/x.css'),
    );
    expect(h.server.list('/srv/www/site')).toEqual(['css', 'empty', 'index.html']);
    expect(h.server.read('/srv/www/site/css/deep/x.css')?.toString()).toBe('x');
    expect(h.batch(batchId)).toMatchObject({
      label: 'site (3 files)',
      totalItems: 7,
      doneItems: 7,
      totalBytes: 3,
    });
  });

  it('merges into a folder that is already on the server', async () => {
    const h = setup();
    h.server.file('/srv/www/site/keep.txt', 'theirs');
    writeTree(h.local, { 'site/new.txt': 'mine' });
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await h.done(batchId);
    expect(h.server.list('/srv/www/site')).toEqual(['keep.txt', 'new.txt']);
    expect(h.engine.snapshot().conflict).toBeNull();
  });

  it('fails the subtree with exists where a file stands in for a folder', async () => {
    const h = setup();
    h.server.file('/srv/www/site/css', 'a file, not a folder');
    writeTree(h.local, { 'site/css/a.css': 'a', 'site/css/b.css': 'b', 'site/index.html': 'i' });
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    expect(await h.done(batchId)).toMatchObject({ ok: false, failed: 3 });
    const view = h.batch(batchId);
    expect(view.failures.map((item) => [item.relPath, item.errorCode])).toEqual([
      ['site/css', 'exists'],
      ['site/css/a.css', 'exists'],
      ['site/css/b.css', 'exists'],
    ]);
    expect(h.server.read('/srv/www/site/index.html')?.toString()).toBe('i');
  });

  it('retries an item together with the folders above it that failed', async () => {
    const h = setup();
    h.server.file('/srv/www/site/css', 'a file, not a folder');
    writeTree(h.local, { 'site/css/a.css': 'a' });
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await h.done(batchId);
    const client = h.server.connect();
    await client.sftpUnlink('/srv/www/site/css');
    const child = h.batch(batchId).failures.find((item) => item.relPath === 'site/css/a.css');
    h.engine.retry({ batchId, itemId: child?.itemId ?? '' });
    await until(() => h.batch(batchId).state === 'done', 'the retry');
    expect(h.server.read('/srv/www/site/css/a.css')?.toString()).toBe('a');
  });

  it('cancels a folder item with everything under it', async () => {
    const h = setup();
    writeTree(h.local, { 'site/a.txt': 'a', 'site/b.txt': 'b' });
    const gate = h.server.gate('sftpMkdir');
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await gate.waitFor(1);
    h.engine.cancel({ batchId, itemId: '1' });
    gate.open();
    await h.done(batchId);
    expect(h.server.callsOf('uploadFile')).toEqual([]);
    expect(h.batch(batchId).state).toBe('cancelled');
  });

  it('lists the first 50 failures and says there were more', async () => {
    const h = setup();
    const files: Record<string, string> = {};
    for (let index = 0; index < 52; index += 1)
      files[`site/f${String(index).padStart(2, '0')}.txt`] = 'x';
    writeTree(h.local, files);
    for (let index = 0; index < 52; index += 1)
      h.server.failNext('uploadFile', SFTP_STATUS.permissionDenied);
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await h.done(batchId);
    const view = h.batch(batchId);
    expect(view.failedItems).toBe(52);
    expect(view.failures).toHaveLength(50);
    expect(view.failuresTruncated).toBe(true);
    expect(view.label).toBe('site (52 files)');
  });

  it('refuses to transfer the root folder', () => {
    const h = setup();
    expect(
      filesErrorCode(
        caught(() => h.engine.enqueueDownload({ remotePaths: ['/'], localDir: h.local })),
      ),
    ).toBe('invalidInput');
  });

  it('downloads a folder, making the local folders', async () => {
    const h = setup();
    h.server
      .file('/srv/site/index.html', 'i')
      .file('/srv/site/css/deep/x.css', 'x')
      .dir('/srv/site/empty');
    const batchId = h.engine.enqueueDownload({ remotePaths: ['/srv/site'], localDir: h.local });
    await h.done(batchId);
    expect(readFileSync(join(h.local, 'site', 'css', 'deep', 'x.css'), 'utf-8')).toBe('x');
    expect(statSync(join(h.local, 'site', 'empty')).isDirectory()).toBe(true);
    expect(h.batch(batchId)).toMatchObject({
      label: 'site (2 files)',
      totalItems: 6,
      state: 'done',
    });
  });

  it('fails a download subtree where a local file stands in for a folder', async () => {
    const h = setup();
    h.server.file('/srv/site/css/x.css', 'x');
    mkdirSync(join(h.local, 'site'));
    writeFileSync(join(h.local, 'site', 'css'), 'local file');
    const batchId = h.engine.enqueueDownload({ remotePaths: ['/srv/site'], localDir: h.local });
    await h.done(batchId);
    expect(h.batch(batchId).failures.map((item) => item.errorCode)).toEqual(['exists', 'exists']);
  });

  it('shows the batch as expanding with no totals while it walks', async () => {
    const h = setup();
    h.server.file('/srv/site/a.txt', 'a');
    const gate = h.server.gate('sftpListDetailed');
    const batchId = h.engine.enqueueDownload({ remotePaths: ['/srv/site'], localDir: h.local });
    await gate.waitFor(1);
    expect(h.batch(batchId)).toMatchObject({
      state: 'expanding',
      label: 'site',
      totalItems: null,
      totalBytes: null,
    });
    gate.open();
    await h.done(batchId);
  });

  it('cancels during the walk', async () => {
    const h = setup();
    h.server.file('/srv/site/a.txt', 'a');
    const gate = h.server.gate('sftpListDetailed');
    const batchId = h.engine.enqueueDownload({ remotePaths: ['/srv/site'], localDir: h.local });
    await gate.waitFor(1);
    gate.release(1);
    await gate.waitFor(1);
    h.engine.cancel({ batchId });
    gate.open();
    expect(await h.done(batchId)).toMatchObject({ ok: true, failed: 0 });
    expect(h.batch(batchId).state).toBe('cancelled');
    expect(h.server.callsOf('downloadFile')).toEqual([]);

    h.engine.retry({ batchId });
    await until(() => h.batch(batchId).state === 'done', 'the retried walk');
    expect(readFileSync(join(h.local, 'site', 'a.txt'), 'utf-8')).toBe('a');
  });

  it('walks again when a walk is cancelled and retried before it settles', async () => {
    const h = setup();
    h.server.file('/srv/site/a.txt', 'a');
    const gate = h.server.gate('sftpListDetailed');
    const batchId = h.engine.enqueueDownload({ remotePaths: ['/srv/site'], localDir: h.local });
    await gate.waitFor(1);
    gate.release(1);
    await gate.waitFor(1);
    h.engine.cancel({ batchId });
    h.engine.retry({ batchId });
    gate.open();
    await h.done(batchId);
    expect(h.batch(batchId)).toMatchObject({ state: 'done', doneItems: 2, totalItems: 2 });
    expect(h.server.callsOf('downloadFile')).toEqual(['/srv/site/a.txt']);
    expect(readFileSync(join(h.local, 'site', 'a.txt'), 'utf-8')).toBe('a');
    expect(h.finished.filter((event) => event.batchId === batchId)).toHaveLength(1);
  });

  it('walks a root retried while another root of the batch is still being walked', async () => {
    const h = setup();
    h.server.file('/srv/site/a.txt', 'a').file('/srv/site/b.txt', 'b');
    const gate = h.server.gate('sftpListDetailed');
    const batchId = h.engine.enqueueDownload({
      remotePaths: ['/srv/late.txt', '/srv/site'],
      localDir: h.local,
    });
    await gate.waitFor(1);
    gate.release(1);
    // late.txt is not there yet, so its root fails while the walk of site waits at the gate.
    await gate.waitFor(1);
    expect(h.batch(batchId).state).toBe('expanding');
    h.server.file('/srv/late.txt', 'late');
    h.engine.retry({ batchId });
    gate.open();
    await h.done(batchId);
    const listings = h.server.callsOf('sftpListDetailed');
    expect(listings.filter((path) => path === '/srv/site')).toHaveLength(1);
    const downloads = h.server.callsOf('downloadFile');
    expect(new Set(downloads).size).toBe(downloads.length);
    expect(downloads.sort()).toEqual(['/srv/late.txt', '/srv/site/a.txt', '/srv/site/b.txt']);
    const view = h.batch(batchId);
    expect(view).toMatchObject({ state: 'done', failedItems: 0 });
    expect(view.doneItems).toBe(view.totalItems);
  });

  it('labels a single skipped link to a folder by its name alone', async () => {
    const h = setup();
    h.server.dir('/etc').link('/srv/linkdir', '/etc');
    const batchId = h.engine.enqueueDownload({ remotePaths: ['/srv/linkdir'], localDir: h.local });
    await h.done(batchId);
    expect(h.batch(batchId)).toMatchObject({ label: 'linkdir', skippedItems: 1, state: 'done' });
  });

  it('never follows a remote link to a folder, and shows it as skipped', async () => {
    const h = setup();
    h.server.file('/etc/passwd', 'root').file('/srv/site/a.txt', 'a').link('/srv/site/etc', '/etc');
    h.server.link('/srv/linkdir', '/etc');
    const batchId = h.engine.enqueueDownload({
      remotePaths: ['/srv/site', '/srv/linkdir'],
      localDir: h.local,
    });
    await h.done(batchId);
    expect(h.server.callsOf('sftpListDetailed')).not.toContain('/etc');
    expect(h.server.callsOf('sftpListDetailed')).not.toContain('/srv/site/etc');
    expect(() => statSync(join(h.local, 'site', 'etc'))).toThrow();
    expect(() => statSync(join(h.local, 'linkdir'))).toThrow();
    expect(h.batch(batchId)).toMatchObject({
      label: '2 items (1 file)',
      skippedItems: 2,
      state: 'done',
    });
  });

  it('never follows a local link to a folder', async () => {
    const h = setup();
    const outside = tempDir('agentmate-engine-outside-');
    writeTree(outside, { 'secret.txt': 's' });
    writeTree(h.local, { 'site/a.txt': 'a' });
    symlinkSync(outside, join(h.local, 'site', 'linked'), 'junction');
    symlinkSync(outside, join(h.local, 'top'), 'junction');
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site'), join(h.local, 'top')],
      remoteDir: '/srv/www',
    });
    await h.done(batchId);
    expect(h.server.list('/srv/www')).toEqual(['site']);
    expect(h.server.list('/srv/www/site')).toEqual(['a.txt']);
    expect(h.batch(batchId).skippedItems).toBe(2);
  });

  it('fails the batch with tooManyFiles past the cap', async () => {
    const fits = setup({ maxItems: 4 });
    writeTree(fits.local, { 'site/1.txt': '1', 'site/2.txt': '2', 'site/3.txt': '3' });
    const whole = fits.engine.enqueueUpload({
      localPaths: [join(fits.local, 'site')],
      remoteDir: '/srv/www',
    });
    expect(await fits.done(whole)).toMatchObject({ ok: true });

    const h = setup({ maxItems: 3 });
    writeTree(h.local, { 'site/1.txt': '1', 'site/2.txt': '2', 'site/3.txt': '3' });
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await h.done(batchId);
    expect(h.batch(batchId).failures).toEqual([
      expect.objectContaining({ relPath: 'site', errorCode: 'tooManyFiles' }),
    ]);
    expect(h.server.callsOf('uploadFile')).toEqual([]);
  });

  it('labels several items and formats large counts', async () => {
    const h = setup();
    writeTree(h.local, { 'a/1.txt': '1', 'b/2.txt': '2' });
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'a'), join(h.local, 'b')],
      remoteDir: '/srv/www',
    });
    expect(h.batch(batchId).label).toBe('2 items');
    await h.done(batchId);
    expect(h.batch(batchId).label).toBe('2 items (2 files)');
  });
});

describe('conflicts', () => {
  it('parks a file that is already there and lets other batches go on', async () => {
    const h = setup();
    h.server.file('/srv/www/a.txt', 'theirs', { mtimeMs: T0 - 60_000 });
    const conflicting = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'mine!')],
      remoteDir: '/srv/www',
    });
    await until(() => h.engine.snapshot().conflict !== null, 'the conflict');
    const other = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'b.txt', 'b')],
      remoteDir: '/srv/www',
    });
    await h.done(other);

    const snapshot = h.engine.snapshot();
    expect(snapshot.conflict).toMatchObject({
      batchId: conflicting,
      itemId: '1',
      direction: 'upload',
      name: 'a.txt',
      relPath: 'a.txt',
      targetDir: '/srv/www',
      source: { size: 5 },
      target: { size: 6, mtimeMs: T0 - 60_000, isDirectory: false },
      renameTo: 'a (1).txt',
      remainingInBatch: 0,
    });
    expect(snapshot.pendingConflicts).toBe(0);
    expect(h.batch(conflicting).state).toBe('waiting');
    expect(h.server.read('/srv/www/a.txt')?.toString()).toBe('theirs');
    // Busy is about work moving; a question waiting for the user is not.
    expect(h.busy[h.busy.length - 1]).toBe(false);
  });

  it('overwrites, skips or keeps both as answered, probing for a free name', async () => {
    const h = setup();
    h.server.file('/srv/www/a.txt', 'old a').file('/srv/www/b.txt', 'old b');
    h.server.file('/srv/www/c.txt', 'old c').file('/srv/www/c (1).txt', 'older c');
    const answer = async (name: string, action: 'overwrite' | 'skip' | 'rename') => {
      const batchId = h.engine.enqueueUpload({
        localPaths: [file(h.local, name, `new ${name}`)],
        remoteDir: '/srv/www',
      });
      await until(() => h.engine.snapshot().conflict?.batchId === batchId, `conflict on ${name}`);
      const conflict = h.engine.snapshot().conflict;
      if (name === 'c.txt') expect(conflict?.renameTo).toBe('c (2).txt');
      h.engine.resolveConflict(conflict?.conflictId ?? '', { action, applyToAll: false });
      return h.done(batchId);
    };
    await answer('a.txt', 'overwrite');
    expect(h.server.read('/srv/www/a.txt')?.toString()).toBe('new a.txt');
    const skipped = await answer('b.txt', 'skip');
    expect(h.server.read('/srv/www/b.txt')?.toString()).toBe('old b');
    expect(h.batch(skipped.batchId)).toMatchObject({ state: 'done', skippedItems: 1 });
    await answer('c.txt', 'rename');
    expect(h.server.read('/srv/www/c (2).txt')?.toString()).toBe('new c.txt');
    expect(h.server.read('/srv/www/c.txt')?.toString()).toBe('old c');
  });

  it('applies to all for the rest of the same batch only, now and later', async () => {
    const h = setup({ concurrency: 1 });
    for (const name of ['1.txt', '2.txt', '3.txt', 'x.txt'])
      h.server.file(`/srv/www/site/${name}`, 'old');
    writeTree(h.local, {
      'site/1.txt': 'new',
      'site/2.txt': 'new',
      'site/3.txt': 'new',
      'other/x.txt': 'new',
    });
    const site = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await until(() => h.engine.snapshot().conflict?.relPath === 'site/1.txt', 'the first conflict');
    const other = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'other', 'x.txt')],
      remoteDir: '/srv/www/site',
    });
    await until(() => h.engine.snapshot().pendingConflicts === 1, 'the second conflict');

    const first = h.engine.snapshot().conflict;
    expect(first).toMatchObject({ batchId: site, remainingInBatch: 2 });
    h.engine.resolveConflict(first?.conflictId ?? '', { action: 'overwrite', applyToAll: true });
    await h.done(site);
    for (const name of ['1.txt', '2.txt', '3.txt']) {
      expect(h.server.read(`/srv/www/site/${name}`)?.toString()).toBe('new');
    }
    const next = h.engine.snapshot().conflict;
    expect(next).toMatchObject({ batchId: other, relPath: 'x.txt' });
    h.engine.resolveConflict(next?.conflictId ?? '', { action: 'skip', applyToAll: false });
    await h.done(other);
    expect(h.server.read('/srv/www/site/x.txt')?.toString()).toBe('old');
  });

  it('releases conflicts already parked when the answer applies to all', async () => {
    const h = setup();
    for (const name of ['1.txt', '2.txt', '3.txt']) h.server.file(`/srv/www/site/${name}`, 'old');
    writeTree(h.local, { 'site/1.txt': 'new', 'site/2.txt': 'new', 'site/3.txt': 'new' });
    const site = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await until(() => h.engine.snapshot().pendingConflicts === 2, 'three parked conflicts');
    expect(h.engine.snapshot().conflict?.remainingInBatch).toBe(2);
    h.engine.resolveConflict(h.engine.snapshot().conflict?.conflictId ?? '', {
      action: 'skip',
      applyToAll: true,
    });
    await h.done(site);
    expect(h.batch(site)).toMatchObject({ state: 'done', skippedItems: 3 });
    expect(h.engine.snapshot().conflict).toBeNull();
  });

  it('never asks when the batch came with a policy', async () => {
    for (const policy of ['overwrite', 'skip', 'rename'] as const) {
      const h = setup();
      h.server.file('/srv/www/a.txt', 'old');
      const batchId = h.engine.enqueueUpload({
        localPaths: [file(h.local, 'a.txt', 'new')],
        remoteDir: '/srv/www',
        policy,
      });
      await h.done(batchId);
      expect(h.emitted.every((snapshot) => snapshot.conflict === null)).toBe(true);
      const expected = { overwrite: ['a.txt'], skip: ['a.txt'], rename: ['a (1).txt', 'a.txt'] };
      expect(h.server.list('/srv/www')).toEqual(expected[policy]);
    }
  });

  it('refuses to overwrite a folder with a file', async () => {
    const h = setup();
    h.server.dir('/srv/www/a.txt');
    const batchId = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'new')],
      remoteDir: '/srv/www',
    });
    await until(() => h.engine.snapshot().conflict !== null, 'the conflict');
    const conflict = h.engine.snapshot().conflict;
    expect(conflict?.target.isDirectory).toBe(true);
    const error = caught(() =>
      h.engine.resolveConflict(conflict?.conflictId ?? '', {
        action: 'overwrite',
        applyToAll: false,
      }),
    );
    expect(filesErrorCode(error)).toBe('invalidInput');
    expect(h.engine.snapshot().conflict?.conflictId).toBe(conflict?.conflictId);
    h.engine.resolveConflict(conflict?.conflictId ?? '', { action: 'rename', applyToAll: false });
    await h.done(batchId);
    expect(h.server.read('/srv/www/a (1).txt')?.toString()).toBe('new');

    const forced = setup();
    forced.server.dir('/srv/www/a.txt');
    const policyBatch = forced.engine.enqueueUpload({
      localPaths: [file(forced.local, 'a.txt', 'new')],
      remoteDir: '/srv/www',
      policy: 'overwrite',
    });
    await forced.done(policyBatch);
    expect(forced.batch(policyBatch).failures[0].errorCode).toBe('invalidInput');
  });

  it('clears the conflict when its batch is cancelled', async () => {
    const h = setup();
    h.server.file('/srv/www/a.txt', 'old');
    const batchId = h.engine.enqueueUpload({
      localPaths: [file(h.local, 'a.txt', 'new')],
      remoteDir: '/srv/www',
    });
    await until(() => h.engine.snapshot().conflict !== null, 'the conflict');
    const conflictId = h.engine.snapshot().conflict?.conflictId ?? '';
    h.engine.cancel({ batchId });
    expect(h.engine.snapshot().conflict).toBeNull();
    expect(h.batch(batchId).state).toBe('cancelled');
    expect(
      filesErrorCode(
        caught(() => h.engine.resolveConflict(conflictId, { action: 'skip', applyToAll: false })),
      ),
    ).toBe('invalidInput');
  });

  it('keeps the conflict in the snapshot for a page that comes back', async () => {
    const h = setup();
    h.server.file('/srv/www/a.txt', 'old');
    h.engine.enqueueUpload({ localPaths: [file(h.local, 'a.txt', 'new')], remoteDir: '/srv/www' });
    await until(() => h.engine.snapshot().conflict !== null, 'the conflict');
    await vi.advanceTimersByTimeAsync(100);
    const last = h.emitted[h.emitted.length - 1];
    expect(last.conflict).not.toBeNull();
    expect(h.engine.snapshot().conflict).toEqual(last.conflict);
  });

  it('asks the same way for downloads', async () => {
    const h = setup();
    h.server.file('/srv/www/a.txt', 'remote');
    writeFileSync(join(h.local, 'a.txt'), 'local');
    const batchId = h.engine.enqueueDownload({
      remotePaths: ['/srv/www/a.txt'],
      localDir: h.local,
    });
    await until(() => h.engine.snapshot().conflict !== null, 'the conflict');
    const conflict = h.engine.snapshot().conflict;
    expect(conflict).toMatchObject({
      direction: 'download',
      targetDir: h.local,
      renameTo: 'a (1).txt',
      target: { size: 5, isDirectory: false },
      source: { size: 6 },
    });
    h.engine.resolveConflict(conflict?.conflictId ?? '', { action: 'rename', applyToAll: false });
    await h.done(batchId);
    expect(readFileSync(join(h.local, 'a.txt'), 'utf-8')).toBe('local');
    expect(readFileSync(join(h.local, 'a (1).txt'), 'utf-8')).toBe('remote');
  });

  it('keeps both under a name free without regard to case on Windows', async () => {
    const h = setup({ platform: 'win32' });
    h.server.file('/srv/www/a.txt', 'remote');
    writeFileSync(join(h.local, 'a.txt'), 'local');
    writeFileSync(join(h.local, 'A (1).txt'), 'older');
    const batchId = h.engine.enqueueDownload({
      remotePaths: ['/srv/www/a.txt'],
      localDir: h.local,
      policy: 'rename',
    });
    await h.done(batchId);
    expect(readFileSync(join(h.local, 'a (2).txt'), 'utf-8')).toBe('remote');
  });

  it('overwrites a local file when told to', async () => {
    const h = setup();
    h.server.file('/srv/www/a.txt', 'remote');
    writeFileSync(join(h.local, 'a.txt'), 'local');
    const batchId = h.engine.enqueueDownload({
      remotePaths: ['/srv/www/a.txt'],
      localDir: h.local,
      policy: 'overwrite',
    });
    await h.done(batchId);
    expect(readFileSync(join(h.local, 'a.txt'), 'utf-8')).toBe('remote');
  });

  it('refuses an unknown conflict', () => {
    const h = setup();
    expect(
      filesErrorCode(
        caught(() => h.engine.resolveConflict('nope', { action: 'skip', applyToAll: false })),
      ),
    ).toBe('invalidInput');
  });
});

describe('delete and chmod', () => {
  it('deletes for good, links unlinked and never followed', async () => {
    const h = setup();
    h.server
      .file('/srv/www/site/a.txt', 'a')
      .file('/srv/www/b.txt', 'b')
      .file('/etc/passwd', 'root')
      .link('/srv/www/linkdir', '/etc');
    const batchId = h.engine.enqueueDelete(['/srv/www/site', '/srv/www/b.txt', '/srv/www/linkdir']);
    expect(h.batch(batchId)).toMatchObject({
      kind: 'delete',
      label: 'Delete 3 items',
      target: null,
    });
    const event = await h.done(batchId);
    expect(event).toMatchObject({ kind: 'delete', side: 'remote', target: '/srv/www', ok: true });
    expect(h.server.list('/srv/www')).toEqual([]);
    expect(h.server.read('/etc/passwd')?.toString()).toBe('root');
    expect(h.batch(batchId)).toMatchObject({ totalItems: 3, doneItems: 3, totalBytes: 0 });
  });

  it('reports what could not be deleted', async () => {
    const h = setup();
    h.server.file('/srv/www/site/a.txt', 'a').file('/srv/www/site/b.txt', 'b');
    h.server.failNext('sftpUnlink', '/srv/www/site/a.txt', SFTP_STATUS.permissionDenied);
    const batchId = h.engine.enqueueDelete(['/srv/www/site']);
    expect(h.batch(batchId).label).toBe('Delete site');
    expect(await h.done(batchId)).toMatchObject({ ok: false, failed: 1 });
    expect(h.batch(batchId).failures[0]).toMatchObject({
      relPath: 'site',
      errorCode: 'permissionDenied',
    });
  });

  it('names no refresh folder when the paths are in different folders', async () => {
    const h = setup();
    h.server.file('/srv/a/x', 'x').file('/srv/b/y', 'y');
    expect(await h.done(h.engine.enqueueDelete(['/srv/a/x', '/srv/b/y']))).toMatchObject({
      target: null,
    });
  });

  it('changes permissions, recursively when asked, skipping links', async () => {
    const h = setup();
    h.server
      .file('/srv/www/site/a.txt', 'a')
      .file('/srv/www/site/sub/b.txt', 'b')
      .file('/etc/passwd', 'root', { mode: 0o644 })
      .link('/srv/www/site/etc', '/etc')
      .link('/srv/www/pw', '/etc/passwd')
      .file('/srv/www/one.txt', '1');
    const batchId = h.engine.enqueueChmod({
      paths: ['/srv/www/site', '/srv/www/pw', '/srv/www/one.txt'],
      mode: 0o700,
      recursive: 'all',
    });
    expect(h.batch(batchId)).toMatchObject({ kind: 'chmod', label: 'Permissions for 3 items' });
    const event = await h.done(batchId);
    expect(event).toMatchObject({ kind: 'chmod', side: 'remote', target: '/srv/www', ok: true });
    expect(h.server.modeOf('/srv/www/site/sub/b.txt')).toBe(0o700);
    expect(h.server.modeOf('/srv/www/one.txt')).toBe(0o700);
    expect(h.server.modeOf('/etc/passwd')).toBe(0o644);
    expect(h.server.modeOf('/etc')).toBe(0o755);
    expect(h.batch(batchId)).toMatchObject({ doneItems: 2, skippedItems: 1, state: 'done' });

    const flat = h.engine.enqueueChmod({
      paths: ['/srv/www/site'],
      mode: 0o750,
      recursive: 'none',
    });
    expect(h.batch(flat).label).toBe('Permissions for site');
    await h.done(flat);
    expect(h.server.modeOf('/srv/www/site')).toBe(0o750);
    expect(h.server.modeOf('/srv/www/site/a.txt')).toBe(0o700);
  });

  it('reports a chmod that fails', async () => {
    const h = setup();
    h.server.file('/srv/www/a.txt', 'a');
    h.server.failNext('sftpChmod', SFTP_STATUS.permissionDenied);
    const batchId = h.engine.enqueueChmod({
      paths: ['/srv/www/a.txt'],
      mode: 0o600,
      recursive: 'none',
    });
    await h.done(batchId);
    expect(h.batch(batchId).failures[0].errorCode).toBe('permissionDenied');
  });
});

describe('dispose', () => {
  it('stops everything, waits for it to settle, and gives the connection back', async () => {
    const h = setup();
    writeTree(h.local, {
      'site/1.txt': '1',
      'site/2.txt': '2',
      'site/3.txt': '3',
      'site/4.txt': '4',
    });
    const gate = h.server.gate('uploadFile');
    h.engine.enqueueUpload({ localPaths: [join(h.local, 'site')], remoteDir: '/srv/www' });
    await gate.waitFor(3);
    const emittedBefore = h.emitted.length;
    await h.engine.dispose();
    gate.open();
    expect(h.server.pool.released).toBe(1);
    expect(h.busy[h.busy.length - 1]).toBe(false);
    expect(h.server.list('/srv/www/site')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.emitted).toHaveLength(emittedBefore);
    expect(h.finished).toEqual([]);
    expect(
      filesErrorCode(
        caught(() => h.engine.enqueueUpload({ localPaths: [h.local], remoteDir: '/srv/www' })),
      ),
    ).toBe('invalidInput');
  });
});

describe('names that meet at the target', () => {
  for (const [first, second] of [
    ['a:b', 'a_b'],
    ['README', 'Readme'],
  ]) {
    it(`asks before ${second} replaces ${first} when both land on one local name`, async () => {
      const h = setup({ platform: 'win32' });
      h.server.file(`/srv/site/${first}`, 'first').file(`/srv/site/${second}`, 'second');
      const batchId = h.engine.enqueueDownload({ remotePaths: ['/srv/site'], localDir: h.local });
      await until(
        () => h.engine.snapshot().conflict !== null || h.finished.length > 0,
        'a conflict or the end',
      );
      const conflict = h.engine.snapshot().conflict;
      expect(conflict).toMatchObject({ batchId, direction: 'download' });
      h.engine.resolveConflict(conflict?.conflictId ?? '', { action: 'rename', applyToAll: false });
      await h.done(batchId);
      const names = readdirSync(join(h.local, 'site')).sort();
      expect(names).toHaveLength(2);
      const contents = names.map((name) => readFileSync(join(h.local, 'site', name), 'utf-8'));
      expect(contents.sort()).toEqual(['first', 'second']);
    });
  }

  it('keeps both under names that do not meet, without asking', async () => {
    const h = setup({ platform: 'win32' });
    h.server.file('/srv/site/a:b', 'first').file('/srv/site/a_b', 'second');
    const batchId = h.engine.enqueueDownload({
      remotePaths: ['/srv/site'],
      localDir: h.local,
      policy: 'rename',
    });
    await h.done(batchId);
    const names = readdirSync(join(h.local, 'site')).sort();
    expect(names).toEqual(['a_b', 'a_b (1)']);
    expect(h.emitted.every((snapshot) => snapshot.conflict === null)).toBe(true);
  });

  it('asks before a second upload of the same name in one batch', async () => {
    const h = setup();
    writeTree(h.local, { 'one/x.txt': 'one', 'two/x.txt': 'two' });
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'one', 'x.txt'), join(h.local, 'two', 'x.txt')],
      remoteDir: '/srv/www',
    });
    await until(() => h.engine.snapshot().conflict !== null || h.finished.length > 0, 'a conflict');
    const conflict = h.engine.snapshot().conflict;
    expect(conflict).toMatchObject({ name: 'x.txt', renameTo: 'x (1).txt' });
    h.engine.resolveConflict(conflict?.conflictId ?? '', { action: 'rename', applyToAll: false });
    await h.done(batchId);
    expect(h.server.list('/srv/www')).toEqual(['x (1).txt', 'x.txt']);
  });
});

describe('finding free names', () => {
  const listingsOf = (h: Harness, path: string) =>
    h.server.callsOf('sftpListDetailed').filter((listed) => listed === path).length;

  it('lists the target folder once for every Keep both in a batch', async () => {
    const h = setup();
    const files: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) {
      const name = `f${String(index).padStart(2, '0')}.txt`;
      files[`site/${name}`] = 'new';
      h.server.file(`/srv/www/site/${name}`, 'old');
    }
    writeTree(h.local, files);
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
      policy: 'rename',
    });
    await h.done(batchId);
    expect(h.server.list('/srv/www/site')).toHaveLength(40);
    expect(listingsOf(h, '/srv/www/site')).toBe(1);
  });

  it('lists once for the Keep both names of parked conflicts too', async () => {
    const h = setup();
    for (const name of ['1.txt', '2.txt', '3.txt']) h.server.file(`/srv/www/site/${name}`, 'old');
    writeTree(h.local, { 'site/1.txt': 'new', 'site/2.txt': 'new', 'site/3.txt': 'new' });
    h.engine.enqueueUpload({ localPaths: [join(h.local, 'site')], remoteDir: '/srv/www' });
    await until(() => h.engine.snapshot().pendingConflicts === 2, 'three parked conflicts');
    expect(listingsOf(h, '/srv/www/site')).toBe(1);
  });

  it('lists again when a name it remembered as free has been taken since', async () => {
    const h = setup({ concurrency: 1 });
    h.server.file('/srv/www/site/a.txt', 'old').file('/srv/www/site/b.txt', 'old');
    writeTree(h.local, { 'site/a.txt': 'new a', 'site/b.txt': 'new b' });
    const gate = h.server.gate('uploadFile');
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
      policy: 'rename',
    });
    await gate.waitFor(1);
    h.server.file('/srv/www/site/b (1).txt', 'theirs');
    gate.open();
    await h.done(batchId);
    expect(h.server.read('/srv/www/site/b (1).txt')?.toString()).toBe('theirs');
    expect(h.server.read('/srv/www/site/b (2).txt')?.toString()).toBe('new b');
    expect(listingsOf(h, '/srv/www/site')).toBe(2);
  });
});

describe('finished batches', () => {
  it('keeps totals and retry working once a finished batch lets go of its done items', async () => {
    const h = setup();
    writeTree(h.local, { 'site/a.txt': 'a', 'site/css/b.css': 'b', 'site/css/c.css': 'c' });
    h.server.failNext('uploadFile', '/srv/www/site/css/c.css', SFTP_STATUS.permissionDenied);
    const batchId = h.engine.enqueueUpload({
      localPaths: [join(h.local, 'site')],
      remoteDir: '/srv/www',
    });
    await h.done(batchId);
    expect(h.batch(batchId)).toMatchObject({
      label: 'site (3 files)',
      totalItems: 5,
      doneItems: 4,
      failedItems: 1,
      totalBytes: 3,
      transferredBytes: 2,
    });
    const failed = h.batch(batchId).failures[0];
    expect(failed.relPath).toBe('site/css/c.css');
    h.engine.retry({ batchId, itemId: failed.itemId });
    await until(() => h.batch(batchId).state === 'done', 'the retry');
    expect(h.batch(batchId)).toMatchObject({
      totalItems: 5,
      doneItems: 5,
      failedItems: 0,
      totalBytes: 3,
      transferredBytes: 3,
      failures: [],
    });
    expect(h.server.read('/srv/www/site/css/c.css')?.toString()).toBe('c');
  });

  it('builds a snapshot without walking every item of finished batches', async () => {
    vi.useRealTimers();
    const server = new FakeSftpServer();
    server.dir('/srv');
    let finished = 0;
    const engine = createTransferEngine({
      sessionId: 's',
      transferClient: async () => server.connect(),
      releaseTransferClient: () => undefined,
      emit: () => undefined,
      finished: () => {
        finished += 1;
      },
      busy: () => undefined,
      concurrency: 50,
    });
    // Each batch holds a failure at its very end, behind 20,000 done items.
    const paths = Array.from({ length: 20_000 }, (_, index) => `/srv/missing-${index}`);
    paths.push('/');
    for (let batch = 0; batch < 4; batch += 1) engine.enqueueDelete(paths);
    await until(() => finished === 4, 'the deletes');
    const started = performance.now();
    for (let round = 0; round < 20; round += 1) engine.snapshot();
    const each = (performance.now() - started) / 20;
    expect(engine.snapshot().batches.map((view) => view.failures.length)).toEqual([1, 1, 1, 1]);
    expect(each).toBeLessThan(0.5);
    await engine.dispose();
  }, 60_000);
});

describe('error messages', () => {
  it('names the local file when writing a download fails here', async () => {
    const h = setup();
    h.server.file('/srv/www/a.txt', 'a');
    const missing = join(h.local, 'gone');
    const batchId = h.engine.enqueueDownload({
      remotePaths: ['/srv/www/a.txt'],
      localDir: missing,
    });
    await h.done(batchId);
    const failure = h.batch(batchId).failures[0];
    expect(failure.errorCode).toBe('folderMissing');
    expect(failure.error).toContain(join(missing, 'a.txt'));
    expect(failure.error).not.toContain('/srv/www/a.txt');
  });
});

describe('cancelling a root while it is walked', () => {
  it('stops that walk and lets the batch end', async () => {
    const h = setup();
    h.server.file('/srv/site/sub/deep/a.txt', 'a').file('/srv/site/b.txt', 'b');
    const gate = h.server.gate('sftpListDetailed');
    const batchId = h.engine.enqueueDownload({ remotePaths: ['/srv/site'], localDir: h.local });
    await gate.waitFor(1);
    gate.release(1);
    await gate.waitFor(1);
    h.engine.cancel({ batchId, itemId: '1' });
    gate.open();
    await h.done(batchId);
    expect(h.server.callsOf('sftpListDetailed')).not.toContain('/srv/site/sub');
    expect(h.batch(batchId).state).toBe('cancelled');
    await spin();
    expect(h.busy[h.busy.length - 1]).toBe(false);
  });
});
