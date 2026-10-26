import type { SshSavedServer } from '@shared/apiTypes';
import { encodeFilesError } from '@shared/deployFilesErrors';
import type {
  SftpListing,
  SftpLocalEntry,
  SftpQueueSnapshot,
  SftpRemoteEntry,
  SftpSessionInfo,
} from '@shared/sftpTypes';
import { encodeSshError } from '@shared/sshErrors';
import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { parentPath } from '../lib/sftp/paths';
import { hasRunningTransfers, resetSftpStore, serverFiles, useSftpStore } from './sftpStore';

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => 'loading-toast'),
  dismiss: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

/**
 * The SFTP file manager's state (E25): one entry per saved server, kept across page visits, with
 * a pane for each side. Main does the work; the store asks, keeps what came back, and turns the
 * queue events into refreshed panes and toasts.
 */

const SERVER: SshSavedServer = {
  id: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  hasSecret: true,
  createdAt: 0,
  lastConnectedAt: null,
};

const SESSION: SftpSessionInfo = {
  sessionId: 'sess-1',
  serverId: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'deploy',
  home: '/home/deploy',
};

function remoteEntry(name: string, dir = '/home/deploy', isDirectory = false): SftpRemoteEntry {
  return {
    name,
    path: `${dir === '/' ? '' : dir}/${name}`,
    kind: isDirectory ? 'dir' : 'file',
    isDirectory,
    isSymlink: false,
    size: isDirectory ? 0 : 100,
    mtimeMs: 1_700_000_000_000,
    mode: isDirectory ? 0o755 : 0o644,
    owner: 'deploy',
    group: 'deploy',
  };
}

function localEntry(name: string, dir = 'C:\\Users\\me', isDirectory = false): SftpLocalEntry {
  return {
    name,
    path: `${dir}\\${name}`,
    isDirectory,
    isSymlink: false,
    size: 10,
    mtimeMs: 0,
    mode: null,
    hidden: false,
  };
}

function remoteListing(path: string, names: string[]): SftpListing<SftpRemoteEntry> {
  return {
    path,
    parent: parentPath(path),
    entries: names.map((name) => remoteEntry(name, path)),
  };
}

const EMPTY_QUEUE: SftpQueueSnapshot = {
  sessionId: 'sess-1',
  batches: [],
  conflict: null,
  pendingConflicts: 0,
};

let bridge: FakeBridge;

function install(overrides: Record<string, unknown> = {}): FakeBridge {
  bridge = installRunovaBridge({
    'ssh.listServers': [SERVER],
    'sftp.open': SESSION,
    'sftp.queue': EMPTY_QUEUE,
    'sftp.list': async (_session: string, path: string) =>
      remoteListing(path === '~' ? '/home/deploy' : path, ['a.txt', 'b.txt']),
    'sftp.localPlaces': [
      { id: 'drive:C', label: 'Local Disk (C:)', path: 'C:\\', kind: 'drive' },
      { id: 'home', label: 'Home', path: 'C:\\Users\\me', kind: 'home' },
    ],
    'sftp.localList': async (path: string) => ({
      path,
      parent: 'C:\\Users',
      entries: [localEntry('notes.txt', path), localEntry('photos', path, true)],
    }),
    ...overrides,
  });
  return bridge;
}

const files = () => serverFiles(useSftpStore.getState(), 'srv-1');

beforeEach(() => {
  resetSftpStore();
  toast.info.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  install();
});

describe('connect', () => {
  it('goes connecting, then ready, then lists the home folder', async () => {
    const pending = useSftpStore.getState().connect('srv-1');
    expect(files().status).toBe('connecting');
    await pending;
    expect(files().status).toBe('ready');
    expect(files().session).toEqual(SESSION);
    expect(files().server?.nickname).toBe('prod');
    await waitFor(() =>
      expect(files().remote.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt']),
    );
    expect(bridge.$fn('sftp.list')).toHaveBeenCalledWith('sess-1', '/home/deploy');
    expect(files().remote.path).toBe('/home/deploy');
  });

  it('goes through host key trust, so a changed key is asked about and the connect retried', async () => {
    let calls = 0;
    install({
      'sftp.open': async () => {
        calls += 1;
        if (calls === 1) throw new Error(encodeSshError('host-key-changed', 'Changed.'));
        return SESSION;
      },
      // Someone trusted the key meanwhile, so no prompt is needed and the retry goes ahead.
      'ssh.hostKeyStatus': { stored: 'aa', presented: 'aa', nickname: 'prod' },
    });
    await useSftpStore.getState().connect('srv-1');
    expect(calls).toBe(2);
    expect(files().status).toBe('ready');
  });

  it('says locked when the vault holds the secret', async () => {
    install({
      'sftp.open': async () => {
        throw new Error(encodeSshError('vault-locked', 'The vault is locked.'));
      },
    });
    await useSftpStore.getState().connect('srv-1');
    expect(files().status).toBe('locked');
  });

  it('keeps the reason for any other failure', async () => {
    install({
      'sftp.open': async () => {
        throw new Error(encodeFilesError('auth', 'denied'));
      },
    });
    await useSftpStore.getState().connect('srv-1');
    expect(files().status).toBe('error');
    expect(files().error).toMatch(/username, password/);
  });

  it('says missing for a server that is not saved, without trying to open it', async () => {
    install({ 'ssh.listServers': [] });
    await useSftpStore.getState().connect('srv-1');
    expect(files().status).toBe('missing');
    expect(() => bridge.$fn('sftp.open')).toThrow();
  });

  it('reuses the session on a second connect', async () => {
    await useSftpStore.getState().connect('srv-1');
    await useSftpStore.getState().connect('srv-1');
    expect(bridge.$fn('sftp.open')).toHaveBeenCalledTimes(1);
  });

  it('re-attaches to the queue, so a pending conflict comes back', async () => {
    const conflicted: SftpQueueSnapshot = { ...EMPTY_QUEUE, pendingConflicts: 2 };
    install({ 'sftp.queue': conflicted });
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().queue).toEqual(conflicted));
    expect(bridge.$fn('sftp.queue')).toHaveBeenCalledWith('sess-1');
  });
});

