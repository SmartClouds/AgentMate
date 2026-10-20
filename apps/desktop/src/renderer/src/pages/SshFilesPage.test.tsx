import type { SshSavedServer } from '@shared/apiTypes';
import { encodeFilesError } from '@shared/deployFilesErrors';
import type {
  SftpListing,
  SftpQueueSnapshot,
  SftpRemoteEntry,
  SftpSessionInfo,
} from '@shared/sftpTypes';
import { encodeSshError } from '@shared/sshErrors';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConflictDialogProps,
  PropertiesDialogProps,
  RemoteEditorDialogProps,
  TransferQueueProps,
} from '@/components/sftp/contracts';
import { resolveConfirm, useConfirmStore } from '@/stores/confirmStore';
import { usePageHeaderStore } from '@/stores/pageHeaderStore';
import { PANEL_WIDTHS } from '@/stores/panelWidthStore';
import { resetSftpStore, serverFiles, useSftpStore } from '@/stores/sftpStore';
import type { BridgeOverrides } from '../../../test/renderer/agentmatBridge';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';
import SshFilesPage from './SshFilesPage';

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

/** The dialogs and the queue have tests of their own; here only what the page hands them counts. */
const seen = vi.hoisted(() => ({
  queue: [] as unknown[],
  conflict: [] as unknown[],
  properties: [] as unknown[],
  editor: [] as unknown[],
}));
vi.mock('@/components/sftp/TransferQueue', () => ({
  TransferQueue: (props: TransferQueueProps) => {
    seen.queue.push(props);
    return <div data-testid="transfer-queue" />;
  },
}));
vi.mock('@/components/sftp/ConflictDialog', () => ({
  ConflictDialog: (props: ConflictDialogProps) => {
    seen.conflict.push(props);
    return props.conflict ? (
      <div role="dialog" aria-label="This file already exists">
        <button
          type="button"
          onClick={() => void props.onResolve({ action: 'rename', applyToAll: true })}
        >
          Keep both
        </button>
      </div>
    ) : null;
  },
}));
vi.mock('@/components/sftp/PropertiesDialog', () => ({
  PropertiesDialog: (props: PropertiesDialogProps) => {
    seen.properties.push(props);
    return props.open ? <div role="dialog" aria-label="Properties" /> : null;
  },
}));
vi.mock('@/components/sftp/RemoteEditorDialog', () => {
  const RemoteEditorDialog = (props: RemoteEditorDialogProps) => {
    seen.editor.push(props);
    return props.open ? <div role="dialog" aria-label={`Edit ${props.path}`} /> : null;
  };
  return { RemoteEditorDialog, default: RemoteEditorDialog };
});

