import type { SshSavedServer } from '@shared/apiTypes';
import type {
  SftpBatchView,
  SftpListing,
  SftpQueueSnapshot,
  SftpRemoteEntry,
  SftpSessionInfo,
} from '@shared/sftpTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSftpStore, serverFiles, useSftpStore } from '@/stores/sftpStore';
import type { BridgeOverrides } from '../../../../test/renderer/agentmatBridge';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { type SshFilesVariant, SshFilesView } from './SshFilesView';

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));
// The dialogs have tests of their own; here only whether the view draws them counts.
vi.mock('@/components/sftp/PropertiesDialog', () => ({
  PropertiesDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Properties" /> : null,
}));
vi.mock('@/components/sftp/RemoteEditorDialog', () => {
  const RemoteEditorDialog = ({ open, path }: { open: boolean; path: string }) =>
    open ? <div role="dialog" aria-label={`Edit ${path}`} /> : null;
  return { RemoteEditorDialog, default: RemoteEditorDialog };
});

/**
 * The file manager as the terminal drawer docks it (E25 F6): compact enough for a short drawer,
 * and shown only while its tab is on screen, so a transfer that finishes behind a shut drawer
 * still gets its toast. The page and the pop-out are covered in SshFilesView.test.tsx.
 */

const SERVER: SshSavedServer = {
  id: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 2222,
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
  port: 2222,
  username: 'deploy',
  home: '/home/deploy',
};

const ENTRY: SftpRemoteEntry = {
  name: 'index.html',
  path: '/home/deploy/index.html',
  kind: 'file',
  isDirectory: false,
  isSymlink: false,
  size: 120,
  mtimeMs: 1_700_000_000_000,
  mode: 0o644,
  owner: 'deploy',
  group: 'deploy',
};

const EMPTY_QUEUE: SftpQueueSnapshot = {
  sessionId: 'sess-1',
  batches: [],
  conflict: null,
  pendingConflicts: 0,
};

const BATCH: SftpBatchView = {
  batchId: 'b1',
  kind: 'upload',
  label: 'site (3 files)',
  source: 'C:\\work',
  target: '/home/deploy',
  state: 'running',
  totalItems: 3,
  doneItems: 1,
  failedItems: 0,
  skippedItems: 0,
  totalBytes: 300,
  transferredBytes: 100,
  bytesPerSecond: 50,
  etaSeconds: 4,
  running: [],
  failures: [],
  failuresTruncated: false,
  createdAt: 1,
  finishedAt: null,
};

const FINISHED = {
  sessionId: 'sess-1',
  batchId: 'b1',
  kind: 'upload',
  side: 'remote',
  target: '/elsewhere',
  ok: true,
  failed: 0,
};

function bridgeFor(overrides: BridgeOverrides = {}): BridgeOverrides {
  return {
    'ssh.listServers': [SERVER],
    'sftp.open': SESSION,
    'sftp.queue': EMPTY_QUEUE,
    'sftp.list': async (_s: string, path: string): Promise<SftpListing<SftpRemoteEntry>> => ({
      path,
      parent: '/home',
      entries: [ENTRY],
    }),
    'sftp.localPlaces': [{ id: 'home', label: 'Home', path: 'C:\\Users\\me', kind: 'home' }],
    'sftp.localList': async (path: string) => ({ path, parent: 'C:\\Users', entries: [] }),
    ...overrides,
  };
}

/** A dock tab the test can bring on screen and send away again, as the drawer does. */
function Harness({
  variant,
  initiallyShown,
}: {
  variant: SshFilesVariant;
  initiallyShown: boolean;
}): React.JSX.Element {
  const [shown, setShown] = useState(initiallyShown);
  return (
    <>
      <button type="button" onClick={() => setShown((value) => !value)}>
        Switch tab
      </button>
      <SshFilesView serverId="srv-1" variant={variant} trackVisibility={shown} />
    </>
  );
}

function renderView(variant: SshFilesVariant = 'dock', initiallyShown = true) {
  return renderWithProviders(<Harness variant={variant} initiallyShown={initiallyShown} />, {
    bridge: bridgeFor(),
  });
}

const files = () => serverFiles(useSftpStore.getState(), 'srv-1');
const remotePane = () => screen.getByRole('region', { name: 'Server prod' });

beforeEach(() => {
  resetSftpStore();
  toast.success.mockClear();
});

