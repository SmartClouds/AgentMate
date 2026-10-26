import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { IPC } from '../../shared/ipcChannels';
import type {
  SftpBatchFinished,
  SftpQueueSnapshot,
  SftpSessionClosed,
  SftpSessionInfo,
} from '../../shared/sftpTypes';
import { sshErrorCode } from '../../shared/sshErrors';
import { tempDir } from '../../test/main/fixtures';
import { HostKeyChangedError } from '../ssh/connectConfig';
import { VaultLockedError } from '../ssh/vaultErrors';
import { LocalBrowseRegistry } from './localBrowse';
import {
  SFTP_BROWSE_IDLE_MS,
  type SftpServerInfo,
  SftpService,
  type SftpServiceDeps,
  toRemoteEntry,
} from './service';
import { FakeSftpServer, SFTP_STATUS } from './testing/fakeSftpClient';

/**
 * The SFTP sessions behind the file manager (E25): one per window and saved server, browsing on
 * the shared connection (healed when it drops, handed back when idle), transfers on an engine of
 * their own, and every call refused unless it comes from a window that owns the session (the one
 * that opened it, or a pop-out let in with `addOwner`).
 *
 * Timers and Date are faked; the fake server answers on microtasks and local files are real, so
 * `until` spins the real event loop.
 */

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const OWNER = 1;
const OTHER = 2;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: T0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function until(
  check: () => boolean | Promise<boolean>,
  what = 'the condition',
): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function failure(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

function failureOf(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

interface Sent {
  ownerId: number;
  channel: string;
  payload: unknown;
}

const SERVERS: Record<string, SftpServerInfo> = {
  'srv-1': { nickname: 'web', host: 'web.example.com', port: 2222, username: 'deploy' },
  'srv-2': { nickname: 'db', host: 'db.example.com', port: 22, username: 'root' },
};

function setup(overrides: Partial<SftpServiceDeps> = {}) {
  const server = new FakeSftpServer({ home: '/home/deploy' });
  server
    .dir('/srv/site/assets')
    .file('/srv/site/index.html', '<h1>hi</h1>', { owner: 'www', group: 'www-data' })
    .link('/srv/site/current', '/srv/site/assets')
    .link('/srv/site/gone', '/srv/nowhere');
  const sent: Sent[] = [];
  const awake: boolean[] = [];
  const localBrowse = new LocalBrowseRegistry();
  const temp = tempDir('runova-sftp-service-');
  const service = new SftpService({
    pool: server.pool,
    findServer: async (serverId) => SERVERS[serverId] ?? null,
    send: (ownerId, channel, payload) => sent.push({ ownerId, channel, payload }),
    keepAwake: (busy) => awake.push(busy),
    tempDir: () => join(temp, 'edits'),
    localBrowse,
    engine: { platform: 'linux' },
    ...overrides,
  });
  const sentOn = <T>(channel: string, ownerId = OWNER): T[] =>
    sent
      .filter((one) => one.channel === channel && one.ownerId === ownerId)
      .map((one) => one.payload as T);
  const finished = (batchId: string, ownerId = OWNER) =>
    sentOn<SftpBatchFinished>(IPC.sftp.onBatchFinished, ownerId).find(
      (event) => event.batchId === batchId,
    );
  const done = async (batchId: string, ownerId = OWNER): Promise<SftpBatchFinished> => {
    await until(() => finished(batchId, ownerId) !== undefined, `batch ${batchId}`);
    return finished(batchId, ownerId) as SftpBatchFinished;
  };
  return { server, service, sent, sentOn, awake, localBrowse, local: temp, done };
}

describe('toRemoteEntry', () => {
  const base = {
    name: 'x',
    size: 10,
    mtimeMs: 1000,
    mode: 0o644,
    isDirectory: false,
    isFile: false,
    isSymlink: false,
    brokenLink: false,
    longname: 'garbage',
  };

  it('calls a socket or device "other" and leaves an unreadable owner null', () => {
    expect(toRemoteEntry('/dev', base)).toEqual({
      name: 'x',
      path: '/dev/x',
      kind: 'other',
      isDirectory: false,
      isSymlink: false,
      size: 10,
      mtimeMs: 1000,
      mode: 0o644,
      owner: null,
      group: null,
    });
  });

  it('gives folders a size of 0', () => {
    expect(toRemoteEntry('/', { ...base, isDirectory: true, size: 4096 })).toMatchObject({
      path: '/x',
      kind: 'dir',
      size: 0,
    });
  });
});

describe('open', () => {
  it('logs in once and reads the home folder with realpath(".")', async () => {
    const h = setup();

    const info = await h.service.open(OWNER, 'srv-1');

    expect(info).toEqual({
      sessionId: expect.stringMatching(/^[A-Za-z0-9-]{1,64}$/),
      serverId: 'srv-1',
      nickname: 'web',
      host: 'web.example.com',
      port: 2222,
      username: 'deploy',
      home: '/home/deploy',
      kind: 'ssh',
    });
    expect(h.server.pool.acquired).toBe(1);
    expect(h.server.callsOf('sftpRealpath')).toEqual(['.']);
  });

  it('gives the same window the session it already has for that server', async () => {
    const h = setup();

    const [first, second] = await Promise.all([
      h.service.open(OWNER, 'srv-1'),
      h.service.open(OWNER, 'srv-1'),
    ]);
    const third = await h.service.open(OWNER, 'srv-1');

    expect(second.sessionId).toBe(first.sessionId);
    expect(third.sessionId).toBe(first.sessionId);
    expect(h.server.pool.acquired).toBe(1);
  });

  it('gives another window a session of its own', async () => {
    const h = setup();

    const mine = await h.service.open(OWNER, 'srv-1');
    const theirs = await h.service.open(OTHER, 'srv-1');

    expect(theirs.sessionId).not.toBe(mine.sessionId);
  });

  it('answers an unknown server with siteUnknown, without logging in', async () => {
    const h = setup();

    const error = await failure(h.service.open(OWNER, 'srv-gone'));

    expect(filesErrorCode(error)).toBe('siteUnknown');
    expect(h.server.pool.acquired).toBe(0);
  });

  it('does not keep a session for a server removed while it logged in', async () => {
    let lookups = 0;
    const h = setup({
      findServer: async (serverId) => {
        lookups += 1;
        return lookups === 1 ? SERVERS[serverId] : null;
      },
    });

    const error = await failure(h.service.open(OWNER, 'srv-1'));

    expect(filesErrorCode(error)).toBe('siteUnknown');
    expect(lookups).toBe(2);
    expect(h.server.pool.outstanding).toBe(0);
  });

  it('codes a locked vault as [ssh:vault-locked]', async () => {
    const h = setup();
    h.server.failNext('acquire', new VaultLockedError());

    const error = await failure(h.service.open(OWNER, 'srv-1'));

    expect(sshErrorCode(error)).toBe('vault-locked');
  });

  it('keeps a changed host key tagged for the trust prompt', async () => {
    const h = setup();
    h.server.failNext(
      'acquire',
      new HostKeyChangedError('web.example.com', 2222, { stored: 'aa', presented: 'bb' }),
    );

    const error = await failure(h.service.open(OWNER, 'srv-1'));

    expect(sshErrorCode(error)).toBe('host-key-changed');
  });

  it('codes a login that cannot reach the server', async () => {
    const h = setup();
    h.server.failNext(
      'acquire',
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );

    const error = await failure(h.service.open(OWNER, 'srv-1'));

    expect(filesErrorCode(error)).toBe('unreachable');
  });

  it('hands the connection back when the home folder cannot be read', async () => {
    const h = setup();
    h.server.failNext('sftpRealpath', SFTP_STATUS.permissionDenied);

    const error = await failure(h.service.open(OWNER, 'srv-1'));

    expect(filesErrorCode(error)).toBe('permissionDenied');
    expect(h.server.pool.outstanding).toBe(0);
    // A later try starts over rather than reusing a half-made session.
    await expect(h.service.open(OWNER, 'srv-1')).resolves.toMatchObject({ home: '/home/deploy' });
  });
});

describe('list', () => {
  it('resolves ~ and maps the entries', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.file('/home/deploy/notes.txt', 'abc');

    const listing = await h.service.list(OWNER, sessionId, '~');

    expect(listing.path).toBe('/home/deploy');
    expect(listing.parent).toBe('/home');
    expect(listing.entries).toEqual([
      {
        name: 'notes.txt',
        path: '/home/deploy/notes.txt',
        kind: 'file',
        isDirectory: false,
        isSymlink: false,
        size: 3,
        mtimeMs: Math.floor(T0 / 1000) * 1000,
        mode: 0o644,
        owner: 'deploy',
        group: 'deploy',
      },
    ]);
  });

  it('marks folders, links to folders and broken links', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    const listing = await h.service.list(OWNER, sessionId, '/srv/site');
    const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]));

    expect(byName.assets).toMatchObject({ kind: 'dir', isDirectory: true, size: 0 });
    expect(byName.current).toMatchObject({ kind: 'dir', isDirectory: true, isSymlink: true });
    expect(byName.gone).toMatchObject({ kind: 'link', isDirectory: false, isSymlink: true });
    expect(byName['index.html']).toMatchObject({
      kind: 'file',
      path: '/srv/site/index.html',
      owner: 'www',
      group: 'www-data',
    });
  });

  it('takes relative paths and .. from home, and has no parent at /', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    await expect(h.service.list(OWNER, sessionId, '../..')).resolves.toMatchObject({
      path: '/',
      parent: null,
    });
    await expect(h.service.list(OWNER, sessionId, '~/../../srv/site')).resolves.toMatchObject({
      path: '/srv/site',
    });
  });

  it('says a file is not a folder, and a missing folder is missing', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    const file = await failure(h.service.list(OWNER, sessionId, '/srv/site/index.html'));
    const missing = await failure(h.service.list(OWNER, sessionId, '/srv/nope'));

    expect(filesErrorCode(file)).toBe('invalidInput');
    expect(filesErrorCode(missing)).toBe('remoteFolderMissing');
  });

  it('refuses a NUL byte', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    const error = await failure(h.service.list(OWNER, sessionId, 'a\0b'));

    expect(filesErrorCode(error)).toBe('invalidInput');
  });
});

