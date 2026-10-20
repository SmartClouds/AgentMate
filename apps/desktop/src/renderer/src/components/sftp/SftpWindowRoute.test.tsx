import type { SftpConflict, SftpSessionInfo } from '@shared/sftpTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { confirmDialog } from '@/stores/confirmStore';
import { promptHostKeyTrust } from '@/stores/hostKeyPromptStore';
import { resetSftpStore, serverFiles, useSftpStore } from '@/stores/sftpStore';
import { useThemeStore } from '@/stores/themeStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { ConflictDialogProps } from './contracts';
import SftpWindowRoute from './SftpWindowRoute';
import type { SshFilesViewProps } from './SshFilesView';

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast,
  Toaster: (props: { theme?: string }) => <div data-testid="toaster" data-theme={props.theme} />,
}));

vi.mock('@/lib/sftp/dock', () => ({ openSftpDock: vi.fn(), closeSftpDock: vi.fn() }));

/** The file manager has tests of its own; here only what the window hands it counts. */
const seen = vi.hoisted(() => ({ views: [] as SshFilesViewProps[] }));
vi.mock('./SshFilesView', () => ({
  SshFilesView: (props: SshFilesViewProps) => {
    seen.views.push(props);
    return (
      <div data-testid="sftp-view" data-server={props.serverId} data-variant={props.variant}>
        {props.viewActions}
      </div>
    );
  },
}));

vi.mock('./ConflictDialog', () => ({
  ConflictDialog: (props: ConflictDialogProps) =>
    props.conflict ? <div role="dialog" aria-label="This file already exists" /> : null,
}));

/**
 * The pop-out window (`#/sftp-window?server=…`, E25): its own title bar with the window's
 * controls, the file manager as its window variant, and the hosts the app shell would otherwise
 * provide.
 */

const SESSION: SftpSessionInfo = {
  sessionId: 'sess-1',
  serverId: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 2222,
  username: 'deploy',
  home: '/home/deploy',
};

function setServer(change: Partial<ReturnType<typeof serverFiles>>): void {
  useSftpStore.setState((state) => ({
    servers: { ...state.servers, 'srv-1': { ...serverFiles(state, 'srv-1'), ...change } },
  }));
}

function renderWindow(route = '/sftp-window?server=srv-1', bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<SftpWindowRoute />, {
    route,
    bridge: {
      'sftp.windowState': { isMaximized: false },
      'sftp.windowControl': async () => undefined,
      'sftp.backToMain': async () => undefined,
      ...bridge,
    },
  });
}

function titleBar(): HTMLElement {
  return document.querySelector('[data-sftp-window-titlebar]') as HTMLElement;
}

beforeEach(() => {
  resetSftpStore();
  seen.views.length = 0;
  document.documentElement.className = '';
  useThemeStore.setState({ theme: 'system' });
});

const realGoTo = useSftpStore.getState().goTo;
type SftpGoTo = typeof realGoTo;

afterEach(() => {
  document.documentElement.className = '';
  useSftpStore.setState({ goTo: realGoTo });
});