describe('the local pane', () => {
  it('lists the places and opens Home', async () => {
    await useSftpStore.getState().initLocal('srv-1');
    expect(useSftpStore.getState().places?.map((p) => p.label)).toEqual([
      'Local Disk (C:)',
      'Home',
    ]);
    expect(files().local.path).toBe('C:\\Users\\me');
    expect(files().local.entries.map((e) => e.name)).toEqual(['notes.txt', 'photos']);
  });

  it('keeps errors to the pane they happened in', async () => {
    install({
      'sftp.list': async () => {
        throw new Error(encodeFilesError('permissionDenied', ''));
      },
    });
    await useSftpStore.getState().initLocal('srv-1');
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.error).toMatch(/Permission denied/));
    expect(files().local.error).toBeNull();
    expect(files().local.entries).toHaveLength(2);
  });
});

describe('navigation', () => {
  beforeEach(async () => {
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.entries).toHaveLength(2));
  });

  it('opens a typed path and answers ok', async () => {
    const result = await useSftpStore.getState().goTo('srv-1', 'remote', '/var/www');
    expect(result).toEqual({ status: 'ok' });
    expect(files().remote.path).toBe('/var/www');
  });

  it('answers the problem for a typed path that fails, and stays where it was', async () => {
    bridge.$set('sftp.list', async () => {
      throw new Error(encodeFilesError('remoteFolderMissing', ''));
    });
    const result = await useSftpStore.getState().goTo('srv-1', 'remote', 'nope');
    expect(result).toEqual({ status: 'failed', problem: expect.stringMatching(/doesn't exist/) });
    expect(files().remote.path).toBe('/home/deploy');
    expect(files().remote.error).toBeNull();
    expect(files().remote.entries).toHaveLength(2);
  });

  it('answers superseded for a typed path another navigation overtook', async () => {
    const pending = new Map<string, () => void>();
    bridge.$set(
      'sftp.list',
      (_s: string, path: string) =>
        new Promise((resolve) => pending.set(path, () => resolve(remoteListing(path, ['x'])))),
    );
    const typed = useSftpStore.getState().goTo('srv-1', 'remote', '/slow');
    const other = useSftpStore.getState().navigate('srv-1', 'remote', '/var');
    pending.get('/var')?.();
    await other;
    pending.get('/slow')?.();
    expect(await typed).toEqual({ status: 'superseded' });
    expect(files().remote.path).toBe('/var');
  });

  it('keeps a navigation when a refresh of the old folder is asked for during it', async () => {
    const pending = new Map<string, () => void>();
    bridge.$set(
      'sftp.list',
      (_s: string, path: string) =>
        new Promise((resolve) => pending.set(path, () => resolve(remoteListing(path, ['x'])))),
    );
    const going = useSftpStore.getState().navigate('srv-1', 'remote', '/var');
    // An upload into the old folder finishes while /var is still loading.
    bridge.$emit('sftp.onBatchFinished', {
      sessionId: 'sess-1',
      batchId: 'b1',
      kind: 'upload',
      side: 'remote',
      target: '/home/deploy',
      ok: true,
      failed: 0,
    });
    pending.get('/home/deploy')?.();
    pending.get('/var')?.();
    await going;
    await waitFor(() => expect(files().remote.path).toBe('/var'));
    expect(files().remote.loading).toBe(false);
  });

  it('drops a refresh that comes back after the pane moved on', async () => {
    const pending = new Map<string, () => void>();
    bridge.$set(
      'sftp.list',
      (_s: string, path: string) =>
        new Promise((resolve) => pending.set(path, () => resolve(remoteListing(path, ['x'])))),
    );
    const refreshing = useSftpStore.getState().refresh('srv-1', 'remote');
    const going = useSftpStore.getState().navigate('srv-1', 'remote', '/var');
    pending.get('/var')?.();
    await going;
    pending.get('/home/deploy')?.();
    await refreshing;
    expect(files().remote.path).toBe('/var');
    expect(files().remote.loading).toBe(false);
  });

  it('goes up, home and resolves relative input against the current folder', async () => {
    await useSftpStore.getState().goTo('srv-1', 'remote', 'logs');
    expect(files().remote.path).toBe('/home/deploy/logs');
    await useSftpStore.getState().up('srv-1', 'remote');
    expect(files().remote.path).toBe('/home/deploy');
    await useSftpStore.getState().navigate('srv-1', 'remote', '/etc');
    await useSftpStore.getState().home('srv-1', 'remote');
    expect(files().remote.path).toBe('/home/deploy');
  });

  it('keeps the selection by name across a refresh, and drops it on a new folder', async () => {
    useSftpStore
      .getState()
      .setSelection('srv-1', 'remote', { selected: ['b.txt'], focus: 'b.txt', anchor: 'b.txt' });
    await useSftpStore.getState().refresh('srv-1', 'remote');
    expect(files().remote.selection.selected).toEqual(['b.txt']);
    await useSftpStore.getState().navigate('srv-1', 'remote', '/etc');
    expect(files().remote.selection.selected).toEqual([]);
  });

  it('flips the sort on the same column and keeps the filter per pane', () => {
    useSftpStore.getState().sortBy('srv-1', 'remote', 'size');
    expect(files().remote.sort).toEqual({ key: 'size', dir: 'asc' });
    useSftpStore.getState().sortBy('srv-1', 'remote', 'size');
    expect(files().remote.sort).toEqual({ key: 'size', dir: 'desc' });
    useSftpStore.getState().setFilter('srv-1', 'remote', 'a');
    useSftpStore.getState().toggleHidden('srv-1', 'remote');
    expect(files().remote.filter).toBe('a');
    expect(files().remote.showHidden).toBe(true);
    expect(files().local.filter).toBe('');
  });
});

describe('transfers', () => {
  beforeEach(async () => {
    install({ 'sftp.upload': { batchId: 'b1' }, 'sftp.download': { batchId: 'b2' } });
    await useSftpStore.getState().initLocal('srv-1');
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.entries).toHaveLength(2));
  });

  it('uploads the selected local entries to the remote folder', async () => {
    useSftpStore.getState().setSelection('srv-1', 'local', {
      selected: ['notes.txt', 'photos'],
      focus: null,
      anchor: null,
    });
    await useSftpStore.getState().transferSelected('srv-1', 'local');
    expect(bridge.$fn('sftp.upload')).toHaveBeenCalledWith('sess-1', {
      localPaths: ['C:\\Users\\me\\notes.txt', 'C:\\Users\\me\\photos'],
      remoteDir: '/home/deploy',
    });
  });

  it('downloads the selected remote entries to the local folder', async () => {
    useSftpStore
      .getState()
      .setSelection('srv-1', 'remote', { selected: ['a.txt'], focus: 'a.txt', anchor: 'a.txt' });
    await useSftpStore.getState().transferSelected('srv-1', 'remote');
    expect(bridge.$fn('sftp.download')).toHaveBeenCalledWith('sess-1', {
      remotePaths: ['/home/deploy/a.txt'],
      localDir: 'C:\\Users\\me',
    });
  });

  it('sends dropped paths to the folder they were dropped on', async () => {
    await useSftpStore
      .getState()
      .transferPaths('srv-1', 'local', ['D:\\x.zip'], '/home/deploy/site');
    expect(bridge.$fn('sftp.upload')).toHaveBeenCalledWith('sess-1', {
      localPaths: ['D:\\x.zip'],
      remoteDir: '/home/deploy/site',
    });
  });

  it('keeps the queue from the snapshots', () => {
    const snapshot = { ...EMPTY_QUEUE, pendingConflicts: 1 };
    bridge.$emit('sftp.onQueue', snapshot);
    expect(files().queue).toEqual(snapshot);
    bridge.$emit('sftp.onQueue', { ...snapshot, sessionId: 'other' });
    expect(files().queue).toEqual(snapshot);
  });

  it('refreshes the pane showing the target folder when a batch finishes', async () => {
    bridge.$fn('sftp.list').mockClear();
    bridge.$emit('sftp.onBatchFinished', {
      sessionId: 'sess-1',
      batchId: 'b1',
      kind: 'upload',
      side: 'remote',
      target: '/home/deploy',
      ok: true,
      failed: 0,
    });
    await waitFor(() =>
      expect(bridge.$fn('sftp.list')).toHaveBeenCalledWith('sess-1', '/home/deploy'),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('tells about failures in a toast', () => {
    bridge.$emit('sftp.onQueue', {
      ...EMPTY_QUEUE,
      batches: [{ batchId: 'b1', label: 'site (3 files)' }],
    });
    bridge.$emit('sftp.onBatchFinished', {
      sessionId: 'sess-1',
      batchId: 'b1',
      kind: 'upload',
      side: 'remote',
      target: '/elsewhere',
      ok: false,
      failed: 2,
    });
    expect(toast.error).toHaveBeenCalledWith('Upload finished with 2 failed', {
      description: 'site (3 files)',
    });
  });

  it('tells about a finished transfer only while its page is not open', () => {
    const finished = {
      sessionId: 'sess-1',
      batchId: 'b1',
      kind: 'upload',
      side: 'remote',
      target: '/elsewhere',
      ok: true,
      failed: 0,
    };
    useSftpStore.getState().setPageVisible('srv-1', true);
    bridge.$emit('sftp.onBatchFinished', finished);
    expect(toast.success).not.toHaveBeenCalled();
    useSftpStore.getState().setPageVisible('srv-1', false);
    bridge.$emit('sftp.onBatchFinished', finished);
    expect(toast.success).toHaveBeenCalledWith('Upload to prod finished', expect.anything());
  });

  it('closes the session when its server is removed', () => {
    bridge.$emit('sftp.onSessionClosed', {
      sessionId: 'sess-1',
      serverId: 'srv-1',
      reason: 'removed',
    });
    expect(files().status).toBe('missing');
    expect(files().session).toBeNull();
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/prod was removed/));
  });

  it('knows when transfers are still running', () => {
    expect(hasRunningTransfers(files().queue)).toBe(false);
    bridge.$emit('sftp.onQueue', {
      ...EMPTY_QUEUE,
      batches: [{ batchId: 'b1', state: 'running' }],
    });
    expect(hasRunningTransfers(files().queue)).toBe(true);
  });

  it('disconnects and forgets the session', async () => {
    await useSftpStore.getState().disconnect('srv-1');
    expect(bridge.$fn('sftp.close')).toHaveBeenCalledWith('sess-1');
    expect(files().status).toBe('idle');
    expect(files().session).toBeNull();
  });
});