describe('the browse connection', () => {
  it('logs in again when the shared connection has closed', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.dropConnection();

    const listing = await h.service.list(OWNER, sessionId, '/srv/site');

    expect(listing.entries.length).toBeGreaterThan(0);
    expect(h.server.pool.acquired).toBe(2);
    expect(h.server.pool.outstanding).toBe(1);
  });

  it('tries once more when a call fails because the connection closed', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.failNext('sftpListDetailed', new Error('The SSH connection to fake.example closed.'));

    const listing = await h.service.list(OWNER, sessionId, '/srv/site');

    expect(listing.path).toBe('/srv/site');
    expect(h.server.callsOf('sftpListDetailed')).toHaveLength(2);
    expect(h.server.pool.outstanding).toBe(1);
  });

  it('gives up after the second closed connection in a row', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.failNext('sftpListDetailed', new Error('The SSH connection to fake.example closed.'));
    h.server.failNext('sftpListDetailed', new Error('The SSH connection to fake.example closed.'));

    const error = await failure(h.service.list(OWNER, sessionId, '/srv/site'));

    expect(filesErrorCode(error)).toBe('unreachable');
    expect(h.server.callsOf('sftpListDetailed')).toHaveLength(2);
  });

  it('does not retry a plain refusal', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.failNext('sftpListDetailed', SFTP_STATUS.permissionDenied);

    const error = await failure(h.service.list(OWNER, sessionId, '/srv/site'));

    expect(filesErrorCode(error)).toBe('permissionDenied');
    expect(h.server.callsOf('sftpListDetailed')).toHaveLength(1);
  });

  it('codes a locked vault met while logging in again', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.dropConnection();
    h.server.failNext('acquire', new VaultLockedError());

    const error = await failure(h.service.list(OWNER, sessionId, '/srv/site'));

    expect(sshErrorCode(error)).toBe('vault-locked');
  });

  it('is handed back after the idle time and taken again on the next call', async () => {
    const h = setup({ idleMs: 60_000 });
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    await h.service.list(OWNER, sessionId, '~');

    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.server.pool.outstanding).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.server.pool.outstanding).toBe(0);

    await h.service.list(OWNER, sessionId, '~');
    expect(h.server.pool.acquired).toBe(2);
    expect(h.server.pool.outstanding).toBe(1);
  });

  it('waits ten minutes by default', async () => {
    const h = setup();
    await h.service.open(OWNER, 'srv-1');

    await vi.advanceTimersByTimeAsync(SFTP_BROWSE_IDLE_MS - 1);
    expect(h.server.pool.outstanding).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.server.pool.outstanding).toBe(0);
  });

  it('is kept while transfers are still going', async () => {
    const h = setup({ idleMs: 1_000 });
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    const gate = h.server.gate('sftpUnlink');
    const { batchId } = await h.service.remove(OWNER, sessionId, ['/srv/site/index.html']);
    await gate.waitFor();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.server.pool.released).toBe(0);

    gate.open();
    await h.done(batchId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.server.pool.released).toBeGreaterThanOrEqual(1);
    // The browse lease is gone; the session is not.
    await expect(h.service.queue(OWNER, sessionId)).resolves.toMatchObject({ sessionId });
  });
});