describe('SshFilesView in the dock, on screen or not', () => {
  it('counts as shown only while its tab is, and connects once either way', async () => {
    const { bridge, user } = renderView('dock', false);
    expect(files().visible).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Switch tab' }));
    await screen.findByRole('grid', { name: 'Files on prod' });
    expect(files().visible).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Switch tab' }));
    expect(files().visible).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Switch tab' }));

    // Showing and hiding the tab never opens the session again.
    expect(bridge.$fn('sftp.open')).toHaveBeenCalledTimes(1);
  });

  it('never logs in on its own while hidden, as after a disconnect on the page', async () => {
    const { bridge, user } = renderView('dock', false);
    // This computer is listed at once; the server stays as the user left it.
    await screen.findByRole('grid', { name: 'Files on this computer' });
    expect(() => bridge.$fn('sftp.open')).toThrow();
    expect(files().status).toBe('idle');

    // On screen it connects, as the page does.
    await user.click(screen.getByRole('button', { name: 'Switch tab' }));
    await screen.findByRole('grid', { name: 'Files on prod' });
    expect(bridge.$fn('sftp.open')).toHaveBeenCalledTimes(1);
  });

  it('follows no queue snapshot while hidden, and shows the card again on screen', async () => {
    const { bridge, user } = renderView('dock', true);
    await screen.findByRole('grid', { name: 'Files on prod' });
    act(() => bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, batches: [BATCH] }));
    expect(screen.getByRole('region', { name: 'Transfers' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Switch tab' }));
    expect(screen.queryByRole('region', { name: 'Transfers' })).toBeNull();
    act(() =>
      bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, batches: [{ ...BATCH, doneItems: 2 }] }),
    );
    expect(screen.queryByRole('region', { name: 'Transfers' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Switch tab' }));
    expect(screen.getByRole('region', { name: 'Transfers' })).toBeInTheDocument();
  });

  it('lets the "finished" toast through while the tab is hidden, and not while it is shown', async () => {
    const { bridge, user } = renderView('dock', true);
    await screen.findByRole('grid', { name: 'Files on prod' });

    act(() => bridge.$emit('sftp.onBatchFinished', FINISHED));
    expect(toast.success).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Switch tab' }));
    act(() => bridge.$emit('sftp.onBatchFinished', FINISHED));
    expect(toast.success).toHaveBeenCalledWith('Upload to prod finished', expect.anything());
  });

  it('counts as shown by default, as the page and the window are', async () => {
    renderWithProviders(<SshFilesView serverId="srv-1" variant="page" />, {
      bridge: bridgeFor(),
    });
    await screen.findByRole('grid', { name: 'Files on prod' });
    expect(files().visible).toBe(1);
  });
});

describe('SshFilesView in the dock, drawn compact', () => {
  it('keeps Name, Size and Modified, and drops Permissions and Owner', async () => {
    renderView('dock');
    await screen.findByRole('grid', { name: 'Files on prod' });
    const pane = remotePane();

    expect(pane).toHaveAttribute('data-compact');
    expect(screen.getByRole('region', { name: 'This computer' })).toHaveAttribute('data-compact');
    const headers = within(pane)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toEqual(['Name', 'Size', 'Modified']);
    const row = within(pane).getByRole('row', { name: /index\.html/ });
    expect(within(row).getAllByRole('gridcell')).toHaveLength(3);
    // Shorter rows, so a few more fit in the drawer.
    expect(row).toHaveStyle({ height: '24px' });
  });

  it('puts the whole toolbar on one row, so the drawer has room for the files', async () => {
    renderView('dock');
    await screen.findByRole('grid', { name: 'Files on prod' });
    const pane = remotePane();
    const toolbar = pane.querySelector('[data-pane-toolbar]');

    expect(toolbar).toHaveAttribute('data-compact');
    const row = within(pane).getByRole('button', { name: 'Up one folder' }).parentElement;
    expect(row).toBe(toolbar);
    // The title, the path, the filter, the pane's own buttons and Disconnect share that row.
    for (const name of ['Filter', 'New folder', 'Download to this computer', 'Disconnect']) {
      expect(row?.contains(within(pane).getByRole('button', { name }))).toBe(true);
    }
    expect(row?.contains(within(pane).getByText('prod', { selector: 'h2' }))).toBe(true);
    expect(row?.contains(within(pane).getByRole('navigation'))).toBe(true);
  });

  it('filters from an icon that opens the field, and says so while a filter is on', async () => {
    const { user } = renderView('dock');
    await screen.findByRole('grid', { name: 'Files on prod' });
    const pane = remotePane();
    expect(within(pane).queryByRole('textbox', { name: 'Filter files on the server' })).toBeNull();

    await user.click(within(pane).getByRole('button', { name: 'Filter' }));
    const field = within(pane).getByRole('textbox', { name: 'Filter files on the server' });
    expect(field).toHaveFocus();
    await user.type(field, 'log{Enter}');

    expect(files().remote.filter).toBe('log');
    expect(within(pane).queryByRole('textbox', { name: 'Filter files on the server' })).toBeNull();
    const on = within(pane).getByRole('button', { name: 'Filtered: log' });
    expect(on).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(on).toHaveFocus());

    await user.click(within(pane).getByRole('button', { name: 'Clear the filter' }));
    expect(files().remote.filter).toBe('');
    expect(within(pane).getByRole('button', { name: 'Filter' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('shows a filter set on the page, so the dock never filters out of sight', async () => {
    renderView('dock');
    await screen.findByRole('grid', { name: 'Files on prod' });
    act(() => useSftpStore.getState().setFilter('srv-1', 'local', 'notes'));
    const local = screen.getByRole('region', { name: 'This computer' });
    expect(within(local).getByRole('button', { name: 'Filtered: notes' })).toBeInTheDocument();
  });

  it('closes the field when focus leaves it, keeping what was typed', async () => {
    const { user } = renderView('dock');
    await screen.findByRole('grid', { name: 'Files on prod' });
    const pane = remotePane();
    await user.click(within(pane).getByRole('button', { name: 'Filter' }));
    await user.type(within(pane).getByRole('textbox', { name: 'Filter files on the server' }), 'x');
    await user.click(within(pane).getByRole('button', { name: 'New folder' }));
    expect(within(pane).queryByRole('textbox', { name: 'Filter files on the server' })).toBeNull();
    expect(within(pane).getByRole('button', { name: 'Filtered: x' })).toBeInTheDocument();
  });

  it('keeps the two toolbar rows on the page', async () => {
    renderView('page');
    await screen.findByRole('grid', { name: 'Files on prod' });
    const pane = remotePane();
    const toolbar = pane.querySelector('[data-pane-toolbar]');

    expect(toolbar).not.toHaveAttribute('data-compact');
    const navRow = within(pane).getByRole('button', { name: 'Up one folder' }).parentElement;
    expect(navRow?.contains(within(pane).getByRole('button', { name: 'New folder' }))).toBe(false);
  });

  it('draws every column on the page', async () => {
    renderView('page');
    await screen.findByRole('grid', { name: 'Files on prod' });
    const pane = remotePane();

    expect(pane).not.toHaveAttribute('data-compact');
    const headers = within(pane)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toEqual(['Name', 'Size', 'Modified', 'Permissions', 'Owner']);
    expect(within(pane).getByRole('row', { name: /index\.html/ })).toHaveStyle({
      height: '28px',
    });
  });

  it('folds the Transfers card to its one-line header, where the page shows the list', async () => {
    const dock = renderView('dock');
    await screen.findByRole('grid', { name: 'Files on prod' });
    act(() => dock.bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, batches: [BATCH] }));
    expect(screen.getByRole('button', { name: 'Show transfers' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('site (3 files)')).toBeNull();
    dock.unmount();

    resetSftpStore();
    const page = renderView('page');
    await screen.findByRole('grid', { name: 'Files on prod' });
    act(() => page.bridge.$emit('sftp.onQueue', { ...EMPTY_QUEUE, batches: [BATCH] }));
    expect(screen.getByRole('button', { name: 'Hide transfers' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('SshFilesView dialogs, on screen or not', () => {
  const PATH = '/home/deploy/index.html';

  function openBoth(): void {
    act(() => {
      useSftpStore.getState().openProperties('srv-1', [PATH]);
      useSftpStore.setState((state) => ({
        servers: {
          ...state.servers,
          'srv-1': { ...files(), editingPath: PATH },
        },
      }));
    });
  }

  it('draws no dialog while its tab is hidden, so none stays up over the rest of the app', async () => {
    const { user } = renderView('dock', true);
    await screen.findByRole('grid', { name: 'Files on prod' });
    openBoth();
    expect(screen.getByRole('dialog', { name: 'Properties' })).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: `Edit ${PATH}` })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Switch tab' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Back on screen, they are where the user left them.
    await user.click(screen.getByRole('button', { name: 'Switch tab' }));
    expect(screen.getByRole('dialog', { name: 'Properties' })).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: `Edit ${PATH}` })).toBeInTheDocument();
  });

  it('draws both on the page, which is always counted as shown', async () => {
    renderWithProviders(<SshFilesView serverId="srv-1" variant="page" />, {
      bridge: bridgeFor(),
    });
    await screen.findByRole('grid', { name: 'Files on prod' });
    openBoth();
    expect(screen.getByRole('dialog', { name: 'Properties' })).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: `Edit ${PATH}` })).toBeInTheDocument();
  });
});