describe('file operations', () => {
  beforeEach(async () => {
    await useSftpStore.getState().initLocal('srv-1');
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.entries).toHaveLength(2));
  });

  it('makes a folder, refreshes and selects it', async () => {
    install({
      'sftp.mkdir': async () => '/home/deploy/new',
      'sftp.list': async (_s: string, path: string) => remoteListing(path, ['a.txt', 'new']),
    });
    const ok = await useSftpStore.getState().mkdir('srv-1', 'remote', 'new');
    expect(ok).toBe(true);
    expect(bridge.$fn('sftp.mkdir')).toHaveBeenCalledWith('sess-1', '/home/deploy', 'new');
    expect(files().remote.selection.selected).toEqual(['new']);
  });

  it('says so when the name is taken, and answers false so the field stays open', async () => {
    install({
      'sftp.localMkdir': async () => {
        throw new Error(encodeFilesError('exists', ''));
      },
    });
    const ok = await useSftpStore.getState().mkdir('srv-1', 'local', 'photos');
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('"photos" is already there. Pick another name.');
  });

  it('refuses a name that cannot be an entry without asking main', async () => {
    const ok = await useSftpStore.getState().rename('srv-1', 'remote', '/home/deploy/a.txt', 'a/b');
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalled();
    expect(() => bridge.$fn('sftp.rename')).toThrow();
  });

  it('renames and selects the new name', async () => {
    install({
      'sftp.rename': async () => '/home/deploy/c.txt',
      'sftp.list': async (_s: string, path: string) => remoteListing(path, ['b.txt', 'c.txt']),
    });
    const ok = await useSftpStore
      .getState()
      .rename('srv-1', 'remote', '/home/deploy/a.txt', 'c.txt');
    expect(ok).toBe(true);
    expect(files().remote.selection.selected).toEqual(['c.txt']);
  });

  it('queues a remote delete and answers its batch', async () => {
    install({ 'sftp.remove': { batchId: 'del-1' } });
    expect(await useSftpStore.getState().removeRemote('srv-1', ['/home/deploy/a.txt'])).toBe(
      'del-1',
    );
  });

  it('answers the problem when the Trash fails, so a permanent delete can be offered', async () => {
    install({
      'sftp.localDelete': async (_paths: string[], options: { permanent: boolean }) => {
        if (!options.permanent) throw new Error('Trash is not available');
      },
    });
    const first = await useSftpStore
      .getState()
      .removeLocal('srv-1', ['C:\\x'], { permanent: false });
    expect(first).toEqual({ ok: false, message: 'Trash is not available' });
    const second = await useSftpStore
      .getState()
      .removeLocal('srv-1', ['C:\\x'], { permanent: true });
    expect(second).toEqual({ ok: true });
  });

  it('reads a file before opening the editor, and opens it with what it read', async () => {
    const text = {
      path: '/home/deploy/a.txt',
      content: 'hi',
      size: 2,
      mtimeMs: 1,
      mode: 0o644,
      bom: false,
    };
    install({ 'sftp.readText': async () => text });
    await useSftpStore.getState().openEditor('srv-1', '/home/deploy/a.txt');
    expect(bridge.$fn('sftp.readText')).toHaveBeenCalledWith('sess-1', '/home/deploy/a.txt');
    expect(files().editingPath).toBe('/home/deploy/a.txt');
    expect(files().editingFile).toEqual(text);
    useSftpStore.getState().closeEditor('srv-1');
    expect(files().editingPath).toBeNull();
    expect(files().editingFile).toBeNull();
  });

  it.each([
    ['tooLarge', 'a.txt is too large to edit here'],
    ['notText', "a.txt isn't a text file"],
  ] as const)('never opens the editor for a file that is %s, and says why', async (code, words) => {
    install({
      'sftp.readText': async () => {
        throw new Error(encodeFilesError(code, 'nope'));
      },
    });
    await useSftpStore.getState().openEditor('srv-1', '/home/deploy/a.txt');
    expect(files().editingPath).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(words, expect.anything());
  });

  it('says why a file could not be read for the editor', async () => {
    install({
      'sftp.readText': async () => {
        throw new Error(encodeFilesError('timeout', ''));
      },
    });
    await useSftpStore.getState().openEditor('srv-1', '/home/deploy/a.txt');
    expect(files().editingPath).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('Could not open a.txt', {
      description: expect.stringMatching(/too long/),
    });
  });

  it('opens and closes the properties dialog', () => {
    useSftpStore.getState().openProperties('srv-1', ['/home/deploy/a.txt']);
    expect(files().propertiesPaths).toEqual(['/home/deploy/a.txt']);
    useSftpStore.getState().closeProperties('srv-1');
    expect(files().propertiesPaths).toBeNull();
  });

  it('passes chmod through and rejects with the problem for the dialog to show', async () => {
    install({
      'sftp.chmod': async () => {
        throw new Error(encodeFilesError('server', 'Operation not permitted'));
      },
    });
    await expect(
      useSftpStore
        .getState()
        .chmod('srv-1', { paths: ['/home/deploy/a.txt'], mode: 0o600, recursive: 'none' }),
    ).rejects.toThrow('Operation not permitted');
  });

  it('passes the queue controls through with the session', async () => {
    await useSftpStore
      .getState()
      .resolveConflict('srv-1', 'c1', { action: 'skip', applyToAll: true });
    await useSftpStore.getState().cancel('srv-1', { batchId: 'b1' });
    await useSftpStore.getState().retry('srv-1', {});
    await useSftpStore.getState().clearFinished('srv-1');
    expect(bridge.$fn('sftp.resolveConflict')).toHaveBeenCalledWith('sess-1', 'c1', {
      action: 'skip',
      applyToAll: true,
    });
    expect(bridge.$fn('sftp.cancel')).toHaveBeenCalledWith('sess-1', { batchId: 'b1' });
    expect(bridge.$fn('sftp.retry')).toHaveBeenCalledWith('sess-1', {});
    expect(bridge.$fn('sftp.clearFinished')).toHaveBeenCalledWith('sess-1');
  });
});