describe('owners', () => {
  it("refuses another window's session", async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    for (const work of [
      h.service.list(OTHER, sessionId, '~'),
      h.service.queue(OTHER, sessionId),
      h.service.close(OTHER, sessionId),
      h.service.list(OWNER, 'no-such-session', '~'),
    ]) {
      const error = await failure(work);
      expect(filesErrorCode(error)).toBe('invalidInput');
      expect(error.message).toContain('Unknown session');
    }
    // The other window's attempt to close it did nothing.
    await expect(h.service.list(OWNER, sessionId, '~')).resolves.toBeTruthy();
  });

  it('close hands the connection back and forgets the session, quietly', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    await h.service.close(OWNER, sessionId);

    expect(h.server.pool.outstanding).toBe(0);
    expect(filesErrorCode(await failure(h.service.list(OWNER, sessionId, '~')))).toBe(
      'invalidInput',
    );
    expect(h.sentOn(IPC.sftp.onSessionClosed)).toEqual([]);
    // Closing again, or a session that is already gone, is fine.
    await expect(h.service.close(OWNER, sessionId)).resolves.toBeUndefined();
    // And the same window can open the server again.
    const again = await h.service.open(OWNER, 'srv-1');
    expect(again.sessionId).not.toBe(sessionId);
  });

  it('close stops the transfers and their connection', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    const gate = h.server.gate('sftpUnlink');
    await h.service.remove(OWNER, sessionId, ['/srv/site/index.html']);
    await gate.waitFor();

    const closing = h.service.close(OWNER, sessionId);
    gate.open();
    await closing;

    expect(h.server.pool.outstanding).toBe(0);
    expect(h.awake.at(-1)).toBe(false);
    expect(h.service.runningTransfers()).toBe(0);
  });

  it('closeServer tells every window why, and closes only that server', async () => {
    const h = setup();
    const mine = await h.service.open(OWNER, 'srv-1');
    const theirs = await h.service.open(OTHER, 'srv-1');
    const other = await h.service.open(OWNER, 'srv-2');

    await h.service.closeServer('srv-1', 'removed');

    expect(h.sentOn<SftpSessionClosed>(IPC.sftp.onSessionClosed)).toEqual([
      { sessionId: mine.sessionId, serverId: 'srv-1', reason: 'removed' },
    ]);
    expect(h.sentOn<SftpSessionClosed>(IPC.sftp.onSessionClosed, OTHER)).toEqual([
      { sessionId: theirs.sessionId, serverId: 'srv-1', reason: 'removed' },
    ]);
    expect(filesErrorCode(await failure(h.service.queue(OWNER, mine.sessionId)))).toBe(
      'invalidInput',
    );
    await expect(h.service.queue(OWNER, other.sessionId)).resolves.toBeTruthy();
    expect(h.server.pool.outstanding).toBe(1);
  });

  it('closeAll closes every session with reason quit', async () => {
    const h = setup();
    await h.service.open(OWNER, 'srv-1');
    await h.service.open(OTHER, 'srv-2');

    await h.service.closeAll();

    const reasons = h.sent
      .filter((one) => one.channel === IPC.sftp.onSessionClosed)
      .map((one) => (one.payload as SftpSessionClosed).reason);
    expect(reasons).toEqual(['quit', 'quit']);
    expect(h.server.pool.outstanding).toBe(0);
  });

  it("dropOwner closes only that window's sessions and sends nothing", async () => {
    const h = setup();
    const mine = await h.service.open(OWNER, 'srv-1');
    const theirs = await h.service.open(OTHER, 'srv-1');

    await h.service.dropOwner(OWNER);

    expect(filesErrorCode(await failure(h.service.queue(OWNER, mine.sessionId)))).toBe(
      'invalidInput',
    );
    await expect(h.service.queue(OTHER, theirs.sessionId)).resolves.toBeTruthy();
    expect(h.sent.filter((one) => one.channel === IPC.sftp.onSessionClosed)).toEqual([]);
  });

  it('a session closed while it logs in is not kept', async () => {
    const h = setup();
    const gate = h.server.gate('acquire');
    const opening = h.service.open(OWNER, 'srv-1');
    await gate.waitFor();

    await h.service.dropOwner(OWNER);
    gate.open();
    const error = await failure(opening);

    expect(filesErrorCode(error)).toBe('invalidInput');
    expect(h.server.pool.outstanding).toBe(0);
  });
  it('a window gone during the last look at the server leaves no session', async () => {
    let looks = 0;
    let carryOn: () => void = () => undefined;
    const h = setup({
      findServer: async (serverId) => {
        looks += 1;
        if (looks === 2) await new Promise<void>((resolve) => (carryOn = resolve));
        return SERVERS[serverId] ?? null;
      },
    });
    const opening = h.service.open(OWNER, 'srv-1');
    await until(() => looks === 2, 'the second look');

    await h.service.dropOwner(OWNER);
    carryOn();

    expect(filesErrorCode(await failure(opening))).toBe('invalidInput');
    expect(h.server.pool.outstanding).toBe(0);
    expect(h.service.runningTransfers()).toBe(0);
    // The next open logs in afresh rather than finding a session left behind.
    expect((await h.service.open(OWNER, 'srv-1')).sessionId).toBeTruthy();
    expect(h.server.pool.acquired).toBe(2);
  });

  it('a server removed while a session opens on it leaves no session', async () => {
    const h = setup();
    const gate = h.server.gate('acquire');
    const opening = h.service.open(OWNER, 'srv-1');
    await gate.waitFor();

    await h.service.closeServer('srv-1', 'removed');
    gate.open();

    expect(filesErrorCode(await failure(opening))).toBe('invalidInput');
    expect(h.server.pool.outstanding).toBe(0);
  });

  it('a session closed while it logs in again hands the new connection back', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.dropConnection();
    const gate = h.server.gate('acquire');
    const listing = h.service.list(OWNER, sessionId, '~');
    await gate.waitFor();

    await h.service.close(OWNER, sessionId);
    gate.open();

    expect(filesErrorCode(await failure(listing))).toBe('invalidInput');
    expect(h.server.pool.outstanding).toBe(0);
  });
});

