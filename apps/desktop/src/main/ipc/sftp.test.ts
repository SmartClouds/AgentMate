import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { dockerFileTargetId, isDockerFileTargetId } from '../../shared/fileTargets';
import { IPC } from '../../shared/ipcChannels';
import {
  SFTP_EDIT_MAX_BYTES,
  SFTP_MAX_PATHS_PER_CALL,
  type SftpBatchFinished,
  type SftpBatchRef,
  type SftpListing,
  type SftpLocalEntry,
  type SftpLocalPlace,
  type SftpQueueSnapshot,
  type SftpRemoteEntry,
  type SftpSessionClosed,
  type SftpSessionInfo,
  type SftpTextFile,
} from '../../shared/sftpTypes';
import { sshErrorCode } from '../../shared/sshErrors';
import { fakeWebContents } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import type { SftpService } from '../sftp/service';
import { FakeSftpServer } from '../sftp/testing/fakeSftpClient';

/**
 * The SFTP file manager channels (E25): only the main window and the file manager's pop-outs are
 * answered, every argument is checked before the service sees it (and a refusal names the field,
 * never the value), sessions belong to the windows that own them, local writes stay inside
 * folders that window listed, events go to the owners alone, and a window that goes away takes
 * its sessions with it. Popping out is for the main window, window controls for the pop-out.
 */

useTempUserData();
// The on* channels go from main to the owner window; the tests below check what is sent on them.
expectChannelsCovered(IPC.sftp, [
  IPC.sftp.onQueue,
  IPC.sftp.onBatchFinished,
  IPC.sftp.onSessionClosed,
  IPC.sftp.onSessionAdopted,
  IPC.sftp.onWindowState,
]);

const C = IPC.sftp;

type Sender = ReturnType<typeof fakeWebContents> & { fire(event: string): void };

let server: FakeSftpServer;
let service: SftpService;
let allowed = true;
let contents: Map<number, Sender>;
let win: Sender;
let local = '';
/** The webContents ids main/sftp/window.ts would know as pop-outs. */
let popOuts: Set<number>;
let windows: {
  isSftpWindow: (contents: { id: number }) => boolean;
  linkedOwners: () => number[];
  open: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
  state: ReturnType<typeof vi.fn>;
  backToMain: ReturnType<typeof vi.fn>;
};

/** A window whose `on` and `once` listeners can be fired, and that hears what the service sends. */
function sender(): Sender {
  const base = fakeWebContents();
  const listeners = new Map<string, (() => void)[]>();
  const add = (event: string, listener: unknown) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener as () => void]);
  };
  const made: Sender = {
    ...base,
    on: add,
    once: add,
    fire: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
  contents.set(made.id, made);
  return made;
}

beforeEach(async () => {
  allowed = true;
  contents = new Map();
  popOuts = new Set();
  windows = {
    isSftpWindow: (one) => popOuts.has(one.id),
    linkedOwners: () => [win.id, ...popOuts],
    open: vi.fn(),
    control: vi.fn(),
    state: vi.fn(() => ({ isMaximized: true })),
    backToMain: vi.fn(),
  };
  local = realpathSync(tempDir('runova-ipc-sftp-'));
  server = new FakeSftpServer({ home: '/home/deploy' });
  server.dir('/srv/site/assets').file('/srv/site/index.html', '<h1>hi</h1>');
  const edits = tempDir('runova-ipc-sftp-edits-');
  await loadIpc(
    () => import('./sftp'),
    async (ipc) => {
      const { SftpService: Service } = await import('../sftp/service');
      const { LocalBrowseRegistry } = await import('../sftp/localBrowse');
      const localBrowse = new LocalBrowseRegistry();
      service = new Service({
        pool: server.pool,
        findServer: async (id) =>
          id === 'srv-1'
            ? { nickname: 'web', host: 'web.example.com', port: 22, username: 'deploy' }
            : isDockerFileTargetId(id)
              ? { nickname: 'shop-web-1 (container)', host: 'web', port: 0, username: 'root' }
              : null,
        send: (ownerId, channel, payload) => contents.get(ownerId)?.send(channel, payload),
        keepAwake: () => undefined,
        tempDir: () => edits,
        localBrowse,
        engine: { platform: 'linux' },
      });
      ipc.registerSftpHandlers({
        service,
        localBrowse,
        windows: windows as never,
        guard: () => allowed,
      });
    },
  );
  win = sender();
});

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invokeFrom<T>(win, channel, ...args);
}