describe('connect, the less common answers', () => {
  it('ignores a second connect while the first is still going', async () => {
    const first = useSftpStore.getState().connect('srv-1');
    await useSftpStore.getState().connect('srv-1');
    await first;
    expect(bridge.$fn('sftp.open')).toHaveBeenCalledTimes(1);
  });

  it('still opens when the saved servers cannot be read', async () => {
    install({
      'ssh.listServers': async () => {
        throw new Error('no store');
      },
    });
    await useSftpStore.getState().connect('srv-1');
    expect(files().status).toBe('ready');
    expect(files().server?.nickname).toBe('prod');
  });

  it('says locked when main answers with the files code for a locked vault', async () => {
    install({
      'sftp.open': async () => {
        throw new Error(encodeFilesError('vaultLocked', ''));
      },
    });
    await useSftpStore.getState().connect('srv-1');
    expect(files().status).toBe('locked');
  });

  it('says missing when main no longer knows the server', async () => {
    install({
      'sftp.open': async () => {
        throw new Error(encodeFilesError('siteUnknown', ''));
      },
    });
    await useSftpStore.getState().connect('srv-1');
    expect(files().status).toBe('missing');
  });

  it('stays connected when the queue cannot be read', async () => {
    install({
      'sftp.queue': async () => {
        throw new Error('later');
      },
    });
    await useSftpStore.getState().connect('srv-1');
    expect(files().status).toBe('ready');
    expect(files().queue).toBeNull();
  });
});