describe('many owners', () => {
  /** The pop-out window of a session (F2): another owner of the same session. */
  const POPOUT = 3;

  it('lets a second window into the session, where open answers that same session', async () => {
    const h = setup();
    const info = await h.service.open(OWNER, 'srv-1');

    h.service.addOwner(info.sessionId, POPOUT);

    await expect(h.service.list(POPOUT, info.sessionId, '~')).resolves.toBeTruthy();
    expect(h.service.info(POPOUT, info.sessionId)).toEqual(info);
    await expect(h.service.open(POPOUT, 'srv-1')).resolves.toEqual(info);
    // A window that was never let in still gets a session of its own.
    expect((await h.service.open(OTHER, 'srv-1')).sessionId).not.toBe(info.sessionId);
    expect(filesErrorCode(failureOf(() => h.service.info(OTHER, info.sessionId)))).toBe(
      'invalidInput',
    );
  });

  it('refuses to add a window to a session that is not there', () => {
    const h = setup();

    const error = failureOf(() => h.service.addOwner('no-such-session', POPOUT));

    expect(filesErrorCode(error)).toBe('invalidInput');
    expect(error.message).toContain('Unknown session');
  });

  it('sends the queue and the finished event to every owner', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.service.addOwner(sessionId, POPOUT);
    await h.service.open(OTHER, 'srv-1');
    const source = join(h.local, 'app.css');
    writeFileSync(source, 'body{}');

    const { batchId } = await h.service.upload(POPOUT, sessionId, {
      localPaths: [source],
      remoteDir: '/srv/site',
    });
    await h.done(batchId, OWNER);
    await h.done(batchId, POPOUT);
    await vi.advanceTimersByTimeAsync(200);

    expect(h.sentOn(IPC.sftp.onQueue, OWNER).length).toBeGreaterThan(0);
    expect(h.sentOn(IPC.sftp.onQueue, POPOUT)).toEqual(h.sentOn(IPC.sftp.onQueue, OWNER));
    expect(h.sent.filter((one) => one.ownerId === OTHER)).toEqual([]);
  });

  it('keeps the session while any owner is left, and ends it with the last', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.service.addOwner(sessionId, POPOUT);

    await h.service.dropOwner(OWNER);

    expect(filesErrorCode(await failure(h.service.queue(OWNER, sessionId)))).toBe('invalidInput');
    await expect(h.service.queue(POPOUT, sessionId)).resolves.toBeTruthy();
    expect(h.server.pool.outstanding).toBe(1);

    await h.service.removeOwner(sessionId, POPOUT);

    expect(h.server.pool.outstanding).toBe(0);
    expect(filesErrorCode(await failure(h.service.queue(POPOUT, sessionId)))).toBe('invalidInput');
    expect(h.sent.filter((one) => one.channel === IPC.sftp.onSessionClosed)).toEqual([]);
  });

  it('removeOwner leaves the others alone, and a session already gone is fine', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.service.addOwner(sessionId, POPOUT);

    await h.service.removeOwner(sessionId, POPOUT);
    // A window that was never an owner changes nothing.
    await h.service.removeOwner(sessionId, OTHER);

    await expect(h.service.queue(OWNER, sessionId)).resolves.toBeTruthy();
    expect(filesErrorCode(await failure(h.service.queue(POPOUT, sessionId)))).toBe('invalidInput');
    // At quit the sessions go first and the windows' closed events come after.
    await h.service.closeAll();
    await expect(h.service.removeOwner(sessionId, OWNER)).resolves.toBeUndefined();
    await expect(h.service.removeOwner('no-such-session', OWNER)).resolves.toBeUndefined();
  });

  it('a disconnect from one owner ends the session for all and tells the others', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.service.addOwner(sessionId, POPOUT);

    await h.service.close(POPOUT, sessionId);

    const closed: SftpSessionClosed = { sessionId, serverId: 'srv-1', reason: 'disconnected' };
    expect(h.sentOn<SftpSessionClosed>(IPC.sftp.onSessionClosed, OWNER)).toEqual([closed]);
    expect(h.sentOn(IPC.sftp.onSessionClosed, POPOUT)).toEqual([]);
    expect(h.server.pool.outstanding).toBe(0);
    expect(filesErrorCode(await failure(h.service.queue(OWNER, sessionId)))).toBe('invalidInput');
  });

  it('tells every owner when the server is removed', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.service.addOwner(sessionId, POPOUT);

    await h.service.closeServer('srv-1', 'removed');

    const removed: SftpSessionClosed = { sessionId, serverId: 'srv-1', reason: 'removed' };
    expect(h.sentOn(IPC.sftp.onSessionClosed, OWNER)).toEqual([removed]);
    expect(h.sentOn(IPC.sftp.onSessionClosed, POPOUT)).toEqual([removed]);
  });

  it('hands the sessions of a window that goes to another, transfers still running', async () => {
    const h = setup();
    // The main window disconnected, and the pop-out connected again on its own.
    const own = await h.service.open(POPOUT, 'srv-1');
    const gate = h.server.gate('sftpUnlink');
    const { batchId } = await h.service.remove(POPOUT, own.sessionId, ['/srv/site/index.html']);
    await gate.waitFor();

    h.service.adoptSessions(POPOUT, OWNER);
    await h.service.dropOwner(POPOUT);
    gate.open();

    // The main window's page is told, so it shows the session and its queue.
    expect(h.sentOn<SftpSessionInfo>(IPC.sftp.onSessionAdopted, OWNER)).toEqual([own]);
    await expect(h.service.open(OWNER, 'srv-1')).resolves.toEqual(own);
    expect((await h.done(batchId, OWNER)).ok).toBe(true);
    expect(h.server.pool.outstanding).toBeGreaterThan(0);
  });

  it('joins a session a linked window has on the server instead of opening another', async () => {
    const h = setup();
    const shown = await h.service.open(OWNER, 'srv-1');
    await h.service.open(OWNER, 'srv-2');
    const peers = [OWNER, POPOUT];

    await expect(h.service.open(POPOUT, 'srv-1', { peers })).resolves.toEqual(shown);
    // A server no linked window has a session on gets one of its own.
    const fresh = await h.service.open(POPOUT, 'srv-2', { peers: [POPOUT] });
    // A window that is not linked is not joined to anything.
    const apart = await h.service.open(OTHER, 'srv-1');

    expect(apart.sessionId).not.toBe(shown.sessionId);
    expect(fresh.sessionId).toBeTruthy();
    expect(h.server.pool.acquired).toBe(4);
    await h.service.dropOwner(OWNER);
    await expect(h.service.queue(POPOUT, shown.sessionId)).resolves.toBeTruthy();
  });

  it('keeps one session per server across a disconnect in one window and a reconnect in each', async () => {
    const h = setup();
    const peers = [OWNER, POPOUT];
    // S1 is popped out, then disconnected from the pop-out: the main window goes idle.
    const s1 = await h.service.open(OWNER, 'srv-1');
    h.service.addOwner(s1.sessionId, POPOUT);
    await h.service.close(POPOUT, s1.sessionId);
    // The pop-out connects again; no linked window has a session, so it opens S2.
    const s2 = await h.service.open(POPOUT, 'srv-1', { peers });
    expect(s2.sessionId).not.toBe(s1.sessionId);
    const source = join(h.local, 'big.bin');
    writeFileSync(source, 'x'.repeat(1000));
    const gate = h.server.gate('uploadFile');
    const { batchId } = await h.service.upload(POPOUT, s2.sessionId, {
      localPaths: [source],
      remoteDir: '/srv/site',
    });
    await gate.waitFor();

    // The main window connects again and joins S2 rather than opening S3.
    await expect(h.service.open(OWNER, 'srv-1', { peers })).resolves.toEqual(s2);
    expect((await h.service.queue(OWNER, s2.sessionId)).batches).toHaveLength(1);

    // Closing the pop-out keeps the upload, and the main window already shows it.
    h.service.adoptSessions(POPOUT, OWNER);
    await h.service.dropOwner(POPOUT);
    gate.open();

    expect((await h.done(batchId, OWNER)).ok).toBe(true);
    expect(h.sentOn(IPC.sftp.onSessionAdopted, OWNER)).toEqual([]);
    expect(h.server.read('/srv/site/big.bin')?.length).toBe(1000);
  });

  it('leaves an idle session to end when the other window has its own on that server', async () => {
    const h = setup();
    const mine = await h.service.open(OWNER, 'srv-1');
    const theirs = await h.service.open(POPOUT, 'srv-1');
    const shared = await h.service.open(OWNER, 'srv-2');
    h.service.addOwner(shared.sessionId, POPOUT);
    const other = await h.service.open(POPOUT, 'srv-2');

    h.service.adoptSessions(POPOUT, OWNER);
    await h.service.dropOwner(POPOUT);

    // The window keeps the session it shows; the one it never saw is not slipped in beside it.
    await expect(h.service.open(OWNER, 'srv-1')).resolves.toEqual(mine);
    expect(filesErrorCode(await failure(h.service.queue(OWNER, theirs.sessionId)))).toBe(
      'invalidInput',
    );
    expect(other).toEqual(shared);
    await expect(h.service.queue(OWNER, shared.sessionId)).resolves.toBeTruthy();
    expect(h.sentOn(IPC.sftp.onSessionAdopted, OWNER)).toEqual([]);
  });

  it('still keeps a busy session when the other window has its own on that server', async () => {
    const h = setup();
    const mine = await h.service.open(OWNER, 'srv-1');
    const theirs = await h.service.open(POPOUT, 'srv-1');
    const gate = h.server.gate('sftpUnlink');
    const { batchId } = await h.service.remove(POPOUT, theirs.sessionId, ['/srv/site/index.html']);
    await gate.waitFor();

    h.service.adoptSessions(POPOUT, OWNER);
    await h.service.dropOwner(POPOUT);
    gate.open();

    // Nothing running is lost; the window's own session stays the one it is shown.
    expect((await h.done(batchId, OWNER)).ok).toBe(true);
    await expect(h.service.open(OWNER, 'srv-1')).resolves.toEqual(mine);
    expect(h.sentOn(IPC.sftp.onSessionAdopted, OWNER)).toEqual([]);
  });

  it('refuses a download whose window left the session while the folder was checked', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.service.addOwner(sessionId, POPOUT);
    h.localBrowse.record(POPOUT, h.local);

    const download = h.service.download(POPOUT, sessionId, {
      remotePaths: ['/srv/site/index.html'],
      localDir: h.local,
    });
    void h.service.removeOwner(sessionId, POPOUT);

    expect(filesErrorCode(await failure(download))).toBe('invalidInput');
    expect((await h.service.queue(OWNER, sessionId)).batches).toEqual([]);
  });
});