/**
 * `/ssh-files/:serverId` (E25): this computer on the left at once, the server on the right once
 * its session is ready, and the queue, conflict, properties and editor dialogs fed from the store.
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

const TEXT = {
  path: '/home/deploy/index.html',
  content: '<h1>Hi</h1>',
  size: 11,
  mtimeMs: 1_700_000_000_000,
  mode: 0o644,
  bom: false,
};

function bridgeFor(overrides: BridgeOverrides = {}): BridgeOverrides {
  return {
    'sftp.readText': async () => TEXT,
    'ssh.listServers': [SERVER],
    'sftp.open': SESSION,
    'sftp.queue': EMPTY_QUEUE,
    'sftp.list': async (_s: string, path: string): Promise<SftpListing<SftpRemoteEntry>> => ({
      path,
      parent: '/home',
      entries: [ENTRY],
    }),
    'sftp.localPlaces': [{ id: 'home', label: 'Home', path: 'C:\\Users\\me', kind: 'home' }],
    'sftp.localList': async (path: string) => ({
      path,
      parent: 'C:\\Users',
      entries: [
        {
          name: 'notes.txt',
          path: 'C:\\Users\\me\\notes.txt',
          isDirectory: false,
          isSymlink: false,
          size: 10,
          mtimeMs: 0,
          mode: null,
          hidden: false,
        },
      ],
    }),
    ...overrides,
  };
}

function renderPage(overrides: BridgeOverrides = {}) {
  return renderWithProviders(<SshFilesPage />, {
    route: '/ssh-files/srv-1',
    path: 'ssh-files/:serverId',
    bridge: bridgeFor(overrides),
  });
}

const files = () => serverFiles(useSftpStore.getState(), 'srv-1');
const remotePane = () => screen.getByRole('region', { name: 'Server prod' });

beforeEach(() => {
  resetSftpStore();
  seen.queue.length = 0;
  seen.conflict.length = 0;
  seen.properties.length = 0;
  seen.editor.length = 0;
  toast.info.mockClear();
  toast.error.mockClear();
});

describe('SshFilesPage', () => {
  it('names the server in the header', async () => {
    renderPage();
    await waitFor(() => expect(usePageHeaderStore.getState().title).toBe('Files: prod'));
    expect(usePageHeaderStore.getState().subtitle).toBe('deploy@prod.example:2222');
  });

  it('lists this computer at once while the server shimmers, then shows its files', async () => {
    let open: (info: SftpSessionInfo) => void = () => undefined;
    renderPage({
      'sftp.open': () =>
        new Promise<SftpSessionInfo>((resolve) => {
          open = resolve;
        }),
    });
    const local = await screen.findByRole('grid', { name: 'Files on this computer' });
    expect(await within(local).findByText('notes.txt')).toBeTruthy();
    expect(await screen.findByText('Connecting to prod…')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Connecting to prod' })).toBeTruthy();

    await act(async () => open(SESSION));
    const remote = await screen.findByRole('grid', { name: 'Files on prod' });
    expect(await within(remote).findByText('index.html')).toBeTruthy();
  });

  it('asks for the passkey when the vault is locked, then connects', async () => {
    let locked = true;
    const { user, bridge } = renderPage({
      'sftp.open': async () => {
        if (locked) throw new Error(encodeSshError('vault-locked', 'Locked.'));
        return SESSION;
      },
      'ssh.unlockVault': async () => {
        locked = false;
        return true;
      },
    });
    expect(await screen.findByText('Your saved servers are locked')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Passkey'), 'secret');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('grid', { name: 'Files on prod' })).toBeTruthy();
    expect(bridge.$fn('sftp.open')).toHaveBeenCalledTimes(2);
  });

  it('shows the reason with a retry and a way to the server settings when the login fails', async () => {
    let fail = true;
    const { user } = renderPage({
      'sftp.open': async () => {
        if (fail) throw new Error(encodeFilesError('auth', 'denied'));
        return SESSION;
      },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Couldn't connect to prod/);
    expect(screen.getByRole('button', { name: 'Edit server' })).toBeTruthy();
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('grid', { name: 'Files on prod' })).toBeTruthy();
  });

  it('says so when the server is not saved anymore', async () => {
    renderPage({ 'ssh.listServers': [] });
    expect(await screen.findByText("This server isn't saved anymore")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Remote' })).toBeTruthy();
  });

  it('shows the queue only when there are batches, and the conflict from the snapshot', async () => {
    const { user, bridge } = renderPage();
    await screen.findByRole('grid', { name: 'Files on prod' });
    expect(screen.queryByTestId('transfer-queue')).toBeNull();

    const conflict = {
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
    act(() => {
      bridge.$emit('sftp.onQueue', {
        ...EMPTY_QUEUE,
        batches: [{ batchId: 'b1', state: 'waiting', label: 'index.html' }],
        conflict,
      });
    });
    expect(screen.getByTestId('transfer-queue')).toBeTruthy();
    await user.click(
      within(screen.getByRole('dialog', { name: 'This file already exists' })).getByRole('button', {
        name: 'Keep both',
      }),
    );
    expect(bridge.$fn('sftp.resolveConflict')).toHaveBeenCalledWith('sess-1', 'c1', {
      action: 'rename',
      applyToAll: true,
    });

    const last = seen.queue.at(-1) as TransferQueueProps;
    await act(async () => {
      await last.onCancel({ batchId: 'b1' });
      await last.onClearFinished();
    });
    expect(bridge.$fn('sftp.cancel')).toHaveBeenCalledWith('sess-1', { batchId: 'b1' });
    expect(bridge.$fn('sftp.clearFinished')).toHaveBeenCalledWith('sess-1');
  });

  it('opens the properties and the editor for what the store points at', async () => {
    renderPage();
    await screen.findByText('index.html');
    act(() => useSftpStore.getState().openProperties('srv-1', ['/home/deploy/index.html']));
    expect(screen.getByRole('dialog', { name: 'Properties' })).toBeTruthy();
    const props = seen.properties.at(-1) as PropertiesDialogProps;
    expect(props.entries).toEqual([ENTRY]);
    act(() => props.onOpenChange(false));
    expect(files().propertiesPaths).toBeNull();

    await act(async () => {
      await useSftpStore.getState().openEditor('srv-1', '/home/deploy/index.html');
    });
    expect(
      await screen.findByRole('dialog', { name: 'Edit /home/deploy/index.html' }),
    ).toBeTruthy();
    const editor = seen.editor.at(-1) as RemoteEditorDialogProps;
    expect(editor.sessionId).toBe('sess-1');
    // The store read the file already, so the editor starts from it without reading again.
    expect(editor.initialFile).toEqual(TEXT);
  });

  it('asks before disconnecting while transfers run', async () => {
    const { user, bridge } = renderPage();
    await screen.findByRole('grid', { name: 'Files on prod' });
    act(() => {
      bridge.$emit('sftp.onQueue', {
        ...EMPTY_QUEUE,
        batches: [{ batchId: 'b1', state: 'running', label: 'site' }],
      });
    });
    await user.click(within(remotePane()).getByRole('button', { name: 'Disconnect' }));
    expect(useConfirmStore.getState().title).toBe('Disconnect from prod?');
    await act(async () => resolveConfirm(true));
    await waitFor(() => expect(bridge.$fn('sftp.close')).toHaveBeenCalledWith('sess-1'));
    // The page stays, and the server's pane offers to connect again.
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('grid', { name: 'Files on prod' })).toBeTruthy();
  });

  it("rejects the conflict answers when main does, so the dialog's own toast and unlock run", async () => {
    const { bridge } = renderPage({
      'sftp.resolveConflict': async () => {
        throw new Error('[files:invalidInput] Unknown conflict');
      },
      'sftp.cancel': async () => {
        throw new Error('[files:server] No such batch');
      },
    });
    await screen.findByRole('grid', { name: 'Files on prod' });
    act(() => {
      bridge.$emit('sftp.onQueue', {
        ...EMPTY_QUEUE,
        batches: [{ batchId: 'b1', state: 'waiting', label: 'index.html' }],
        conflict: {
          conflictId: 'c1',
          batchId: 'b1',
          itemId: 'i1',
          direction: 'upload',
          name: 'index.html',
          relPath: 'index.html',
          targetDir: '/home/deploy',
          source: { size: 1, mtimeMs: 1 },
          target: { size: 2, mtimeMs: 2, isDirectory: false },
          renameTo: 'index (1).html',
          remainingInBatch: 0,
        },
      });
    });
    const dialog = seen.conflict.at(-1) as ConflictDialogProps;
    await expect(
      Promise.resolve(dialog.onResolve({ action: 'skip', applyToAll: false })),
    ).rejects.toThrow('Unknown conflict');
    await expect(Promise.resolve(dialog.onCancelBatch('b1'))).rejects.toThrow('No such batch');
    // Only the dialog speaks; the store adds no toast of its own.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('remembers the local pane width under its own key', () => {
    expect(PANEL_WIDTHS.sftpLocalPane).toEqual({ min: 260, max: 1200, default: 520 });
  });
});

describe('SshFilesPage, the rest of what it hands on', () => {
  it('keeps the session when the disconnect is called off', async () => {
    const { user, bridge } = renderPage();
    await screen.findByRole('grid', { name: 'Files on prod' });
    act(() => {
      bridge.$emit('sftp.onQueue', {
        ...EMPTY_QUEUE,
        batches: [{ batchId: 'b1', state: 'running', label: 'site' }],
      });
    });
    await user.click(within(remotePane()).getByRole('button', { name: 'Disconnect' }));
    await act(async () => resolveConfirm(false));
    expect(() => bridge.$fn('sftp.close')).toThrow();
    expect(files().status).toBe('ready');
  });

  it('passes retry, a conflict batch cancel, chmod and the editor close and save through', async () => {
    const { bridge } = renderPage();
    await screen.findByText('index.html');
    act(() => {
      bridge.$emit('sftp.onQueue', {
        ...EMPTY_QUEUE,
        batches: [{ batchId: 'b1', state: 'failed', label: 'site' }],
      });
    });
    await act(async () => {
      await (seen.queue.at(-1) as TransferQueueProps).onRetry({ batchId: 'b1' });
      await (seen.conflict.at(-1) as ConflictDialogProps).onCancelBatch('b1');
    });
    expect(bridge.$fn('sftp.retry')).toHaveBeenCalledWith('sess-1', { batchId: 'b1' });
    expect(bridge.$fn('sftp.cancel')).toHaveBeenCalledWith('sess-1', { batchId: 'b1' });

    act(() => useSftpStore.getState().openProperties('srv-1', [ENTRY.path]));
    const input = { paths: [ENTRY.path], mode: 0o600, recursive: 'none' as const };
    await act(async () => (seen.properties.at(-1) as PropertiesDialogProps).onApply(input));
    expect(bridge.$fn('sftp.chmod')).toHaveBeenCalledWith('sess-1', input);
    // Closing with the dialog still open leaves it as it is.
    act(() => (seen.properties.at(-1) as PropertiesDialogProps).onOpenChange(true));
    expect(files().propertiesPaths).toEqual([ENTRY.path]);

    await act(async () => {
      await useSftpStore.getState().openEditor('srv-1', ENTRY.path);
    });
    await screen.findByRole('dialog', { name: `Edit ${ENTRY.path}` });
    const editor = seen.editor.at(-1) as RemoteEditorDialogProps;
    bridge.$fn('sftp.list').mockClear();
    act(() => editor.onSaved?.(ENTRY));
    await waitFor(() =>
      expect(bridge.$fn('sftp.list')).toHaveBeenCalledWith('sess-1', '/home/deploy'),
    );
    act(() => editor.onOpenChange(true));
    expect(files().editingPath).toBe(ENTRY.path);
    act(() => editor.onOpenChange(false));
    expect(files().editingPath).toBeNull();
  });

  it('asks for a server when the route names none, and points to Remote', async () => {
    const { user } = renderWithProviders(<SshFilesPage />, {
      route: '/ssh-files',
      path: 'ssh-files',
      bridge: bridgeFor(),
    });
    expect(screen.getByText('No server picked')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open Remote' }));
    await waitFor(() => expect(screen.queryByText('No server picked')).toBeNull());
  });
});

describe('SshFilesPage, the gate links', () => {
  it('leaves for Remote from a failed login and from a server that is gone', async () => {
    const failed = renderPage({
      'sftp.open': async () => {
        throw new Error(encodeFilesError('auth', 'denied'));
      },
    });
    await failed.user.click(await screen.findByRole('button', { name: 'Edit server' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Server prod' })).toBeNull());
    failed.unmount();

    resetSftpStore();
    const gone = renderPage({ 'ssh.listServers': [] });
    await gone.user.click(await screen.findByRole('button', { name: 'Open Remote' }));
    await waitFor(() => expect(screen.queryByText("This server isn't saved anymore")).toBeNull());
  });
});