describe('session events', () => {
  beforeEach(async () => {
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.entries).toHaveLength(2));
  });

  it('says the connection closed, and a reconnect goes back to the folder it showed', async () => {
    await useSftpStore.getState().navigate('srv-1', 'remote', '/etc');
    bridge.$emit('sftp.onSessionClosed', {
      sessionId: 'sess-1',
      serverId: 'srv-1',
      reason: 'closed',
    });
    expect(files().status).toBe('error');
    expect(files().session).toBeNull();
    expect(files().error).toBe('The connection to prod closed.');
    expect(toast.info).toHaveBeenCalledWith('The file session on prod closed.');

    bridge.$fn('sftp.list').mockClear();
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(bridge.$fn('sftp.list')).toHaveBeenCalledWith('sess-1', '/etc'));
  });

  it('goes back to Connect, quietly, when another view of the session disconnected it', () => {
    bridge.$emit('sftp.onSessionClosed', {
      sessionId: 'sess-1',
      serverId: 'srv-1',
      reason: 'disconnected',
    });

    expect(files()).toMatchObject({
      status: 'idle',
      session: null,
      error: null,
      queue: null,
      editingPath: null,
      editingFile: null,
      propertiesPaths: null,
    });
    expect(files().remote.entries).toEqual([]);
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows a session handed over by a closing pop-out, queue and folder included', async () => {
    const adopted: SftpSessionInfo = { ...SESSION, sessionId: 'sess-2' };
    const queue: SftpQueueSnapshot = { ...EMPTY_QUEUE, sessionId: 'sess-2' };
    await useSftpStore.getState().disconnect('srv-1');
    bridge.$set('sftp.queue', async (id: string) => (id === 'sess-2' ? queue : EMPTY_QUEUE));
    bridge.$fn('sftp.list').mockClear();

    bridge.$emit('sftp.onSessionAdopted', adopted);

    expect(files()).toMatchObject({ status: 'ready', session: adopted, error: null });
    await waitFor(() => expect(files().queue).toEqual(queue));
    await waitFor(() =>
      expect(bridge.$fn('sftp.list')).toHaveBeenCalledWith('sess-2', '/home/deploy'),
    );
  });

  it('keeps the session it shows when another one is handed over for that server', () => {
    bridge.$emit('sftp.onSessionAdopted', { ...SESSION, sessionId: 'sess-2' });
    bridge.$emit('sftp.onSessionAdopted', SESSION);

    expect(files().session).toEqual(SESSION);
    expect(files().status).toBe('ready');
  });

  it('ignores the close at quit and a close for a session it no longer holds', () => {
    bridge.$emit('sftp.onSessionClosed', {
      sessionId: 'sess-1',
      serverId: 'srv-1',
      reason: 'quit',
    });
    bridge.$emit('sftp.onSessionClosed', { sessionId: 'old', serverId: 'srv-1', reason: 'closed' });
    bridge.$emit('sftp.onSessionClosed', { sessionId: 'old', serverId: 'srv-9', reason: 'closed' });
    expect(files().status).toBe('ready');
    expect(files().session).toEqual(SESSION);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('ignores a finished batch of a session it does not hold', () => {
    bridge.$fn('sftp.list').mockClear();
    bridge.$emit('sftp.onBatchFinished', {
      sessionId: 'other',
      batchId: 'b1',
      kind: 'upload',
      side: 'remote',
      target: '/home/deploy',
      ok: false,
      failed: 1,
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(bridge.$fn('sftp.list')).not.toHaveBeenCalled();
  });

  it('tells about a finished download, and keeps quiet about a finished delete', () => {
    const finished = {
      sessionId: 'sess-1',
      batchId: 'b1',
      side: 'local',
      target: 'D:\\elsewhere',
      ok: true,
      failed: 0,
    };
    bridge.$emit('sftp.onBatchFinished', { ...finished, kind: 'download' });
    expect(toast.success).toHaveBeenCalledWith('Download from prod finished', {
      description: undefined,
    });
    toast.success.mockClear();
    bridge.$emit('sftp.onBatchFinished', { ...finished, kind: 'delete', side: 'remote' });
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('without a session', () => {
  it('says so instead of calling main', async () => {
    const state = useSftpStore.getState();
    expect(await state.transferPaths('srv-1', 'local', ['C:\\x'], '/srv')).toBeNull();
    expect(await state.removeRemote('srv-1', ['/srv/x'])).toBeNull();
    // The queue controls reject instead, so the dialog or the queue says it and unlocks.
    await expect(
      state.resolveConflict('srv-1', 'c1', { action: 'skip', applyToAll: false }),
    ).rejects.toThrow('Not connected to the server.');
    await expect(state.cancel('srv-1', {})).rejects.toThrow('Not connected to the server.');
    await expect(state.retry('srv-1', {})).rejects.toThrow('Not connected to the server.');
    await expect(state.clearFinished('srv-1')).rejects.toThrow('Not connected to the server.');
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledWith('Not connected to the server.');
    await expect(
      state.chmod('srv-1', { paths: ['/srv/x'], mode: 0o600, recursive: 'none' }),
    ).rejects.toThrow('Not connected to the server.');
    for (const path of ['sftp.upload', 'sftp.remove', 'sftp.cancel', 'sftp.chmod']) {
      expect(() => bridge.$fn(path)).toThrow();
    }
  });

  it('shows the problem in the server pane when it is listed', async () => {
    await useSftpStore.getState().navigate('srv-1', 'remote', '/srv');
    expect(files().remote.error).toBe('Not connected to the server.');
    expect(files().remote.errorPath).toBe('/srv');
  });

  it('skips an empty transfer without a word', async () => {
    expect(await useSftpStore.getState().transferPaths('srv-1', 'local', [], '/srv')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('disconnects a server that never connected without calling main', async () => {
    await useSftpStore.getState().disconnect('srv-1');
    expect(files().status).toBe('idle');
    expect(() => bridge.$fn('sftp.close')).toThrow();
  });

  it('does nothing for home, up, refresh or a retry on a pane that shows nothing', async () => {
    const state = useSftpStore.getState();
    await state.home('srv-1', 'remote');
    await state.home('srv-1', 'local');
    await state.up('srv-1', 'local');
    await state.refresh('srv-1', 'remote');
    // A local Retry with nothing listed reads the places again (its own test covers that).
    await state.retryListing('srv-1', 'remote');
    expect(() => bridge.$fn('sftp.list')).toThrow();
    expect(() => bridge.$fn('sftp.localList')).toThrow();
  });

  it('asks the user to connect again before a remote folder op, once the session closed', async () => {
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.path).toBe('/home/deploy'));
    bridge.$emit('sftp.onSessionClosed', {
      sessionId: 'sess-1',
      serverId: 'srv-1',
      reason: 'closed',
    });
    toast.error.mockClear();
    expect(await useSftpStore.getState().mkdir('srv-1', 'remote', 'new')).toBe(false);
    expect(
      await useSftpStore.getState().rename('srv-1', 'remote', '/home/deploy/a.txt', 'c.txt'),
    ).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledWith('Not connected to prod.');
    expect(() => bridge.$fn('sftp.mkdir')).toThrow();
  });
});

describe('the local pane, more', () => {
  it('shows why the places could not be read', async () => {
    install({
      'sftp.localPlaces': async () => {
        throw new Error(encodeFilesError('permissionDenied', ''));
      },
    });
    await useSftpStore.getState().initLocal('srv-1');
    expect(files().local.error).toMatch(/Permission denied/);
    expect(useSftpStore.getState().places).toBeNull();
  });

  it('reads the places again on Retry when they failed and nothing is listed', async () => {
    let fail = true;
    install({
      'sftp.localPlaces': async () => {
        if (fail) throw new Error(encodeFilesError('permissionDenied', ''));
        return [{ id: 'home', label: 'Home', path: 'C:\\Users\\me', kind: 'home' }];
      },
    });
    await useSftpStore.getState().initLocal('srv-1');
    expect(files().local.error).toMatch(/Permission denied/);
    fail = false;
    await useSftpStore.getState().retryListing('srv-1', 'local');
    expect(files().local.path).toBe('C:\\Users\\me');
    expect(files().local.error).toBeNull();
  });

  it('reads the places once and leaves an open pane where it is', async () => {
    await useSftpStore.getState().initLocal('srv-1');
    await useSftpStore.getState().navigate('srv-1', 'local', 'C:\\');
    await useSftpStore.getState().initLocal('srv-1');
    expect(bridge.$fn('sftp.localPlaces')).toHaveBeenCalledTimes(1);
    expect(files().local.path).toBe('C:\\');
  });

  it('starts at the first place when there is no Home, and nowhere with no places', async () => {
    install({
      'sftp.localPlaces': [{ id: 'drive:D', label: 'Data (D:)', path: 'D:\\', kind: 'drive' }],
    });
    await useSftpStore.getState().initLocal('srv-1');
    expect(files().local.path).toBe('D:\\');
    // Home has nowhere to go without a Home place.
    await useSftpStore.getState().home('srv-1', 'local');
    expect(bridge.$fn('sftp.localList')).toHaveBeenCalledTimes(1);

    resetSftpStore();
    install({ 'sftp.localPlaces': [] });
    await useSftpStore.getState().initLocal('srv-1');
    expect(files().local.path).toBeNull();
  });

  it('goes to typed paths, relative or on another drive, up and back home', async () => {
    await useSftpStore.getState().initLocal('srv-1');
    expect(await useSftpStore.getState().goTo('srv-1', 'local', 'photos')).toEqual({
      status: 'ok',
    });
    expect(files().local.path).toBe('C:\\Users\\me\\photos');
    await useSftpStore.getState().goTo('srv-1', 'local', 'd:\\backups');
    expect(files().local.path).toBe('D:\\backups');
    await useSftpStore.getState().up('srv-1', 'local');
    // The fake answers every folder with C:\Users as its parent.
    expect(files().local.path).toBe('C:\\Users');
    await useSftpStore.getState().home('srv-1', 'local');
    expect(files().local.path).toBe('C:\\Users\\me');
  });

  it('ignores a blank typed path', async () => {
    await useSftpStore.getState().initLocal('srv-1');
    expect(await useSftpStore.getState().goTo('srv-1', 'local', '   ')).toEqual({
      status: 'ok',
    });
    expect(bridge.$fn('sftp.localList')).toHaveBeenCalledTimes(1);
  });

  it('resolves a typed path from the root when nothing is open yet', async () => {
    expect(await useSftpStore.getState().goTo('srv-1', 'local', 'tmp')).toEqual({
      status: 'ok',
    });
    expect(files().local.path).toBe('/tmp');
  });

  it('works out the folder above when the listing names no parent', async () => {
    install({
      'sftp.localList': async (path: string) => ({ path, parent: null, entries: [] }),
    });
    await useSftpStore.getState().navigate('srv-1', 'local', 'C:\\Users\\me');
    await useSftpStore.getState().up('srv-1', 'local');
    expect(files().local.path).toBe('C:\\Users');
  });

  it('tries the folder that failed again on refresh and retry', async () => {
    let fail = true;
    install({
      'sftp.localList': async (path: string) => {
        if (fail) throw new Error(encodeFilesError('folderMissing', ''));
        return { path, parent: 'C:\\', entries: [] };
      },
    });
    await useSftpStore.getState().navigate('srv-1', 'local', 'C:\\gone');
    expect(files().local.error).toMatch(/isn't there anymore/);
    expect(files().local.errorPath).toBe('C:\\gone');
    await useSftpStore.getState().refresh('srv-1', 'local');
    expect(bridge.$fn('sftp.localList')).toHaveBeenLastCalledWith('C:\\gone');
    fail = false;
    await useSftpStore.getState().retryListing('srv-1', 'local');
    expect(files().local.path).toBe('C:\\gone');
    expect(files().local.error).toBeNull();
    await useSftpStore.getState().retryListing('srv-1', 'local');
    expect(bridge.$fn('sftp.localList')).toHaveBeenCalledTimes(4);
  });

  it('drops a listing that comes back after a newer one', async () => {
    const pending = new Map<string, (listing: SftpListing<SftpLocalEntry>) => void>();
    install({
      'sftp.localList': (path: string) =>
        new Promise<SftpListing<SftpLocalEntry>>((resolve) => pending.set(path, resolve)),
    });
    const slow = useSftpStore.getState().navigate('srv-1', 'local', 'C:\\slow');
    const fast = useSftpStore.getState().navigate('srv-1', 'local', 'C:\\fast');
    pending.get('C:\\fast')?.({ path: 'C:\\fast', parent: 'C:\\', entries: [] });
    await fast;
    pending.get('C:\\slow')?.({ path: 'C:\\slow', parent: 'C:\\', entries: [] });
    await slow;
    expect(files().local.path).toBe('C:\\fast');
  });

  it('drops a failure that comes back after a newer listing', async () => {
    const pending = new Map<string, { ok: () => void; fail: () => void }>();
    install({
      'sftp.localList': (path: string) =>
        new Promise<SftpListing<SftpLocalEntry>>((resolve, reject) =>
          pending.set(path, {
            ok: () => resolve({ path, parent: 'C:\\', entries: [] }),
            fail: () => reject(new Error('gone')),
          }),
        ),
    });
    const slow = useSftpStore.getState().navigate('srv-1', 'local', 'C:\\slow');
    const fast = useSftpStore.getState().navigate('srv-1', 'local', 'C:\\fast');
    pending.get('C:\\fast')?.ok();
    await fast;
    pending.get('C:\\slow')?.fail();
    await slow;
    expect(files().local.path).toBe('C:\\fast');
    expect(files().local.error).toBeNull();
  });
});

describe('transfers, more', () => {
  it('starts nothing with nothing selected', async () => {
    await useSftpStore.getState().initLocal('srv-1');
    expect(await useSftpStore.getState().transferSelected('srv-1', 'local')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('asks for a folder on the other side first', async () => {
    await useSftpStore.getState().initLocal('srv-1');
    useSftpStore
      .getState()
      .setSelection('srv-1', 'local', { selected: ['notes.txt'], focus: null, anchor: null });
    expect(await useSftpStore.getState().transferSelected('srv-1', 'local')).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('Open a folder on the server first.');

    resetSftpStore();
    install();
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.entries).toHaveLength(2));
    useSftpStore
      .getState()
      .setSelection('srv-1', 'remote', { selected: ['a.txt'], focus: null, anchor: null });
    expect(await useSftpStore.getState().transferSelected('srv-1', 'remote')).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('Open a folder on this computer first.');
  });

  it('says why an upload or a download could not start', async () => {
    install({
      'sftp.upload': async () => {
        throw new Error(encodeFilesError('tooManyFiles', ''));
      },
      'sftp.download': async () => {
        throw new Error(encodeFilesError('permissionDenied', ''));
      },
    });
    await useSftpStore.getState().connect('srv-1');
    expect(
      await useSftpStore.getState().transferPaths('srv-1', 'local', ['C:\\x'], '/home/deploy'),
    ).toBeNull();
    expect(
      await useSftpStore.getState().transferPaths('srv-1', 'remote', ['/home/deploy/a'], 'C:\\'),
    ).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Could not start the upload: That selection holds more/),
    );
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Could not start the download: Permission denied/),
    );
  });
});

describe('file operations, the failures', () => {
  beforeEach(async () => {
    await useSftpStore.getState().initLocal('srv-1');
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.entries).toHaveLength(2));
  });

  it('refuses a bad folder name, and a folder with nowhere to go', async () => {
    expect(await useSftpStore.getState().mkdir('srv-1', 'remote', '..')).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/can't be used as a name/));
    await useSftpStore.getState().disconnect('srv-1');
    expect(await useSftpStore.getState().mkdir('srv-1', 'remote', 'new')).toBe(false);
    expect(() => bridge.$fn('sftp.mkdir')).toThrow();
  });

  it('says why a folder could not be made', async () => {
    install({
      'sftp.mkdir': async () => {
        throw new Error(encodeFilesError('permissionDenied', ''));
      },
    });
    expect(await useSftpStore.getState().mkdir('srv-1', 'remote', 'new')).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Could not create the folder: Permission denied/),
    );
  });

  it('renames on this computer and selects the new name', async () => {
    install({
      'sftp.localRename': async () => 'C:\\Users\\me\\todo.txt',
      'sftp.localList': async (path: string) => ({
        path,
        parent: 'C:\\Users',
        entries: [localEntry('todo.txt', path)],
      }),
    });
    const ok = await useSftpStore
      .getState()
      .rename('srv-1', 'local', 'C:\\Users\\me\\notes.txt', ' todo.txt ');
    expect(ok).toBe(true);
    expect(bridge.$fn('sftp.localRename')).toHaveBeenCalledWith(
      'C:\\Users\\me\\notes.txt',
      'todo.txt',
    );
    expect(files().local.selection.selected).toEqual(['todo.txt']);
  });

  it('says when a rename target is taken, and why any other rename failed', async () => {
    install({
      'sftp.rename': async () => {
        throw new Error(encodeFilesError('exists', ''));
      },
      'sftp.localRename': async () => {
        throw new Error(encodeFilesError('permissionDenied', ''));
      },
    });
    expect(
      await useSftpStore.getState().rename('srv-1', 'remote', '/home/deploy/a.txt', 'b.txt'),
    ).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('"b.txt" is already there. Pick another name.');
    expect(
      await useSftpStore.getState().rename('srv-1', 'local', 'C:\\Users\\me\\notes.txt', 'x'),
    ).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Could not rename: Permission/),
    );
  });

  it('lists the folder of the renamed entry when the pane shows none yet', async () => {
    resetSftpStore();
    install({ 'sftp.localRename': async () => 'C:\\work\\b.txt' });
    expect(await useSftpStore.getState().rename('srv-1', 'local', 'C:\\work\\a.txt', 'b.txt')).toBe(
      true,
    );
    expect(bridge.$fn('sftp.localList')).toHaveBeenCalledWith('C:\\work');
  });

  it('starts no delete for nothing, and says why a delete could not start', async () => {
    expect(await useSftpStore.getState().removeRemote('srv-1', [])).toBeNull();
    install({
      'sftp.remove': async () => {
        throw new Error(encodeFilesError('permissionDenied', ''));
      },
    });
    expect(await useSftpStore.getState().removeRemote('srv-1', ['/home/deploy/a.txt'])).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Could not delete: Permission denied/),
    );
  });

  it('changes permissions when main accepts', async () => {
    const input = { paths: ['/home/deploy/a.txt'], mode: 0o600, recursive: 'none' as const };
    await useSftpStore.getState().chmod('srv-1', input);
    expect(bridge.$fn('sftp.chmod')).toHaveBeenCalledWith('sess-1', input);
  });

  it('hands a queue control failure back untouched, without a toast of its own', async () => {
    install({
      'sftp.cancel': async () => {
        throw new Error(encodeFilesError('server', 'No such batch'));
      },
      'sftp.resolveConflict': async () => {
        throw new Error(encodeFilesError('invalidInput', 'Unknown conflict'));
      },
    });
    await expect(useSftpStore.getState().cancel('srv-1', { batchId: 'b9' })).rejects.toThrow(
      '[files:server] No such batch',
    );
    await expect(
      useSftpStore.getState().resolveConflict('srv-1', 'c9', { action: 'skip', applyToAll: false }),
    ).rejects.toThrow('Unknown conflict');
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('the conflict answer asked for', () => {
  const CONFLICT = {
    conflictId: 'c1',
    batchId: 'b1',
    itemId: 'i1',
    direction: 'upload' as const,
    name: 'index.html',
    relPath: 'index.html',
    targetDir: '/home/deploy',
    source: { size: 1, mtimeMs: 1 },
    target: { size: 2, mtimeMs: 2, isDirectory: false },
    renameTo: 'index (1).html',
    remainingInBatch: 0,
  };

  beforeEach(async () => {
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.entries).toHaveLength(2));
  });

  it('points at a server only while it has a conflict to answer', () => {
    useSftpStore.getState().requestAnswer('srv-1');
    expect(useSftpStore.getState().conflictFocus).toBeNull();
    useSftpStore.getState().requestAnswer('srv-9');
    expect(useSftpStore.getState().conflictFocus).toBeNull();

    bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, conflict: CONFLICT });
    useSftpStore.getState().requestAnswer('srv-1');
    expect(useSftpStore.getState().conflictFocus).toBe('srv-1');
  });

  it('keeps pointing while the next conflict of the server comes, and lets go once none is left', () => {
    bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, conflict: CONFLICT });
    useSftpStore.getState().requestAnswer('srv-1');
    bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, conflict: { ...CONFLICT, conflictId: 'c2' } });
    expect(useSftpStore.getState().conflictFocus).toBe('srv-1');
    bridge.$emit('sftp.onQueue', EMPTY_QUEUE);
    expect(useSftpStore.getState().conflictFocus).toBeNull();
  });

  it("leaves another server's focus alone when this one's conflict clears", () => {
    useSftpStore.setState((state) => ({
      conflictFocus: 'srv-2',
      servers: {
        ...state.servers,
        'srv-2': { ...serverFiles(state, 'srv-2'), queue: { ...EMPTY_QUEUE, conflict: CONFLICT } },
      },
    }));
    bridge.$emit('sftp.onQueue', EMPTY_QUEUE);
    expect(useSftpStore.getState().conflictFocus).toBe('srv-2');
  });

  it('lets go when the session ends, by a disconnect or from main', async () => {
    bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, conflict: CONFLICT });
    useSftpStore.getState().requestAnswer('srv-1');
    await useSftpStore.getState().disconnect('srv-1');
    expect(useSftpStore.getState().conflictFocus).toBeNull();

    await useSftpStore.getState().connect('srv-1');
    bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, conflict: CONFLICT });
    useSftpStore.getState().requestAnswer('srv-1');
    bridge.$emit('sftp.onSessionClosed', {
      sessionId: 'sess-1',
      serverId: 'srv-1',
      reason: 'closed',
    });
    expect(useSftpStore.getState().conflictFocus).toBeNull();
  });

  it('is cleared by a reset', () => {
    bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, conflict: CONFLICT });
    useSftpStore.getState().requestAnswer('srv-1');
    resetSftpStore();
    expect(useSftpStore.getState().conflictFocus).toBeNull();
  });
});