describe('transfers', () => {
  it('uploads, sends the queue and the finished event to the owner only, and keeps awake', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    await h.service.open(OTHER, 'srv-1');
    const source = join(h.local, 'app.css');
    writeFileSync(source, 'body{}');

    const { batchId } = await h.service.upload(OWNER, sessionId, {
      localPaths: [source],
      remoteDir: '/srv/site',
    });
    const event = await h.done(batchId);
    await vi.advanceTimersByTimeAsync(200);

    expect(event).toMatchObject({ sessionId, kind: 'upload', side: 'remote', ok: true });
    expect(h.server.read('/srv/site/app.css')?.toString()).toBe('body{}');
    const snapshots = h.sentOn<SftpQueueSnapshot>(IPC.sftp.onQueue);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((snapshot) => snapshot.sessionId === sessionId)).toBe(true);
    expect(h.sent.filter((one) => one.ownerId === OTHER)).toEqual([]);
    expect(h.awake[0]).toBe(true);
    expect(h.awake.at(-1)).toBe(false);
  });

  it('refuses a download into a folder the window never listed', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.localBrowse.record(OTHER, h.local);

    const error = await failure(
      h.service.download(OWNER, sessionId, {
        remotePaths: ['/srv/site/index.html'],
        localDir: h.local,
      }),
    );

    expect(filesErrorCode(error)).toBe('invalidInput');
    expect((await h.service.queue(OWNER, sessionId)).batches).toEqual([]);
  });

  it('downloads into a listed folder', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.localBrowse.record(OWNER, h.local);

    const { batchId } = await h.service.download(OWNER, sessionId, {
      remotePaths: ['/srv/site/index.html'],
      localDir: h.local,
    });
    const event = await h.done(batchId);

    expect(event).toMatchObject({ side: 'local', ok: true });
    expect(readFileSync(join(h.local, 'index.html'), 'utf-8')).toBe('<h1>hi</h1>');
  });

  it('queue answers the snapshot a returning page shows, conflict included', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    const source = join(h.local, 'index.html');
    writeFileSync(source, 'new');

    const { batchId } = await h.service.upload(OWNER, sessionId, {
      localPaths: [source],
      remoteDir: '/srv/site',
    });
    await until(
      async () => (await h.service.queue(OWNER, sessionId)).conflict !== null,
      'the conflict',
    );

    const snapshot = await h.service.queue(OWNER, sessionId);
    expect(snapshot.batches.map((batch) => batch.batchId)).toEqual([batchId]);
    expect(snapshot.conflict).toMatchObject({ batchId, name: 'index.html' });

    const unknown = await failure(
      h.service.resolveConflict(OWNER, sessionId, 'no-such-conflict', {
        action: 'skip',
        applyToAll: false,
      }),
    );
    expect(filesErrorCode(unknown)).toBe('invalidInput');

    await h.service.resolveConflict(OWNER, sessionId, snapshot.conflict?.conflictId ?? '', {
      action: 'overwrite',
      applyToAll: false,
    });
    await h.done(batchId);
    expect(h.server.read('/srv/site/index.html')?.toString()).toBe('new');
  });

  it('cancel, retry and clearFinished reach the engine', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.localBrowse.record(OWNER, h.local);

    const { batchId } = await h.service.download(OWNER, sessionId, {
      remotePaths: ['/srv/site/missing.txt'],
      localDir: h.local,
    });
    expect(await h.done(batchId)).toMatchObject({ ok: false, failed: 1 });

    h.server.file('/srv/site/missing.txt', 'here now');
    await h.service.retry(OWNER, sessionId, { batchId });
    await until(
      async () => (await h.service.queue(OWNER, sessionId)).batches[0]?.state === 'done',
      'the retried batch',
    );
    expect(existsSync(join(h.local, 'missing.txt'))).toBe(true);

    const gate = h.server.gate('sftpUnlink');
    const removal = await h.service.remove(OWNER, sessionId, ['/srv/site/missing.txt']);
    await gate.waitFor();
    await h.service.cancel(OWNER, sessionId, { batchId: removal.batchId });
    gate.open();
    await until(
      async () => (await h.service.queue(OWNER, sessionId)).batches[1]?.state !== 'running',
      'the cancel',
    );
    await h.service.cancel(OWNER, sessionId);

    await h.service.clearFinished(OWNER, sessionId);
    expect((await h.service.queue(OWNER, sessionId)).batches).toEqual([]);
  });

  it('keeps awake while any session is busy', async () => {
    const h = setup();
    const mine = await h.service.open(OWNER, 'srv-1');
    const theirs = await h.service.open(OTHER, 'srv-1');
    h.server.file('/srv/site/b.txt', 'b');
    const gate = h.server.gate('sftpUnlink');

    const first = await h.service.remove(OWNER, mine.sessionId, ['/srv/site/index.html']);
    await gate.waitFor(1);
    const second = await h.service.remove(OTHER, theirs.sessionId, ['/srv/site/b.txt']);
    await gate.waitFor(2);
    expect(h.service.runningTransfers()).toBe(2);

    gate.release(1);
    await h.done(first.batchId);
    expect(h.awake).toEqual([true]);
    expect(h.service.runningTransfers()).toBe(1);

    gate.open();
    await h.done(second.batchId, OTHER);
    expect(h.awake).toEqual([true, false]);
    expect(h.service.runningTransfers()).toBe(0);
  });
});