async function failure(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

/** Fails with `[files:invalidInput]`, naming neither the value nor any part of it. */
async function refused(work: Promise<unknown>, value?: string): Promise<Error> {
  const error = await failure(work);
  expect(filesErrorCode(error)).toBe('invalidInput');
  if (value) expect(error.message).not.toContain(value);
  return error;
}

async function open(from: Sender = win): Promise<string> {
  const info = await invokeFrom<SftpSessionInfo>(from, C.open, 'srv-1');
  return info.sessionId;
}

async function finished(batchId: string, from: Sender = win): Promise<SftpBatchFinished> {
  let found: SftpBatchFinished | undefined;
  await vi.waitFor(() => {
    found = from
      .sentOn(C.onBatchFinished)
      .map(([event]) => event as SftpBatchFinished)
      .find((event) => event.batchId === batchId);
    expect(found).toBeDefined();
  });
  return found as SftpBatchFinished;
}

describe('the window guard', () => {
  it('answers only the main window', async () => {
    allowed = false;

    await expect(invoke(C.open, 'srv-1')).rejects.toThrow(/only the main window/);
    await expect(invoke(C.localPlaces)).rejects.toThrow(/only the main window/);
    await expect(invoke(C.popOut, 'sess-1')).rejects.toThrow(/only the main window/);
    expect(server.pool.acquired).toBe(0);
    expect(windows.open).not.toHaveBeenCalled();
  });

  it('lets in the main window and a registered pop-out, each from its own top frame', async () => {
    const { sftpSenderAllowed } = await import('./sftp');
    const page = (base: Sender) => ({ ...base, mainFrame: { url: 'app://renderer' } });
    const mainContents = page(sender());
    const popOut = page(sender());
    const stranger = page(sender());
    popOuts.add(popOut.id);
    const mainWindow = { webContents: mainContents } as never;
    const isPopOut = windows.isSftpWindow as never;
    const from = (one: ReturnType<typeof page>, frame: unknown = one.mainFrame) =>
      ({ sender: one, senderFrame: frame }) as never;

    expect(sftpSenderAllowed(from(mainContents), mainWindow, isPopOut)).toBe(true);
    expect(sftpSenderAllowed(from(popOut), mainWindow, isPopOut)).toBe(true);
    expect(sftpSenderAllowed(from(popOut), null, isPopOut)).toBe(true);
    expect(sftpSenderAllowed(from(stranger), mainWindow, isPopOut)).toBe(false);
    expect(sftpSenderAllowed(from(stranger), null, isPopOut)).toBe(false);
    // A frame inside either page is not the page.
    expect(sftpSenderAllowed(from(mainContents, { url: 'x' }), mainWindow, isPopOut)).toBe(false);
    expect(sftpSenderAllowed(from(popOut, null), mainWindow, isPopOut)).toBe(false);
  });
});

describe('the pop-out window', () => {
  /** A pop-out of `sessionId`, let into it the way main/sftp/window.ts does before the page loads. */
  function popOutOf(sessionId: string): Sender {
    const made = sender();
    popOuts.add(made.id);
    service.addOwner(sessionId, made.id);
    return made;
  }

  it("opens the session's window for the main window that owns it", async () => {
    const info = await call<SftpSessionInfo>(C.open, 'srv-1');

    await call(C.popOut, info.sessionId);

    expect(windows.open).toHaveBeenCalledWith(info, {});
  });

  it('passes on the folders the window should open at', async () => {
    const info = await call<SftpSessionInfo>(C.open, 'srv-1');

    await call(C.popOut, info.sessionId, { remotePath: '/srv/site', localPath: local });
    await call(C.popOut, info.sessionId, { remotePath: '/srv/site' });

    expect(windows.open).toHaveBeenNthCalledWith(1, info, {
      remotePath: '/srv/site',
      localPath: local,
    });
    expect(windows.open).toHaveBeenNthCalledWith(2, info, { remotePath: '/srv/site' });
  });

  it('refuses folders that are not plain absolute paths, without echoing them', async () => {
    const sessionId = await open();
    const bad: [Record<string, unknown>, string][] = [
      [{ remotePath: 'srv/secret-rel' }, 'secret-rel'],
      [{ remotePath: '/srv/secret-nul\0x' }, 'secret-nul'],
      [{ remotePath: `/secret-long/${'a'.repeat(4096)}` }, 'secret-long'],
      [{ localPath: 'secret-local-rel' }, 'secret-local-rel'],
      [{ localPath: '\\\\?\\C:\\secret-device' }, 'secret-device'],
      [{ localPath: `${local}/secret-local-long/${'a'.repeat(32_767)}` }, 'secret-local-long'],
      [{ localPath: `${local}/secret-local-nul\0` }, 'secret-local-nul'],
    ];
    for (const [view, value] of bad) {
      const error = await refused(call(C.popOut, sessionId, view), value);
      expect(error.message).toContain('folder');
    }
    await refused(call(C.popOut, sessionId, 'not a view'));
    expect(windows.open).not.toHaveBeenCalled();
  });

  it("refuses a bad session id, another window's session, and a pop-out popping out", async () => {
    const sessionId = await open();
    const popOut = popOutOf(sessionId);

    await refused(call(C.popOut, 'bad id; rm -rf'), 'rm -rf');
    const unknown = await refused(invokeFrom(sender(), C.popOut, sessionId));
    expect(unknown.message).toContain('Unknown session');
    const again = await refused(invokeFrom(popOut, C.popOut, sessionId));
    expect(again.message).toContain('Only the main window');
    expect(windows.open).not.toHaveBeenCalled();
  });

  it('lets the pop-out use the session it was let into, and hear its events', async () => {
    const sessionId = await open();
    const popOut = popOutOf(sessionId);

    await expect(invokeFrom(popOut, C.queue, sessionId)).resolves.toMatchObject({ sessionId });
    const listing = await invokeFrom<SftpListing<SftpRemoteEntry>>(popOut, C.list, sessionId, '~');
    expect(listing.path).toBe('/home/deploy');
    // Its open answers the shared session rather than a second one.
    const info = await invokeFrom<SftpSessionInfo>(popOut, C.open, 'srv-1');
    expect(info.sessionId).toBe(sessionId);

    await invokeFrom(popOut, C.close, sessionId);
    expect(win.sentOn(C.onSessionClosed)).toEqual([
      [{ sessionId, serverId: 'srv-1', reason: 'disconnected' } satisfies SftpSessionClosed],
    ]);
    expect(popOut.sentOn(C.onSessionClosed)).toEqual([]);
  });

  it('joins the main window and its pop-outs to one session per server', async () => {
    const sessionId = await open();
    const popOut = sender();
    popOuts.add(popOut.id);

    // A pop-out that is not in the session yet (it disconnected and connects again) joins it.
    const joined = await invokeFrom<SftpSessionInfo>(popOut, C.open, 'srv-1');
    // A window that is neither gets a session of its own.
    const apart = await invokeFrom<SftpSessionInfo>(sender(), C.open, 'srv-1');

    expect(joined.sessionId).toBe(sessionId);
    expect(apart.sessionId).not.toBe(sessionId);
    win.fire('destroyed');
    await expect(invokeFrom(popOut, C.queue, sessionId)).resolves.toBeTruthy();
  });

  it('keeps the session when the main window goes and the pop-out stays', async () => {
    const sessionId = await open();
    const popOut = popOutOf(sessionId);

    win.fire('destroyed');

    await refused(call(C.queue, sessionId));

    await expect(invokeFrom(popOut, C.queue, sessionId)).resolves.toBeTruthy();
    expect(server.pool.outstanding).toBe(1);
  });

  it('runs window controls for the pop-out on itself, and refuses the main window', async () => {
    const sessionId = await open();
    const popOut = popOutOf(sessionId);

    await invokeFrom(popOut, C.windowControl, 'maximize');
    await expect(invokeFrom(popOut, C.windowState)).resolves.toEqual({ isMaximized: true });
    await invokeFrom(popOut, C.backToMain);

    expect(windows.control).toHaveBeenCalledWith(popOut, 'maximize');
    expect(windows.state).toHaveBeenCalledWith(popOut);
    expect(windows.backToMain).toHaveBeenCalledWith(popOut);

    await refused(invokeFrom(popOut, C.windowControl, 'fullscreen'), 'fullscreen');
    for (const channel of [C.windowControl, C.windowState, C.backToMain]) {
      const error = await refused(call(channel, 'close'));
      expect(error.message).toContain("file manager's own window");
    }
    expect(windows.control).toHaveBeenCalledOnce();
    expect(windows.state).toHaveBeenCalledOnce();
    expect(windows.backToMain).toHaveBeenCalledOnce();
  });
});

describe('sessions', () => {
  it('opens a session and refuses a bad or unknown server id', async () => {
    const info = await call<SftpSessionInfo>(C.open, 'srv-1');
    expect(info).toMatchObject({ serverId: 'srv-1', nickname: 'web', home: '/home/deploy' });

    await refused(call(C.open, ''));
    await refused(call(C.open, 42));
    expect(filesErrorCode(await failure(call(C.open, 'srv-gone')))).toBe('siteUnknown');
  });

  it('opens a container or volume by its file target id, the longest one too (E27)', async () => {
    const serverId = '9c4b7e0e-2f7a-4f43-9d55-6a1f6f5f1a10';
    const byName = dockerFileTargetId({ serverId, kind: 'container', id: 'shop-web-1' });
    const byId = dockerFileTargetId({ serverId, kind: 'container', id: 'a1'.repeat(32) });

    const named = await call<SftpSessionInfo>(C.open, byName);
    const long = await call<SftpSessionInfo>(C.open, byId);

    expect(byId.length).toBeLessThanOrEqual(128);
    expect(named).toMatchObject({ serverId: byName, kind: 'container', port: 0 });
    expect(long.serverId).toBe(byId);
  });

  it('closes a session, and refuses a malformed session id without echoing it', async () => {
    const sessionId = await open();

    await call(C.close, sessionId);
    expect(server.pool.outstanding).toBe(0);
    await refused(call(C.list, sessionId, '~'));
    await refused(call(C.close, 'bad id; rm -rf'), 'rm -rf');
    await refused(call(C.close, 'x'.repeat(65)));
  });

  it("refuses another window's session", async () => {
    const sessionId = await open();
    const other = sender();

    const error = await refused(invokeFrom(other, C.queue, sessionId));
    expect(error.message).toContain('Unknown session');
  });

  it('a destroyed window takes its sessions and its listed folders with it', async () => {
    const sessionId = await open();
    await call(C.localList, local);

    win.fire('destroyed');
    await vi.waitFor(() => expect(server.pool.outstanding).toBe(0));

    await refused(call(C.queue, sessionId));
    await refused(call(C.localMkdir, local, 'after'));
  });

  it('a crashed renderer drops its sessions too, once however often it calls', async () => {
    const sessionId = await open();
    await call(C.queue, sessionId);

    win.fire('render-process-gone');
    await vi.waitFor(() => expect(server.pool.outstanding).toBe(0));

    await refused(call(C.queue, sessionId));
  });

  it('tells the owner when its server is removed', async () => {
    const sessionId = await open();
    const other = sender();

    await service.closeServer('srv-1', 'removed');

    expect(win.sentOn(C.onSessionClosed)).toEqual([
      [{ sessionId, serverId: 'srv-1', reason: 'removed' } satisfies SftpSessionClosed],
    ]);
    expect(other.sentOn(C.onSessionClosed)).toEqual([]);
  });
});

describe('remote browsing', () => {
  it('lists ~, relative paths and .., and keeps the error code', async () => {
    const sessionId = await open();

    const home = await call<SftpListing<SftpRemoteEntry>>(C.list, sessionId, '~');
    const up = await call<SftpListing<SftpRemoteEntry>>(C.list, sessionId, '../../srv/site');

    expect(home.path).toBe('/home/deploy');
    expect(up.entries.map((entry) => entry.name).sort()).toEqual(['assets', 'index.html']);
    expect(filesErrorCode(await failure(call(C.list, sessionId, '/srv/nope')))).toBe(
      'remoteFolderMissing',
    );
  });

  it('refuses an overlong path, a NUL byte, and a path that is not text', async () => {
    const sessionId = await open();
    const long = `/${'a'.repeat(5000)}`;

    await refused(call(C.list, sessionId, long), 'aaaa');
    await refused(call(C.list, sessionId, 'a\0b'));
    await refused(call(C.list, sessionId, 7));
  });

  it('codes a locked vault as [ssh:vault-locked]', async () => {
    const sessionId = await open();
    const { VaultLockedError } = await import('../ssh/vaultErrors');
    server.dropConnection();
    server.failNext('acquire', new VaultLockedError());

    expect(sshErrorCode(await failure(call(C.list, sessionId, '~')))).toBe('vault-locked');
  });

  it('stats an absolute path only', async () => {
    const sessionId = await open();

    await expect(
      call<SftpRemoteEntry | null>(C.stat, sessionId, '/srv/site/index.html'),
    ).resolves.toMatchObject({ kind: 'file', size: 11 });
    await expect(call(C.stat, sessionId, '/srv/site/nope')).resolves.toBeNull();
    await refused(call(C.stat, sessionId, 'srv/site'));
    await refused(call(C.stat, sessionId, '~/x'));
    await refused(call(C.stat, sessionId, `/${'b'.repeat(4096)}`), 'bbbb');
  });

  it('makes and renames folders, refusing names that are not one entry', async () => {
    const sessionId = await open();

    await expect(call(C.mkdir, sessionId, '/srv/site', 'logs')).resolves.toBe('/srv/site/logs');
    await expect(call(C.rename, sessionId, '/srv/site/logs', 'old-logs')).resolves.toBe(
      '/srv/site/old-logs',
    );
    expect(filesErrorCode(await failure(call(C.mkdir, sessionId, '/srv/site', 'assets')))).toBe(
      'exists',
    );
    await refused(call(C.mkdir, sessionId, '/srv/site', 'a/b'));
    await refused(call(C.mkdir, sessionId, '/srv/site', '..'));
    await refused(call(C.rename, sessionId, '/srv/site/old-logs', ''));
    await refused(call(C.rename, sessionId, 'relative', 'x'));
  });
});

describe('remote jobs', () => {
  it('removes paths as a batch, and refuses empty and oversized lists', async () => {
    const sessionId = await open();

    const ref = await call<SftpBatchRef>(C.remove, sessionId, ['/srv/site/assets']);
    expect(await finished(ref.batchId)).toMatchObject({ kind: 'delete', ok: true });
    expect(server.exists('/srv/site/assets')).toBe(false);

    await refused(call(C.remove, sessionId, []));
    await refused(
      call(
        C.remove,
        sessionId,
        Array.from({ length: SFTP_MAX_PATHS_PER_CALL + 1 }, () => '/x'),
      ),
    );
    await refused(call(C.remove, sessionId, ['relative']));
  });

  it('chmods with a mode from 0 to 0o7777 and a known scope', async () => {
    const sessionId = await open();

    const ref = await call<SftpBatchRef>(C.chmod, sessionId, {
      paths: ['/srv/site/index.html'],
      mode: 0o600,
      recursive: 'none',
    });
    await finished(ref.batchId);
    expect(server.modeOf('/srv/site/index.html')).toBe(0o600);

    const input = { paths: ['/srv/site'], mode: 0o755, recursive: 'all' };
    for (const bad of [
      { ...input, mode: 0o10000 },
      { ...input, mode: -1 },
      { ...input, mode: 1.5 },
      { ...input, recursive: 'some' },
      { ...input, paths: [] },
    ]) {
      await refused(call(C.chmod, sessionId, bad));
    }
  });

  it('uploads from anywhere, telling only the owner how it goes', async () => {
    const sessionId = await open();
    const other = sender();
    await open(other);
    const source = join(local, 'app.css');
    writeFileSync(source, 'body{}');

    const ref = await call<SftpBatchRef>(C.upload, sessionId, {
      localPaths: [source],
      remoteDir: '/srv/site',
    });

    expect(await finished(ref.batchId)).toMatchObject({ side: 'remote', target: '/srv/site' });
    await vi.waitFor(() => expect(win.sentOn(C.onQueue).length).toBeGreaterThan(0));
    const snapshot = win.sentOn(C.onQueue).at(-1)?.[0] as SftpQueueSnapshot;
    expect(snapshot.sessionId).toBe(sessionId);
    expect(other.sentOn(C.onQueue)).toEqual([]);
    expect(other.sentOn(C.onBatchFinished)).toEqual([]);
    expect(server.read('/srv/site/app.css')?.toString()).toBe('body{}');
  });

  it('refuses relative and device-style local paths and an unknown policy', async () => {
    const sessionId = await open();
    const input = { localPaths: [join(local, 'a')], remoteDir: '/srv/site' };

    await refused(call(C.upload, sessionId, { ...input, localPaths: ['relative/dir'] }));
    await refused(
      call(C.upload, sessionId, { ...input, localPaths: ['\\\\?\\C:\\secret'] }),
      'secret',
    );
    await refused(call(C.upload, sessionId, { ...input, localPaths: ['//./pipe/x'] }));
    await refused(call(C.upload, sessionId, { ...input, remoteDir: 'srv' }));
    await refused(call(C.upload, sessionId, { ...input, policy: 'always' }));
  });

  it('downloads only into a folder the window listed', async () => {
    const sessionId = await open();
    const input = { remotePaths: ['/srv/site/index.html'], localDir: local };

    await refused(call(C.download, sessionId, input));
    await call(C.localList, local);
    const ref = await call<SftpBatchRef>(C.download, sessionId, { ...input, policy: 'overwrite' });

    expect(await finished(ref.batchId)).toMatchObject({ side: 'local', ok: true });
    expect(existsSync(join(local, 'index.html'))).toBe(true);
    await refused(call(C.download, sessionId, { ...input, localDir: 'relative' }));
  });

  it('resolves a conflict, and refuses a bad decision or an unknown id', async () => {
    const sessionId = await open();
    const source = join(local, 'index.html');
    writeFileSync(source, 'new');
    const ref = await call<SftpBatchRef>(C.upload, sessionId, {
      localPaths: [source],
      remoteDir: '/srv/site',
    });
    let conflictId = '';
    await vi.waitFor(async () => {
      const snapshot = await call<SftpQueueSnapshot>(C.queue, sessionId);
      expect(snapshot.conflict).not.toBeNull();
      conflictId = snapshot.conflict?.conflictId ?? '';
    });

    await refused(call(C.resolveConflict, sessionId, conflictId, { action: 'merge' }));
    await refused(
      call(C.resolveConflict, sessionId, 'not a conflict', { action: 'skip', applyToAll: false }),
    );
    const unknown = await refused(
      call(C.resolveConflict, sessionId, 'feed-beef', { action: 'skip', applyToAll: false }),
    );
    expect(unknown.message).toContain('no longer waiting');

    await call(C.resolveConflict, sessionId, conflictId, { action: 'overwrite', applyToAll: true });
    await finished(ref.batchId);
    expect(server.read('/srv/site/index.html')?.toString()).toBe('new');
  });

  it('cancels, retries and clears with or without a target', async () => {
    const sessionId = await open();
    await call(C.localList, local);
    const ref = await call<SftpBatchRef>(C.download, sessionId, {
      remotePaths: ['/srv/site/missing.txt'],
      localDir: local,
    });
    await finished(ref.batchId);

    await call(C.retry, sessionId, { batchId: ref.batchId });
    await call(C.retry, sessionId);
    await call(C.cancel, sessionId, { batchId: ref.batchId });
    await call(C.cancel, sessionId);
    await vi.waitFor(async () => {
      const snapshot = await call<SftpQueueSnapshot>(C.queue, sessionId);
      expect(snapshot.batches[0]?.finishedAt).not.toBeNull();
    });
    await call(C.clearFinished, sessionId);
    expect((await call<SftpQueueSnapshot>(C.queue, sessionId)).batches).toEqual([]);

    await refused(call(C.cancel, sessionId, { batchId: ref.batchId, itemId: 'one' }));
    await refused(call(C.retry, sessionId, { batchId: 'bad batch' }));
    await refused(call(C.clearFinished, 'bad session'));
    await refused(call(C.queue, ''));
    // A well-formed id that is not in the queue is the engine's to refuse.
    await refused(call(C.retry, sessionId, { batchId: ref.batchId, itemId: '1' }));
  });
});

describe('the remote editor', () => {
  it('reads and saves a text file', async () => {
    const sessionId = await open();

    const text = await call<SftpTextFile>(C.readText, sessionId, '/srv/site/index.html');
    const saved = await call<SftpRemoteEntry>(C.writeText, sessionId, {
      path: '/srv/site/index.html',
      content: 'edited',
      bom: false,
      base: { size: text.size, mtimeMs: text.mtimeMs },
      force: false,
    });

    expect(saved).toMatchObject({ path: '/srv/site/index.html', size: 6 });
    await refused(call(C.readText, sessionId, 'index.html'));
  });

  it('refuses content over the edit limit and a malformed save', async () => {
    const sessionId = await open();
    const input = {
      path: '/srv/site/index.html',
      content: 'x',
      bom: false,
      base: { size: 11, mtimeMs: 0 },
      force: true,
    };

    await refused(
      call(C.writeText, sessionId, { ...input, content: 'y'.repeat(SFTP_EDIT_MAX_BYTES + 1) }),
      'yyyy',
    );
    await refused(call(C.writeText, sessionId, { ...input, base: { size: -1, mtimeMs: 0 } }));
    await refused(call(C.writeText, sessionId, { ...input, force: 'yes' }));
    await refused(call(C.writeText, sessionId, { ...input, path: 'relative' }));
    expect(server.read('/srv/site/index.html')?.toString()).toBe('<h1>hi</h1>');
  });
});

describe('this computer', () => {
  it('lists the places', async () => {
    const places = await call<SftpLocalPlace[]>(C.localPlaces);

    expect(places.some((place) => place.id === 'home')).toBe(true);
  });

  it('lists a folder, which lets the window write inside it', async () => {
    mkdirSync(join(local, 'inner'));

    await refused(call(C.localMkdir, local, 'early'));
    const listing = await call<SftpListing<SftpLocalEntry>>(C.localList, local);
    expect(listing.entries.map((entry) => entry.name)).toEqual(['inner']);

    const made = await call<string>(C.localMkdir, join(local, 'inner'), 'made');
    expect(existsSync(made)).toBe(true);
    expect(filesErrorCode(await failure(call(C.localMkdir, local, 'inner')))).toBe('exists');
    await refused(call(C.localMkdir, local, 'a/b'));
    // Another window has listed nothing.
    await refused(invokeFrom(sender(), C.localMkdir, local, 'theirs'));
  });

  it('refuses a relative or device path to list, and codes a missing folder', async () => {
    await refused(call(C.localList, 'relative/dir'));
    await refused(call(C.localList, '\\\\.\\pipe\\x'));
    await refused(call(C.localList, `${local}\0`));
    expect(filesErrorCode(await failure(call(C.localList, join(local, 'gone'))))).toBe(
      'folderMissing',
    );
  });

  it('renames inside a listed folder only', async () => {
    const file = join(local, 'a.txt');
    writeFileSync(file, 'a');

    await refused(call(C.localRename, file, 'b.txt'));
    await call(C.localList, local);
    await expect(call(C.localRename, file, 'b.txt')).resolves.toBe(join(local, 'b.txt'));
    await refused(call(C.localRename, join(local, 'b.txt'), '..'));
  });

  it('never deletes or renames the listed folder itself, only what is in it', async () => {
    mkdirSync(join(local, 'child'));
    await call(C.localList, local);

    await refused(call(C.localDelete, [local], { permanent: true }));
    await refused(call(C.localRename, local, 'moved'));
    await refused(call(C.localDelete, [join(local, 'child', '..')], { permanent: true }));
    expect(existsSync(join(local, 'child'))).toBe(true);

    await call(C.localDelete, [join(local, 'child')], { permanent: true });
    expect(existsSync(join(local, 'child'))).toBe(false);
  });

  it('deletes inside a listed folder only, permanently when asked', async () => {
    const file = join(local, 'a.txt');
    writeFileSync(file, 'a');

    await refused(call(C.localDelete, [file], { permanent: true }));
    await call(C.localList, local);
    await call(C.localDelete, [file], { permanent: true });
    expect(existsSync(file)).toBe(false);

    await refused(call(C.localDelete, [file]));
    await refused(call(C.localDelete, [], { permanent: false }));
    await refused(call(C.localDelete, ['relative'], { permanent: false }));
  });
});