describe('what the remote side allows (E27)', () => {
  const LIMITATION = 'The container is stopped. Start it to rename, delete or change permissions.';
  const LIMITED: SftpSessionInfo = {
    ...SESSION,
    kind: 'container',
    capabilities: { rename: false, remove: false, chmod: false, edit: false },
    limitation: LIMITATION,
  };

  beforeEach(async () => {
    install({ 'sftp.open': LIMITED });
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.entries).toHaveLength(2));
  });

  it('never opens the editor, and says why without reading the file', async () => {
    await useSftpStore.getState().openEditor('srv-1', '/home/deploy/a.txt');
    expect(files().editingPath).toBeNull();
    expect(() => bridge.$fn('sftp.readText')).toThrow();
    expect(toast.error).toHaveBeenCalledWith("Can't edit a.txt here", {
      description: LIMITATION,
    });
  });

  it('refuses a rename, a delete and a chmod without asking main', async () => {
    const state = useSftpStore.getState();
    expect(await state.rename('srv-1', 'remote', '/home/deploy/a.txt', 'c.txt')).toBe(false);
    expect(await state.removeRemote('srv-1', ['/home/deploy/a.txt'])).toBeNull();
    await expect(
      state.chmod('srv-1', { paths: ['/home/deploy/a.txt'], mode: 0o600, recursive: 'none' }),
    ).rejects.toThrow(LIMITATION);
    expect(toast.error).toHaveBeenCalledWith(LIMITATION);
    for (const path of ['sftp.rename', 'sftp.remove', 'sftp.chmod']) {
      expect(() => bridge.$fn(path)).toThrow();
    }
  });

  it('still renames on this computer', async () => {
    install({
      'sftp.localRename': async () => 'C:\Users\me\renamed.txt',
    });
    await useSftpStore.getState().initLocal('srv-1');
    expect(
      await useSftpStore
        .getState()
        .rename('srv-1', 'local', 'C:\Users\me\notes.txt', 'renamed.txt'),
    ).toBe(true);
  });
});