describe('remote changes', () => {
  it('remove deletes a folder with what is inside and answers its batch', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    const { batchId } = await h.service.remove(OWNER, sessionId, ['/srv/site']);
    const event = await h.done(batchId);

    expect(event).toMatchObject({ kind: 'delete', side: 'remote', target: '/srv', ok: true });
    expect(h.server.exists('/srv/site')).toBe(false);
    expect(h.server.exists('/srv/nowhere')).toBe(false);
  });

  it('chmod sets the mode, recursively when asked', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    const { batchId } = await h.service.chmod(OWNER, sessionId, {
      paths: ['/srv/site'],
      mode: 0o750,
      recursive: 'all',
    });
    await h.done(batchId);

    expect(h.server.modeOf('/srv/site')).toBe(0o750);
    expect(h.server.modeOf('/srv/site/index.html')).toBe(0o750);
  });

  it('mkdir answers the new path, and exists when the name is taken', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    await expect(h.service.mkdir(OWNER, sessionId, '/srv/site', 'logs')).resolves.toBe(
      '/srv/site/logs',
    );
    expect(h.server.exists('/srv/site/logs')).toBe(true);
    for (const name of ['logs', 'index.html', 'gone']) {
      const error = await failure(h.service.mkdir(OWNER, sessionId, '/srv/site', name));
      expect(filesErrorCode(error)).toBe('exists');
    }
  });

  it('mkdir refuses a bad name and codes a missing parent', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    const bad = await failure(h.service.mkdir(OWNER, sessionId, '/srv/site', 'a/b'));
    const missing = await failure(h.service.mkdir(OWNER, sessionId, '/srv/nope', 'x'));

    expect(filesErrorCode(bad)).toBe('invalidInput');
    expect(filesErrorCode(missing)).toBe('remoteFolderMissing');
  });

  it('mkdir goes ahead when the folder it goes in cannot be listed', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.failNext('sftpListDetailed', '/srv/site', SFTP_STATUS.permissionDenied);

    await expect(h.service.mkdir(OWNER, sessionId, '/srv/site', 'blind')).resolves.toBe(
      '/srv/site/blind',
    );
  });

  it('mkdir that loses a race reports exists', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    const gate = h.server.gate('sftpMkdir');
    const making = h.service.mkdir(OWNER, sessionId, '/srv/site', 'race');
    await gate.waitFor();
    h.server.dir('/srv/site/race');
    gate.open();

    expect(filesErrorCode(await failure(making))).toBe('exists');
  });

  it('rename answers the new path, and exists when the name is taken', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    await expect(
      h.service.rename(OWNER, sessionId, '/srv/site/index.html', 'home.html'),
    ).resolves.toBe('/srv/site/home.html');
    expect(h.server.read('/srv/site/home.html')?.toString()).toBe('<h1>hi</h1>');
    await expect(
      h.service.rename(OWNER, sessionId, '/srv/site/home.html', 'home.html'),
    ).resolves.toBe('/srv/site/home.html');

    const taken = await failure(
      h.service.rename(OWNER, sessionId, '/srv/site/home.html', 'assets'),
    );
    const root = await failure(h.service.rename(OWNER, sessionId, '/', 'x'));
    const bad = await failure(h.service.rename(OWNER, sessionId, '/srv/site/home.html', '..'));
    const gone = await failure(h.service.rename(OWNER, sessionId, '/srv/site/nope', 'x'));

    expect(filesErrorCode(taken)).toBe('exists');
    expect(filesErrorCode(root)).toBe('invalidInput');
    expect(filesErrorCode(bad)).toBe('invalidInput');
    expect(filesErrorCode(gone)).toBe('remoteFolderMissing');
  });

  it('rename that loses a race reports exists', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    const gate = h.server.gate('sftpRename');
    const renaming = h.service.rename(OWNER, sessionId, '/srv/site/index.html', 'race.html');
    await gate.waitFor();
    h.server.file('/srv/site/race.html', 'theirs');
    gate.open();

    expect(filesErrorCode(await failure(renaming))).toBe('exists');
  });
});

