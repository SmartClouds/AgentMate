import type { SshSavedServer } from '@shared/apiTypes';
import { encodeFilesError } from '@shared/deployFilesErrors';
import type {
  SftpListing,
  SftpLocalEntry,
  SftpRemoteEntry,
  SftpSessionInfo,
} from '@shared/sftpTypes';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SFTP_DND_MIME } from '@/lib/sftp/dnd';
import { resolveConfirm, useConfirmStore } from '@/stores/confirmStore';
import { resetSftpStore, serverFiles, useSftpStore } from '@/stores/sftpStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { BridgeOverrides } from '../../../../test/renderer/runovaBridge';
import { FilePane } from './FilePane';

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

/**
 * One pane of the SFTP file manager (E25), for either side: a sortable grid with a path bar,
 * keyboard and mouse selection, drag and drop between the panes and from the OS, a context menu,
 * and the inline new folder, rename and delete flows.
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

function remoteEntry(dir: string, name: string, extra: Partial<SftpRemoteEntry> = {}) {
  const isDirectory = extra.isDirectory ?? false;
  return {
    name,
    path: `${dir === '/' ? '' : dir}/${name}`,
    kind: isDirectory ? 'dir' : 'file',
    isDirectory,
    isSymlink: false,
    size: isDirectory ? 0 : 1024,
    mtimeMs: 1_700_000_000_000,
    mode: isDirectory ? 0o755 : 0o644,
    owner: 'deploy',
    group: 'deploy',
    ...extra,
  } satisfies SftpRemoteEntry;
}

const REMOTE: Record<string, SftpRemoteEntry[]> = {
  '/home/deploy': [
    remoteEntry('/home/deploy', 'site', { isDirectory: true }),
    remoteEntry('/home/deploy', 'b.txt', { size: 5000 }),
    remoteEntry('/home/deploy', 'a.txt', { size: 10 }),
    remoteEntry('/home/deploy', '.env'),
    remoteEntry('/home/deploy', 'dead', { kind: 'link', isSymlink: true, mode: 0o777 }),
  ],
  '/var': [remoteEntry('/var', 'www', { isDirectory: true })],
  '/home': [remoteEntry('/home', 'deploy', { isDirectory: true })],
  '/empty': [],
};

function parentOf(path: string): string | null {
  if (path === '/') return null;
  const up = path.slice(0, path.lastIndexOf('/'));
  return up === '' ? '/' : up;
}

function localEntry(name: string, isDirectory = false): SftpLocalEntry {
  return {
    name,
    path: `C:\\Users\\me\\${name}`,
    isDirectory,
    isSymlink: false,
    size: isDirectory ? 0 : 2048,
    mtimeMs: 1_700_000_000_000,
    mode: null,
    hidden: false,
  };
}

function defaults(): BridgeOverrides {
  return {
    'ssh.listServers': [SERVER],
    'sftp.open': SESSION,
    'sftp.queue': { sessionId: 'sess-1', batches: [], conflict: null, pendingConflicts: 0 },
    'sftp.list': async (_session: string, path: string): Promise<SftpListing<SftpRemoteEntry>> => {
      const resolved = path === '~' ? '/home/deploy' : path;
      const entries = REMOTE[resolved];
      if (!entries) throw new Error(encodeFilesError('remoteFolderMissing', ''));
      return { path: resolved, parent: parentOf(resolved), entries };
    },
    'sftp.localPlaces': [
      { id: 'home', label: 'Home', path: 'C:\\Users\\me', kind: 'home' },
      { id: 'drive:C', label: 'Local Disk (C:)', path: 'C:\\', kind: 'drive' },
    ],
    'sftp.localList': async (path: string) => ({
      path,
      parent: 'C:\\Users',
      entries: [localEntry('notes.txt'), localEntry('photos', true)],
    }),
    'sftp.upload': async () => ({ batchId: 'up-1' }),
    'sftp.download': async () => ({ batchId: 'down-1' }),
    'sftp.remove': async () => ({ batchId: 'del-1' }),
    'shell.pathForFile': (file: File) => `D:\\dropped\\${file.name}`,
  };
}

async function setup(overrides: BridgeOverrides = {}, firstRow = 'a.txt') {
  const view = renderWithProviders(
    <div>
      <FilePane serverId="srv-1" side="local" />
      <FilePane serverId="srv-1" side="remote" />
    </div>,
    { bridge: { ...defaults(), ...overrides } },
  );
  await act(async () => {
    await useSftpStore.getState().initLocal('srv-1');
    await useSftpStore.getState().connect('srv-1');
  });
  await screen.findByRole('grid', { name: 'Files on prod' });
  await waitFor(() => expect(remoteRow(firstRow)).toBeTruthy());
  return view;
}

const remoteGrid = () => screen.getByRole('grid', { name: 'Files on prod' });
const localGrid = () => screen.getByRole('grid', { name: 'Files on this computer' });
const remoteRow = (name: string) =>
  screen
    .queryByRole('grid', { name: 'Files on prod' })
    ?.querySelector(`[data-sftp-row="${name}"]`) as HTMLElement | null;
const localRow = (name: string) =>
  localGrid().querySelector(`[data-sftp-row="${name}"]`) as HTMLElement;
const rowNames = (grid: HTMLElement) =>
  Array.from(grid.querySelectorAll('[data-sftp-row]')).map((row) =>
    row.getAttribute('data-sftp-row'),
  );
const files = () => serverFiles(useSftpStore.getState(), 'srv-1');
const remotePane = () => screen.getByRole('region', { name: 'Server prod' });
const localPane = () => screen.getByRole('region', { name: 'This computer' });

/** jsdom has no DataTransfer, so a small one that behaves like Chromium's. */
function fakeTransfer(osFiles: File[] = []) {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    files: osFiles,
    get types() {
      return [...data.keys(), ...(osFiles.length > 0 ? ['Files'] : [])];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  };
}