describe('a partial listing (E27)', () => {
  it('keeps the mark from main, and drops it on a listing that is whole', async () => {
    install({
      'sftp.list': async (_s: string, path: string) => ({
        ...remoteListing(path === '~' ? '/home/deploy' : path, ['a.txt']),
        partial: path !== '/srv',
      }),
    });
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.path).toBe('/home/deploy'));
    expect(files().remote.partial).toBe(true);
    await useSftpStore.getState().navigate('srv-1', 'remote', '/srv');
    expect(files().remote.partial).toBe(false);
  });

  it('counts a listing without the mark as whole', async () => {
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(files().remote.path).toBe('/home/deploy'));
    expect(files().remote.partial).toBe(false);
  });
});

describe('a container or volume on a Deploy server (E27)', () => {
  const TARGET = 'docker~srv-1~container~web-1';
  const DOCKER_SESSION: SftpSessionInfo = {
    ...SESSION,
    serverId: TARGET,
    nickname: 'web-1 (container)',
    host: 'prod',
    port: 0,
    username: 'root',
    home: '/',
    kind: 'container',
  };
  const target = () => serverFiles(useSftpStore.getState(), TARGET);

  it('opens without looking for a saved server of that id', async () => {
    install({ 'sftp.open': DOCKER_SESSION });
    await useSftpStore.getState().connect(TARGET);
    expect(target().status).toBe('ready');
    expect(bridge.$fn('sftp.open')).toHaveBeenCalledWith(TARGET);
    expect(() => bridge.$fn('ssh.listServers')).toThrow();
    expect(target().session?.nickname).toBe('web-1 (container)');
  });

  it('says missing when main no longer knows the container', async () => {
    install({
      'sftp.open': async () => {
        throw new Error(encodeFilesError('siteUnknown', 'gone'));
      },
    });
    await useSftpStore.getState().connect(TARGET);
    expect(target().status).toBe('missing');
    expect(target().server?.nickname).toBe('web-1');
  });
});