describe('a connection that drops during a change', () => {
  const dropped = () => new Error('The SSH connection to fake.example closed.');

  it('is not retried for mkdir, which may have happened', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.failNext('sftpMkdir', dropped());

    const error = await failure(h.service.mkdir(OWNER, sessionId, '/srv/site', 'logs'));

    expect(filesErrorCode(error)).toBe('unreachable');
    expect(h.server.callsOf('sftpMkdir')).toHaveLength(1);
    // The dead lease is gone, so the next call logs in again.
    expect(h.server.pool.outstanding).toBe(0);
    await h.service.list(OWNER, sessionId, '/srv/site');
    expect(h.server.pool.acquired).toBe(2);
  });

  it('is not retried for rename', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.failNext('sftpRename', dropped());

    const error = await failure(
      h.service.rename(OWNER, sessionId, '/srv/site/index.html', 'home.html'),
    );

    expect(filesErrorCode(error)).toBe('unreachable');
    expect(h.server.callsOf('sftpRename')).toHaveLength(1);
  });

  it('is not retried for a save from the editor', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    const text = await h.service.readText(OWNER, sessionId, '/srv/site/index.html');
    h.server.failNext('uploadFile', dropped());

    const error = await failure(
      h.service.writeText(OWNER, sessionId, {
        path: '/srv/site/index.html',
        content: 'new',
        bom: false,
        base: { size: text.size, mtimeMs: text.mtimeMs },
        force: false,
      }),
    );

    expect(filesErrorCode(error)).toBe('unreachable');
    expect(h.server.callsOf('uploadFile')).toHaveLength(1);
  });

  it('a read is still tried once more', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.failNext('sftpReadRange', dropped());

    await expect(
      h.service.readText(OWNER, sessionId, '/srv/site/index.html'),
    ).resolves.toMatchObject({ content: '<h1>hi</h1>' });
  });
});