beforeEach(() => {
  resetSftpStore();
  toast.info.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('listing', () => {
  it('shows folders first, hides dot files, and marks a broken link', async () => {
    await setup();
    expect(rowNames(remoteGrid())).toEqual(['site', 'a.txt', 'b.txt', 'dead']);
    expect(within(remoteRow('dead') as HTMLElement).getByLabelText('Broken link')).toBeTruthy();
    expect(within(remoteRow('a.txt') as HTMLElement).getByText('-rw-r--r--')).toBeTruthy();
    expect(within(remoteRow('site') as HTMLElement).getByText('drwxr-xr-x')).toBeTruthy();
  });

  it('sorts by a header and reverses on a second click', async () => {
    const { user } = await setup();
    const size = within(remoteGrid()).getByRole('columnheader', { name: 'Size' });
    expect(size.getAttribute('aria-sort')).toBe('none');
    await user.click(within(size).getByRole('button'));
    expect(size.getAttribute('aria-sort')).toBe('ascending');
    expect(rowNames(remoteGrid())).toEqual(['site', 'a.txt', 'dead', 'b.txt']);
    await user.click(within(size).getByRole('button'));
    expect(size.getAttribute('aria-sort')).toBe('descending');
    expect(rowNames(remoteGrid())).toEqual(['site', 'b.txt', 'dead', 'a.txt']);
  });

  it('shows hidden files on request and filters by name', async () => {
    const { user } = await setup();
    const pane = within(remotePane());
    await user.click(pane.getByRole('button', { name: 'Show hidden files' }));
    expect(rowNames(remoteGrid())).toContain('.env');
    expect(
      pane.getByRole('button', { name: 'Hide hidden files' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await user.type(pane.getByRole('textbox', { name: 'Filter files on the server' }), 'b.t');
    expect(rowNames(remoteGrid())).toEqual(['b.txt']);
    await user.clear(pane.getByRole('textbox', { name: 'Filter files on the server' }));
    await user.type(pane.getByRole('textbox', { name: 'Filter files on the server' }), 'zzz');
    expect(pane.getByText(/Nothing matches/)).toBeTruthy();
  });

  it('counts the selection in the footer', async () => {
    const { user } = await setup();
    expect(within(remotePane()).getByText('4 items')).toBeTruthy();
    await user.click(remoteRow('b.txt') as HTMLElement);
    fireEvent.click(remoteRow('a.txt') as HTMLElement, { ctrlKey: true });
    expect(within(remotePane()).getByText(/2 of 4 selected, 4\.\d+ KB/)).toBeTruthy();
  });

  it('names every toolbar button', async () => {
    await setup();
    const pane = within(remotePane());
    for (const name of [
      'Up one folder',
      'Home folder on the server',
      'Refresh',
      'New folder',
      'Download to this computer',
      'Show hidden files',
    ]) {
      expect(pane.getByRole('button', { name })).toBeTruthy();
    }
    const local = within(localPane());
    for (const name of ['Places', 'Upload to server', 'Home folder']) {
      expect(local.getByRole('button', { name })).toBeTruthy();
    }
    expect(
      (pane.getByRole('button', { name: 'Download to this computer' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('shows the empty state, the shimmer, and an error with a retry', async () => {
    let fail = true;
    const { user } = await setup({
      'sftp.localList': async (path: string) => {
        if (fail) throw new Error(encodeFilesError('folderMissing', ''));
        return { path, parent: 'C:\\', entries: [] };
      },
    });
    // The local pane never listed: its problem fills it, with a retry.
    const local = within(localPane());
    expect(local.getByRole('alert').textContent).toMatch(/isn't there anymore/);
    fail = false;
    await user.click(local.getByRole('button', { name: 'Try again' }));
    expect(await local.findByText('This folder is empty')).toBeTruthy();

    await act(async () => {
      await useSftpStore.getState().navigate('srv-1', 'remote', '/empty');
    });
    expect(within(remotePane()).getByText('This folder is empty')).toBeTruthy();

    act(() => {
      useSftpStore.setState((state) => ({
        servers: {
          ...state.servers,
          'srv-1': {
            ...files(),
            local: { ...files().local, path: null, error: null, entries: [], loading: true },
          },
        },
      }));
    });
    expect(local.getByRole('status', { name: 'Loading the folder' })).toBeTruthy();
  });
});

describe('the path bar', () => {
  it('goes where a breadcrumb points', async () => {
    const { user, bridge } = await setup();
    const crumbs = within(remotePane()).getByRole('navigation', { name: 'Folder on the server' });
    await user.click(within(crumbs).getByRole('button', { name: 'home' }));
    expect(bridge.$fn('sftp.list')).toHaveBeenLastCalledWith('sess-1', '/home');
    await waitFor(() => expect(files().remote.path).toBe('/home'));
  });

  it('turns into a field on a click in the empty space; Enter goes, Escape puts it back', async () => {
    const { user, bridge } = await setup();
    await user.click(screen.getByTestId('remote-path-space'));
    const field = within(remotePane()).getByRole('textbox', { name: 'Folder on the server' });
    expect((field as HTMLInputElement).value).toBe('/home/deploy');
    await user.clear(field);
    await user.type(field, '/var{Enter}');
    expect(bridge.$fn('sftp.list')).toHaveBeenLastCalledWith('sess-1', '/var');
    await waitFor(() => expect(files().remote.path).toBe('/var'));
    expect(
      within(remotePane()).queryByRole('textbox', { name: 'Folder on the server' }),
    ).toBeNull();

    await user.click(screen.getByTestId('remote-path-space'));
    const again = within(remotePane()).getByRole('textbox', { name: 'Folder on the server' });
    await user.type(again, 'xyz{Escape}');
    expect(
      within(remotePane()).queryByRole('textbox', { name: 'Folder on the server' }),
    ).toBeNull();
    expect(files().remote.path).toBe('/var');
  });

  it('keeps the field open with the reason when the path fails, and the pane stays', async () => {
    const { user } = await setup();
    remoteGrid().focus();
    fireEvent.keyDown(remoteGrid(), { key: 'l', ctrlKey: true });
    const field = within(remotePane()).getByRole('textbox', { name: 'Folder on the server' });
    await user.clear(field);
    await user.type(field, 'missing{Enter}');
    expect((await within(remotePane()).findByRole('alert')).textContent).toMatch(/doesn't exist/);
    expect(files().remote.path).toBe('/home/deploy');
    expect(rowNames(remoteGrid())).toContain('a.txt');
  });
});

describe('the path bar, overtaken', () => {
  it('keeps the field open without an error when another navigation takes over', async () => {
    const pending = new Map<string, () => void>();
    const { user } = await setup();
    const list = defaults()['sftp.list'] as (s: string, p: string) => Promise<unknown>;
    act(() => {
      (window.runova as unknown as { $set: (p: string, v: unknown) => void }).$set(
        'sftp.list',
        (session: string, path: string) =>
          new Promise((resolve) => pending.set(path, () => resolve(list(session, path)))),
      );
    });
    await user.click(screen.getByTestId('remote-path-space'));
    const field = within(remotePane()).getByRole('textbox', { name: 'Folder on the server' });
    await user.clear(field);
    await user.type(field, '/var{Enter}');
    // A breadcrumb-style navigation elsewhere wins the race.
    const other = useSftpStore.getState().navigate('srv-1', 'remote', '/home');
    await act(async () => {
      pending.get('/home')?.();
      await other;
      pending.get('/var')?.();
    });
    await waitFor(() => expect(files().remote.path).toBe('/home'));
    expect(
      within(remotePane()).getByRole('textbox', { name: 'Folder on the server' }),
    ).toBeTruthy();
    expect(within(remotePane()).queryByRole('alert')).toBeNull();
  });
});

describe('keyboard', () => {
  it('moves with the arrows, extends with Shift, selects all and clears', async () => {
    await setup();
    const grid = remoteGrid();
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(files().remote.selection.selected).toEqual(['site']);
    const active = grid.getAttribute('aria-activedescendant');
    expect(active && document.getElementById(active)?.getAttribute('data-sftp-row')).toBe('site');
    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true });
    expect(files().remote.selection.selected).toEqual(['site', 'a.txt']);
    fireEvent.keyDown(grid, { key: 'End' });
    expect(files().remote.selection.selected).toEqual(['dead']);
    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true });
    expect(files().remote.selection.selected).toHaveLength(4);
    fireEvent.keyDown(grid, { key: 'Escape' });
    expect(files().remote.selection.selected).toEqual([]);
    expect(grid.getAttribute('aria-multiselectable')).toBe('true');
  });

  it('opens a folder with Enter and goes up with Backspace', async () => {
    const { bridge } = await setup();
    const grid = remoteGrid();
    grid.focus();
    fireEvent.keyDown(grid, { key: 'Home' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(bridge.$fn('sftp.list')).toHaveBeenLastCalledWith('sess-1', '/home/deploy/site');
    fireEvent.keyDown(grid, { key: 'Backspace' });
    expect(bridge.$fn('sftp.list')).toHaveBeenLastCalledWith('sess-1', '/home');
  });

  it('sends a file to the other pane with Enter or a double-click', async () => {
    const { bridge, user } = await setup();
    const grid = remoteGrid();
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(bridge.$fn('sftp.download')).toHaveBeenCalledWith('sess-1', {
      remotePaths: ['/home/deploy/a.txt'],
      localDir: 'C:\\Users\\me',
    });
    await user.dblClick(localRow('notes.txt'));
    expect(bridge.$fn('sftp.upload')).toHaveBeenCalledWith('sess-1', {
      localPaths: ['C:\\Users\\me\\notes.txt'],
      remoteDir: '/home/deploy',
    });
  });

  it('refreshes with F5 and opens the path field with Ctrl+L', async () => {
    const { bridge } = await setup();
    const grid = remoteGrid();
    bridge.$fn('sftp.list').mockClear();
    fireEvent.keyDown(grid, { key: 'F5' });
    expect(bridge.$fn('sftp.list')).toHaveBeenCalledWith('sess-1', '/home/deploy');
    fireEvent.keyDown(grid, { key: 'l', ctrlKey: true });
    expect(
      within(remotePane()).getByRole('textbox', { name: 'Folder on the server' }),
    ).toBeTruthy();
  });
});

describe('switching panes', () => {
  it('moves between the panes with Tab and Shift+Tab, both ways', async () => {
    await setup();
    localGrid().focus();
    fireEvent.keyDown(localGrid(), { key: 'Tab' });
    expect(document.activeElement).toBe(remoteGrid());
    fireEvent.keyDown(remoteGrid(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(localGrid());
    fireEvent.keyDown(localGrid(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(remoteGrid());
    fireEvent.keyDown(remoteGrid(), { key: 'Tab' });
    expect(document.activeElement).toBe(localGrid());
  });
});

describe('scrolling', () => {
  /** jsdom keeps no scroll position, so the list body gets one of its own. */
  function scrollable(): { body: HTMLElement; top: () => number } {
    const body = remoteGrid().querySelectorAll('[role="rowgroup"]')[1] as HTMLElement;
    let top = 0;
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    return { body, top: () => top };
  }

  it('starts a new folder at the top, but keeps the place on a refresh', async () => {
    await setup();
    const { body, top } = scrollable();
    body.scrollTop = 120;
    await act(async () => {
      await useSftpStore.getState().refresh('srv-1', 'remote');
    });
    expect(top()).toBe(120);
    await act(async () => {
      await useSftpStore.getState().navigate('srv-1', 'remote', '/var');
    });
    expect(top()).toBe(0);
  });
});

describe('mouse selection', () => {
  it('selects with a click, toggles with Ctrl and extends with Shift', async () => {
    await setup();
    fireEvent.click(remoteRow('site') as HTMLElement);
    expect(files().remote.selection.selected).toEqual(['site']);
    fireEvent.click(remoteRow('b.txt') as HTMLElement, { shiftKey: true });
    expect(files().remote.selection.selected).toEqual(['site', 'a.txt', 'b.txt']);
    fireEvent.click(remoteRow('a.txt') as HTMLElement, { ctrlKey: true });
    expect(files().remote.selection.selected).toEqual(['site', 'b.txt']);
    expect(remoteRow('site')?.getAttribute('aria-selected')).toBe('true');
    expect(remoteRow('a.txt')?.getAttribute('aria-selected')).toBe('false');
  });
});

describe('drag and drop', () => {
  it('puts the paths on the custom MIME type when a row is dragged', async () => {
    await setup();
    fireEvent.click(remoteRow('a.txt') as HTMLElement);
    fireEvent.click(remoteRow('b.txt') as HTMLElement, { ctrlKey: true });
    const transfer = fakeTransfer();
    fireEvent.dragStart(remoteRow('a.txt') as HTMLElement, { dataTransfer: transfer });
    expect(JSON.parse(transfer.getData(SFTP_DND_MIME))).toEqual({
      serverId: 'srv-1',
      side: 'remote',
      paths: ['/home/deploy/a.txt', '/home/deploy/b.txt'],
    });
  });

  it("downloads rows dropped on the other pane into that pane's folder, with a highlight", async () => {
    const { bridge } = await setup();
    const transfer = fakeTransfer();
    fireEvent.dragStart(remoteRow('a.txt') as HTMLElement, { dataTransfer: transfer });
    fireEvent.dragOver(localGrid(), { dataTransfer: transfer });
    expect(localPane().getAttribute('data-drop-target')).toBe('pane');
    expect(localPane().className).toMatch(/ring-primary/);
    fireEvent.drop(localGrid(), { dataTransfer: transfer });
    expect(bridge.$fn('sftp.download')).toHaveBeenCalledWith('sess-1', {
      remotePaths: ['/home/deploy/a.txt'],
      localDir: 'C:\\Users\\me',
    });
    expect(localPane().getAttribute('data-drop-target')).toBeNull();
  });

  it('uploads into a folder row it was dropped on', async () => {
    const { bridge } = await setup();
    const transfer = fakeTransfer();
    fireEvent.dragStart(localRow('notes.txt'), { dataTransfer: transfer });
    fireEvent.dragOver(remoteRow('site') as HTMLElement, { dataTransfer: transfer });
    expect(remoteRow('site')?.className).toMatch(/ring-primary/);
    fireEvent.drop(remoteRow('site') as HTMLElement, { dataTransfer: transfer });
    expect(bridge.$fn('sftp.upload')).toHaveBeenCalledWith('sess-1', {
      localPaths: ['C:\\Users\\me\\notes.txt'],
      remoteDir: '/home/deploy/site',
    });
  });

  it('uploads OS files dropped on the server pane', async () => {
    const { bridge } = await setup();
    const transfer = fakeTransfer([new File(['x'], 'photo.png')]);
    fireEvent.dragOver(remoteGrid(), { dataTransfer: transfer });
    fireEvent.drop(remoteGrid(), { dataTransfer: transfer });
    expect(bridge.$fn('sftp.upload')).toHaveBeenCalledWith('sess-1', {
      localPaths: ['D:\\dropped\\photo.png'],
      remoteDir: '/home/deploy',
    });
  });

  it('ignores a drop on the pane it came from, and OS files on the local pane', async () => {
    const { bridge } = await setup();
    const transfer = fakeTransfer();
    fireEvent.dragStart(remoteRow('a.txt') as HTMLElement, { dataTransfer: transfer });
    fireEvent.dragOver(remoteRow('site') as HTMLElement, { dataTransfer: transfer });
    expect(remoteRow('site')?.className).not.toMatch(/ring-primary/);
    fireEvent.drop(remoteGrid(), { dataTransfer: transfer });
    const os = fakeTransfer([new File(['x'], 'photo.png')]);
    fireEvent.drop(localGrid(), { dataTransfer: os });
    expect(() => bridge.$fn('sftp.download')).toThrow();
    expect(() => bridge.$fn('sftp.upload')).toThrow();
  });
});

describe('new folder, rename and delete', () => {
  it('makes a folder from the inline field', async () => {
    const { user, bridge } = await setup({ 'sftp.mkdir': async () => '/home/deploy/new' });
    await user.click(within(remotePane()).getByRole('button', { name: 'New folder' }));
    const field = within(remotePane()).getByRole('textbox', { name: 'New folder name' });
    await user.type(field, 'new{Enter}');
    expect(bridge.$fn('sftp.mkdir')).toHaveBeenCalledWith('sess-1', '/home/deploy', 'new');
    await waitFor(() =>
      expect(within(remotePane()).queryByRole('textbox', { name: 'New folder name' })).toBeNull(),
    );
  });

  it('keeps the field open when the name is taken', async () => {
    const { user } = await setup({
      'sftp.mkdir': async () => {
        throw new Error(encodeFilesError('exists', ''));
      },
    });
    await user.click(within(remotePane()).getByRole('button', { name: 'New folder' }));
    await user.type(
      within(remotePane()).getByRole('textbox', { name: 'New folder name' }),
      'site{Enter}',
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('"site" is already there. Pick another name.'),
    );
    expect(within(remotePane()).getByRole('textbox', { name: 'New folder name' })).toBeTruthy();
  });

  it('cancels the rename on Escape without renaming', async () => {
    const { user, bridge } = await setup({ 'sftp.rename': async () => '/home/deploy/c.txt' });
    fireEvent.click(remoteRow('a.txt') as HTMLElement);
    fireEvent.keyDown(remoteGrid(), { key: 'F2' });
    const field = within(remotePane()).getByRole('textbox', { name: 'New name for a.txt' });
    await user.clear(field);
    await user.type(field, 'c.txt{Escape}');
    await waitFor(() =>
      expect(
        within(remotePane()).queryByRole('textbox', { name: 'New name for a.txt' }),
      ).toBeNull(),
    );
    expect(() => bridge.$fn('sftp.rename')).toThrow();
    expect(document.activeElement).toBe(remoteGrid());
  });

  it('cancels the new folder on Escape without making it', async () => {
    const { user, bridge } = await setup({ 'sftp.mkdir': async () => '/home/deploy/oops' });
    await user.click(within(remotePane()).getByRole('button', { name: 'New folder' }));
    await user.type(
      within(remotePane()).getByRole('textbox', { name: 'New folder name' }),
      'oops{Escape}',
    );
    await waitFor(() =>
      expect(within(remotePane()).queryByRole('textbox', { name: 'New folder name' })).toBeNull(),
    );
    expect(() => bridge.$fn('sftp.mkdir')).toThrow();
  });

  it('renames once on Enter, without a second rename when the field closes', async () => {
    const { user, bridge } = await setup({ 'sftp.rename': async () => '/home/deploy/c.txt' });
    fireEvent.click(remoteRow('a.txt') as HTMLElement);
    fireEvent.keyDown(remoteGrid(), { key: 'F2' });
    const field = within(remotePane()).getByRole('textbox', { name: 'New name for a.txt' });
    await user.clear(field);
    await user.type(field, 'c.txt{Enter}');
    await waitFor(() =>
      expect(
        within(remotePane()).queryByRole('textbox', { name: 'New name for a.txt' }),
      ).toBeNull(),
    );
    expect(bridge.$fn('sftp.rename')).toHaveBeenCalledTimes(1);
  });

  it('renames with F2', async () => {
    const { user, bridge } = await setup({ 'sftp.rename': async () => '/home/deploy/c.txt' });
    fireEvent.click(remoteRow('a.txt') as HTMLElement);
    fireEvent.keyDown(remoteGrid(), { key: 'F2' });
    const field = within(remotePane()).getByRole('textbox', { name: 'New name for a.txt' });
    await user.clear(field);
    await user.type(field, 'c.txt{Enter}');
    expect(bridge.$fn('sftp.rename')).toHaveBeenCalledWith('sess-1', '/home/deploy/a.txt', 'c.txt');
  });

  it('asks before a remote delete, listing the names, and deletes on yes', async () => {
    const { bridge } = await setup();
    fireEvent.click(remoteRow('a.txt') as HTMLElement);
    fireEvent.click(remoteRow('b.txt') as HTMLElement, { ctrlKey: true });
    fireEvent.keyDown(remoteGrid(), { key: 'Delete' });
    const question = useConfirmStore.getState();
    expect(question.open).toBe(true);
    expect(question.title).toBe('Delete 2 items from prod?');
    expect(question.items?.map((item) => item.name)).toEqual(['a.txt', 'b.txt']);
    expect(question.description).toMatch(/for good/);
    expect(question.typeToConfirm).toBeUndefined();
    await act(async () => resolveConfirm(true));
    expect(bridge.$fn('sftp.remove')).toHaveBeenCalledWith('sess-1', [
      '/home/deploy/a.txt',
      '/home/deploy/b.txt',
    ]);
  });

  it('asks to type delete for a shallow folder such as /var/www', async () => {
    await setup();
    await act(async () => {
      await useSftpStore.getState().navigate('srv-1', 'remote', '/var');
    });
    fireEvent.click(remoteRow('www') as HTMLElement);
    fireEvent.keyDown(remoteGrid(), { key: 'Delete' });
    expect(useConfirmStore.getState().typeToConfirm).toBe('delete');
    await act(async () => resolveConfirm(false));
  });

  it('lists ten names and counts the rest', async () => {
    const many = Array.from({ length: 13 }, (_, i) => remoteEntry('/home/deploy', `f${i}.txt`));
    await setup(
      {
        'sftp.list': async (_s: string, path: string) => ({ path, parent: '/home', entries: many }),
      },
      'f0.txt',
    );
    fireEvent.keyDown(remoteGrid(), { key: 'a', ctrlKey: true });
    fireEvent.keyDown(remoteGrid(), { key: 'Delete' });
    expect(useConfirmStore.getState().items).toHaveLength(10);
    expect(useConfirmStore.getState().moreCount).toBe(3);
    await act(async () => resolveConfirm(false));
  });

  it('offers to delete permanently when the Trash fails', async () => {
    const { bridge } = await setup({
      'sftp.localDelete': async (_paths: string[], options: { permanent: boolean }) => {
        if (!options.permanent) throw new Error('No Trash on this drive');
      },
    });
    fireEvent.click(localRow('notes.txt'));
    fireEvent.keyDown(localGrid(), { key: 'Delete' });
    expect(useConfirmStore.getState().title).toBe('Move "notes.txt" to the Trash?');
    await act(async () => resolveConfirm(true));
    await waitFor(() => expect(useConfirmStore.getState().confirmLabel).toBe('Delete permanently'));
    expect(useConfirmStore.getState().description).toMatch(/No Trash on this drive/);
    await act(async () => resolveConfirm(true));
    await waitFor(() =>
      expect(bridge.$fn('sftp.localDelete')).toHaveBeenLastCalledWith(
        ['C:\\Users\\me\\notes.txt'],
        {
          permanent: true,
        },
      ),
    );
  });
});

describe('the context menu', () => {
  it('offers the remote actions for a file', async () => {
    await setup();
    fireEvent.contextMenu(remoteRow('a.txt') as HTMLElement);
    const menu = await screen.findByRole('menu');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(items).toEqual([
      'Download',
      'Edit',
      'RenameF2',
      'DeleteDel',
      'New folder',
      'Permissions and properties',
      'Copy path',
      'RefreshF5',
    ]);
    expect(files().remote.selection.selected).toEqual(['a.txt']);
  });

  it('opens the editor and the properties from the menu', async () => {
    const { user } = await setup({
      'sftp.readText': async (_s: string, path: string) => ({
        path,
        content: 'hi',
        size: 2,
        mtimeMs: 1,
        mode: 0o644,
        bom: false,
      }),
    });
    fireEvent.contextMenu(remoteRow('a.txt') as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    await waitFor(() => expect(files().editingPath).toBe('/home/deploy/a.txt'));
    fireEvent.contextMenu(remoteRow('b.txt') as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Permissions and properties' }));
    expect(files().propertiesPaths).toEqual(['/home/deploy/b.txt']);
  });

  it('offers the local actions for a file, and the folder actions on empty space', async () => {
    await setup();
    fireEvent.contextMenu(localRow('notes.txt'));
    let menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Upload', 'RenameF2', 'Move to TrashDel', 'New folder', 'Copy path', 'RefreshF5']);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    const body = localGrid().querySelectorAll('[role="rowgroup"]')[1] as HTMLElement;
    fireEvent.contextMenu(body);
    menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['New folder', 'Copy path', 'RefreshF5']);
  });

  it('copies the path', async () => {
    const { user } = await setup();
    fireEvent.contextMenu(remoteRow('a.txt') as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied the path'));
    expect(await navigator.clipboard.readText()).toBe('/home/deploy/a.txt');
  });
});

describe('the local toolbar', () => {
  it('lists folders and drives under Places and goes to the one picked, and Home goes back', async () => {
    const { user } = await setup();
    await user.click(within(localPane()).getByRole('button', { name: 'Places' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Folders')).toBeTruthy();
    expect(within(menu).getByText('Drives')).toBeTruthy();
    await user.click(within(menu).getByRole('menuitem', { name: 'Local Disk (C:)' }));
    await waitFor(() => expect(files().local.path).toBe('C:\\'));
    await user.click(within(localPane()).getByRole('button', { name: 'Home folder' }));
    await waitFor(() => expect(files().local.path).toBe('C:\\Users\\me'));
  });

  it('clears the filter with its button and with Escape', async () => {
    const { user } = await setup();
    const field = within(localPane()).getByRole('textbox', {
      name: 'Filter files on this computer',
    });
    await user.type(field, 'note');
    expect(rowNames(localGrid())).toEqual(['notes.txt']);
    await user.click(within(localPane()).getByRole('button', { name: 'Clear the filter' }));
    expect(files().local.filter).toBe('');
    expect(document.activeElement).toBe(field);
    await user.type(field, 'pho');
    expect(rowNames(localGrid())).toEqual(['photos']);
    await user.keyboard('{Escape}');
    expect(files().local.filter).toBe('');
  });
});

describe('the context menu, rename', () => {
  it('opens the inline rename field from the menu', async () => {
    const { user } = await setup();
    fireEvent.contextMenu(remoteRow('a.txt') as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'RenameF2' }));
    expect(
      await within(remotePane()).findByRole('textbox', { name: 'New name for a.txt' }),
    ).toBeTruthy();
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

  const item = (menu: HTMLElement, name: string) =>
    within(menu).getByRole('menuitem', { name }) as HTMLElement;

  it('turns off Edit, Rename and Delete in the menu, and keeps the rest', async () => {
    await setup({ 'sftp.open': LIMITED });
    fireEvent.contextMenu(remoteRow('a.txt') as HTMLElement);
    const menu = await screen.findByRole('menu');
    for (const name of ['Edit', 'RenameF2', 'DeleteDel']) {
      expect(item(menu, name)).toHaveAttribute('data-disabled');
    }
    for (const name of ['Download', 'New folder', 'Permissions and properties', 'Copy path']) {
      expect(item(menu, name)).not.toHaveAttribute('data-disabled');
    }
  });

  it('says why on a turned off item, in a tooltip', async () => {
    const { user } = await setup({ 'sftp.open': LIMITED });
    fireEvent.contextMenu(remoteRow('a.txt') as HTMLElement);
    const menu = await screen.findByRole('menu');
    await user.hover(item(menu, 'RenameF2').parentElement as HTMLElement);
    expect(await screen.findByRole('tooltip', { name: LIMITATION })).toBeTruthy();
  });

  it('ignores F2 and Del on the server, and says why', async () => {
    const { bridge } = await setup({ 'sftp.open': LIMITED });
    const grid = remoteGrid();
    fireEvent.click(remoteRow('a.txt') as HTMLElement);
    fireEvent.keyDown(grid, { key: 'F2' });
    expect(within(remotePane()).queryByRole('textbox', { name: 'New name for a.txt' })).toBeNull();
    fireEvent.keyDown(grid, { key: 'Delete' });
    expect(useConfirmStore.getState().open).toBe(false);
    expect(toast.info).toHaveBeenCalledWith(LIMITATION);
    expect(() => bridge.$fn('sftp.remove')).toThrow();
  });

  it('shows the reason above the server pane, and nothing above this computer', async () => {
    await setup({ 'sftp.open': LIMITED });
    expect(within(remotePane()).getByText(LIMITATION)).toBeTruthy();
    expect(within(localPane()).queryByText(LIMITATION)).toBeNull();
  });

  it('leaves this computer alone', async () => {
    await setup({ 'sftp.open': LIMITED });
    fireEvent.contextMenu(localRow('notes.txt'));
    const menu = await screen.findByRole('menu');
    expect(item(menu, 'RenameF2')).not.toHaveAttribute('data-disabled');
    expect(item(menu, 'Move to TrashDel')).not.toHaveAttribute('data-disabled');
  });

  it('allows everything for a session that says nothing, with no notice', async () => {
    await setup();
    expect(within(remotePane()).queryByRole('note')).toBeNull();
    fireEvent.contextMenu(remoteRow('a.txt') as HTMLElement);
    const menu = await screen.findByRole('menu');
    for (const name of ['Edit', 'RenameF2', 'DeleteDel']) {
      expect(item(menu, name)).not.toHaveAttribute('data-disabled');
    }
  });

  it('says so when only part of the folder is listed', async () => {
    await setup({
      'sftp.list': async (_session: string, path: string) => {
        const resolved = path === '~' ? '/home/deploy' : path;
        return {
          path: resolved,
          parent: parentOf(resolved),
          entries: REMOTE[resolved] ?? [],
          partial: resolved === '/home/deploy',
        };
      },
    });
    expect(within(remotePane()).getByText(/Only part of this folder is listed/)).toBeTruthy();
    await act(async () => {
      await useSftpStore.getState().navigate('srv-1', 'remote', '/var');
    });
    expect(within(remotePane()).queryByText(/Only part of this folder is listed/)).toBeNull();
  });
});