describe('SftpWindowRoute', () => {
  it('draws the file manager for the server in the query, as the window variant', () => {
    renderWindow();
    const view = screen.getByTestId('sftp-view');
    expect(view.dataset.server).toBe('srv-1');
    expect(view.dataset.variant).toBe('window');
    // The pane's switch only knows the way back.
    expect(within(view).getByRole('button', { name: 'Back to main window' })).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(within(view).queryByRole('button', { name: 'Open in a new window' })).toBeNull();
  });

  it('says so when the query names no server', () => {
    renderWindow('/sftp-window');
    expect(screen.queryByTestId('sftp-view')).toBeNull();
    expect(screen.getByText('No server to show.')).toBeTruthy();
  });

  it('draws its toasts in the theme in use', () => {
    // The theme itself is painted before React renders, from the hash (main.tsx, themeStore).
    useThemeStore.setState({ theme: 'dark' });
    renderWindow('/sftp-window?server=srv-1&theme=dark');
    expect(screen.getByTestId('toaster').dataset.theme).toBe('dark');
  });

  it('names the server and its login in the title bar', async () => {
    renderWindow();
    expect(within(titleBar()).getByRole('heading').textContent).toBe('Files: server');
    act(() => setServer({ session: SESSION, status: 'ready' }));
    expect(within(titleBar()).getByRole('heading').textContent).toBe('Files: prod');
    expect(within(titleBar()).getByText('deploy@prod.example')).toBeTruthy();
    await waitFor(() => expect(document.title).toBe('Files: prod'));
  });

  it('drives its own window from the caption buttons', async () => {
    const { user, bridge } = renderWindow();
    // The caption buttons are the last three (the way back comes first while not connected).
    const [minimize, maximize, close] = within(titleBar()).getAllByRole('button').slice(-3);
    await user.click(minimize as HTMLElement);
    await user.click(maximize as HTMLElement);
    await user.click(close as HTMLElement);
    const control = bridge.$fn('sftp.windowControl');
    expect(control.mock.calls).toEqual([['minimize'], ['maximize'], ['close']]);
  });

  it('maximizes from a double click on the empty bar, not on a button', async () => {
    const { user, bridge } = renderWindow();
    await user.dblClick(within(titleBar()).getByRole('heading'));
    expect(bridge.$fn('sftp.windowControl')).toHaveBeenCalledWith('maximize');
  });

  it('follows the window being maximized and restored', async () => {
    const { bridge } = renderWindow('/sftp-window?server=srv-1', {
      'sftp.windowState': { isMaximized: true },
    });
    // The restore glyph while maximized.
    await waitFor(() => expect(titleBar().textContent).toContain(''));
    act(() => bridge.$emit('sftp.onWindowState', { isMaximized: false }));
    expect(titleBar().textContent).toContain('');
  });

  it('stops listening for the window state when it goes', () => {
    const { bridge, unmount } = renderWindow();
    expect(bridge.$listenerCount('sftp.onWindowState')).toBe(1);
    unmount();
    expect(bridge.$listenerCount('sftp.onWindowState')).toBe(0);
  });

  it('offers the way back in the title bar while there is no session to show', async () => {
    const { user, bridge } = renderWindow();
    act(() => setServer({ status: 'idle', session: null }));
    await user.click(within(titleBar()).getByRole('button', { name: 'Back to main window' }));
    expect(bridge.$fn('sftp.backToMain')).toHaveBeenCalledTimes(1);
    // Once connected, the pane's own switch has it, so the bar does not repeat it.
    act(() => setServer({ status: 'ready', session: SESSION }));
    expect(within(titleBar()).queryByRole('button', { name: 'Back to main window' })).toBeNull();
  });

  it('mounts its own toaster', () => {
    renderWindow();
    expect(screen.getByTestId('toaster')).toBeTruthy();
  });

  it('mounts its own confirm dialog host', async () => {
    renderWindow();
    let answer: Promise<boolean> | undefined;
    act(() => {
      answer = confirmDialog({ title: 'Disconnect from prod?', confirmLabel: 'Disconnect' });
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Disconnect from prod?')).toBeTruthy();
    await act(async () => {
      within(dialog).getByRole('button', { name: 'Disconnect' }).click();
    });
    await expect(answer).resolves.toBe(true);
  });

  it('mounts its own host key question', async () => {
    renderWindow();
    let answer: Promise<boolean> | undefined;
    act(() => {
      answer = promptHostKeyTrust({
        serverId: 'srv-1',
        nickname: 'prod',
        host: 'prod.example',
        port: 2222,
        stored: 'a'.repeat(64),
        presented: 'b'.repeat(64),
      });
    });
    expect(await screen.findByText('prod’s identity changed')).toBeTruthy();
    await act(async () => {
      screen.getByRole('button', { name: "Don't connect" }).click();
    });
    await expect(answer).resolves.toBe(false);
  });

  it('mounts its own conflict host', () => {
    renderWindow();
    expect(screen.queryByRole('dialog', { name: 'This file already exists' })).toBeNull();
    const conflict: SftpConflict = {
      conflictId: 'c1',
      batchId: 'b1',
      itemId: 'i1',
      direction: 'upload',
      name: 'a.txt',
      relPath: 'a.txt',
      targetDir: '/srv',
      source: { size: 1, mtimeMs: 1 },
      target: { size: 2, mtimeMs: 2, isDirectory: false },
      renameTo: 'a (1).txt',
      remainingInBatch: 0,
    };
    act(() =>
      setServer({
        session: SESSION,
        status: 'ready',
        // The view (mocked here) marks the server as shown, which is what lets the dialog open.
        visible: 1,
        queue: { sessionId: 'sess-1', batches: [], conflict, pendingConflicts: 1 },
      }),
    );
    expect(screen.getByRole('dialog', { name: 'This file already exists' })).toBeTruthy();
  });
});

describe('SftpWindowRoute opening at the folders its opener showed', () => {
  const ROUTE = '/sftp-window?server=srv-1&remote=%2Ftmp%2Fvis+dark&local=%2Fhome%2Fme%2Fsite';
  let goTo: Mock<SftpGoTo>;

  beforeEach(() => {
    vi.clearAllMocks();
    goTo = vi.fn<SftpGoTo>(async () => ({ status: 'ok' }));
    useSftpStore.setState({ goTo });
  });

  /** A pane's first listing landed (home, or the opener's folder when it was the same). */
  function listed(side: 'remote' | 'local', path: string, extra: object = {}): void {
    useSftpStore.setState((state) => {
      const files = serverFiles(state, 'srv-1');
      return {
        servers: {
          ...state.servers,
          'srv-1': { ...files, [side]: { ...files[side], path, loading: false }, ...extra },
        },
      };
    });
  }

  it('moves the server pane there once the session is ready and home is listed', () => {
    renderWindow(ROUTE);
    // Home listed but no session yet: nothing to move.
    act(() => listed('remote', '/home/deploy'));
    expect(goTo).not.toHaveBeenCalledWith('srv-1', 'remote', expect.anything());
    act(() => listed('remote', '/home/deploy', { status: 'ready', session: SESSION }));
    expect(goTo).toHaveBeenCalledWith('srv-1', 'remote', '/tmp/vis dark');
    // Once: later listings (the user moving on) are left alone.
    act(() => listed('remote', '/var', { status: 'ready', session: SESSION }));
    expect(goTo.mock.calls.filter(([, side]) => side === 'remote')).toHaveLength(1);
  });

  it('moves the local pane there once its first listing is in', () => {
    renderWindow(ROUTE);
    expect(goTo).not.toHaveBeenCalled();
    act(() => listed('local', 'C:/Users/me'));
    expect(goTo).toHaveBeenCalledWith('srv-1', 'local', '/home/me/site');
    act(() => listed('local', 'D:/'));
    expect(goTo.mock.calls.filter(([, side]) => side === 'local')).toHaveLength(1);
  });

  it('waits while a listing is still loading', () => {
    renderWindow(ROUTE);
    act(() =>
      useSftpStore.setState((state) => {
        const files = serverFiles(state, 'srv-1');
        return {
          servers: {
            ...state.servers,
            'srv-1': {
              ...files,
              status: 'ready',
              session: SESSION,
              remote: { ...files.remote, path: '/home/deploy', loading: true },
              local: { ...files.local, loading: true },
            },
          },
        };
      }),
    );
    expect(goTo).not.toHaveBeenCalled();
  });

  it('also moves a pane whose home listing failed', () => {
    renderWindow(ROUTE);
    act(() =>
      useSftpStore.setState((state) => {
        const files = serverFiles(state, 'srv-1');
        return {
          servers: {
            ...state.servers,
            'srv-1': { ...files, local: { ...files.local, loading: false, error: 'No home' } },
          },
        };
      }),
    );
    expect(goTo).toHaveBeenCalledWith('srv-1', 'local', '/home/me/site');
  });

  it('does not list again a folder the pane already shows', () => {
    renderWindow(ROUTE);
    act(() => listed('local', '/home/me/site'));
    expect(goTo).not.toHaveBeenCalled();
  });

  it('stays at home and says why when the folder is gone', async () => {
    goTo.mockResolvedValue({ status: 'failed', problem: 'That folder is not there anymore.' });
    renderWindow(ROUTE);
    act(() => listed('local', '/home/me'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not open /home/me/site: That folder is not there anymore.',
      ),
    );
  });

  it('starts at home without folders in the query', () => {
    renderWindow();
    act(() => listed('local', '/home/me'));
    act(() => listed('remote', '/home/deploy', { status: 'ready', session: SESSION }));
    expect(goTo).not.toHaveBeenCalled();
  });
});