describe('stat', () => {
  it('answers the entry as its folder lists it, or null', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    await expect(h.service.stat(OWNER, sessionId, '/srv/site/index.html')).resolves.toMatchObject({
      name: 'index.html',
      kind: 'file',
      size: 11,
      owner: 'www',
      group: 'www-data',
    });
    await expect(h.service.stat(OWNER, sessionId, '/srv/site/current')).resolves.toMatchObject({
      kind: 'dir',
      isSymlink: true,
    });
    await expect(h.service.stat(OWNER, sessionId, '/srv/site/nope')).resolves.toBeNull();
    await expect(h.service.stat(OWNER, sessionId, '/')).resolves.toMatchObject({
      path: '/',
      kind: 'dir',
      owner: null,
    });
  });

  it('falls back to a stat when the folder cannot be listed', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    h.server.failNext('sftpListDetailed', '/srv/site', SFTP_STATUS.permissionDenied);

    const entry = await h.service.stat(OWNER, sessionId, '/srv/site/index.html');

    expect(entry).toMatchObject({ name: 'index.html', size: 11, owner: null, group: null });
  });
});

describe('text files', () => {
  it('reads a file and saves it back, owner and group filled in', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    const text = await h.service.readText(OWNER, sessionId, '/srv/site/index.html');
    expect(text).toMatchObject({ content: '<h1>hi</h1>', bom: false });

    const saved = await h.service.writeText(OWNER, sessionId, {
      path: '/srv/site/index.html',
      content: '<h1>hello</h1>',
      bom: false,
      base: { size: text.size, mtimeMs: text.mtimeMs },
      force: false,
    });

    expect(h.server.read('/srv/site/index.html')?.toString()).toBe('<h1>hello</h1>');
    expect(saved).toMatchObject({ path: '/srv/site/index.html', size: 14, owner: 'www' });
  });

  it('refuses to overwrite a file that changed on the server', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');

    const error = await failure(
      h.service.writeText(OWNER, sessionId, {
        path: '/srv/site/index.html',
        content: 'mine',
        bom: false,
        base: { size: 1, mtimeMs: 0 },
        force: false,
      }),
    );

    expect(filesErrorCode(error)).toBe('changedOnServer');
    expect(h.server.read('/srv/site/index.html')?.toString()).toBe('<h1>hi</h1>');
  });

  it('still answers the saved entry when its folder cannot be listed afterwards', async () => {
    const h = setup();
    const { sessionId } = await h.service.open(OWNER, 'srv-1');
    const text = await h.service.readText(OWNER, sessionId, '/srv/site/index.html');
    // The upload lists nothing, so the only listing is the one that fills in the owner.
    h.server.failNext('sftpListDetailed', '/srv/site', SFTP_STATUS.permissionDenied);

    const saved = await h.service.writeText(OWNER, sessionId, {
      path: '/srv/site/index.html',
      content: 'x',
      bom: false,
      base: { size: text.size, mtimeMs: text.mtimeMs },
      force: false,
    });

    expect(saved).toMatchObject({ size: 1, owner: null, group: null });
  });
});
