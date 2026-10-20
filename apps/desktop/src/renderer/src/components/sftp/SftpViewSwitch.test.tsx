import type { SftpSessionInfo } from '@shared/sftpTypes';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { resetSftpStore, serverFiles, useSftpStore } from '@/stores/sftpStore';
import { type FakeBridge, installAgentmatBridge } from '../../../../test/renderer/agentmatBridge';
import {
  isFilesPageOf,
  previousRoute,
  SftpViewSwitch,
  type SftpViewVariant,
} from './SftpViewSwitch';

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const dock = vi.hoisted(() => ({ openSftpDock: vi.fn(), closeSftpDock: vi.fn() }));
vi.mock('@/lib/sftp/dock', () => dock);

/**
 * The buttons that move the file manager between the page, the bottom panel and its own window
 * (E25). Each one does its move, then gets the user out of the way of the new view.
 */

const SESSION: SftpSessionInfo = {
  sessionId: 'sess-1',
  serverId: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'deploy',
  home: '/home/deploy',
};

function withSession(folders: { remote?: string; local?: string } = {}): void {
  useSftpStore.setState((state) => {
    const files = serverFiles(state, 'srv-1');
    return {
      servers: {
        ...state.servers,
        'srv-1': {
          ...files,
          session: SESSION,
          status: 'ready',
          remote: { ...files.remote, path: folders.remote ?? null },
          local: { ...files.local, path: folders.local ?? null },
        },
      },
    };
  });
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

let bridge: FakeBridge;

/** The page's own URL with an app route in its hash, the way HashRouter writes history. */
function appUrl(route: string): string {
  return `${window.location.origin}${window.location.pathname}#${route}`;
}

/**
 * Chromium's Navigation API, which is how the switch sees the entry before this one. Null takes
 * it away, the way an engine without it would.
 */
function installNavigation(urls: string[] | null): void {
  const value =
    urls === null
      ? undefined
      : {
          currentEntry: { url: urls.at(-1) ?? null, index: urls.length - 1 },
          entries: () => urls.map((url, index) => ({ url, index })),
        };
  Object.defineProperty(window, 'navigation', { value, configurable: true, writable: true });
}

function renderSwitch(
  variant: SftpViewVariant,
  entries: string[] = ['/docker', '/ssh-files/srv-1'],
  browserHistory: string[] | null = entries.map(appUrl),
): ReturnType<typeof userEvent.setup> {
  installNavigation(browserHistory);
  const user = userEvent.setup();
  render(
    <TooltipProvider delayDuration={0}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <SftpViewSwitch serverId="srv-1" variant={variant} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
  return user;
}

const where = (): string | null => screen.getByTestId('where').textContent;

beforeEach(() => {
  resetSftpStore();
  vi.clearAllMocks();
  bridge = installAgentmatBridge({
    'sftp.popOut': async () => undefined,
    'sftp.backToMain': async () => undefined,
  });
});

afterEach(() => {
  installNavigation(null);
});

describe('previousRoute', () => {
  it('reads the app route of the entry before this one, query left out', () => {
    installNavigation([appUrl('/docker?tab=images'), appUrl('/ssh-files/srv-1')]);
    expect(previousRoute()).toBe('/docker');
    installNavigation([appUrl(''), appUrl('/ssh-files/srv-1')]);
    expect(previousRoute()).toBe('/');
  });

  it('cannot know it on the first entry, from another page, or without the Navigation API', () => {
    installNavigation([appUrl('/ssh-files/srv-1')]);
    expect(previousRoute()).toBeNull();
    installNavigation(['https://example.com/#/docker', appUrl('/ssh-files/srv-1')]);
    expect(previousRoute()).toBeNull();
    installNavigation(['not a url', appUrl('/ssh-files/srv-1')]);
    expect(previousRoute()).toBeNull();
    installNavigation(null);
    expect(previousRoute()).toBeNull();
  });
});

describe('isFilesPageOf', () => {
  it('matches only the file manager page of that server', () => {
    expect(isFilesPageOf('/ssh-files/srv-1', 'srv-1')).toBe(true);
    expect(isFilesPageOf('/ssh-files/srv%201/', 'srv 1')).toBe(true);
    expect(isFilesPageOf('/ssh-files/srv-2', 'srv-1')).toBe(false);
    expect(isFilesPageOf('/remote', 'srv-1')).toBe(false);
    expect(isFilesPageOf('/ssh-files/%E0%A4%A', 'srv-1')).toBe(false);
  });
});

describe('SftpViewSwitch on the page', () => {
  it('shows the file manager in the panel, then goes back to where the user was', async () => {
    withSession();
    const user = renderSwitch('page');
    await user.click(screen.getByRole('button', { name: 'Show in panel' }));
    expect(dock.openSftpDock).toHaveBeenCalledWith('srv-1', 'prod');
    await waitFor(() => expect(where()).toBe('/docker'));
  });

  it('goes to Remote when going back would land on this same page', async () => {
    // The status bar's "Open file manager" and the drawer's Browse push the page again.
    withSession();
    const user = renderSwitch('page', ['/docker', '/ssh-files/srv-1', '/ssh-files/srv-1']);
    await user.click(screen.getByRole('button', { name: 'Show in panel' }));
    await waitFor(() => expect(where()).toBe('/remote'));
  });

  it('goes to Remote when the entry before cannot be known', async () => {
    withSession();
    const user = renderSwitch('page', ['/docker', '/ssh-files/srv-1'], null);
    await user.click(screen.getByRole('button', { name: 'Open in a new window' }));
    await waitFor(() => expect(where()).toBe('/remote'));
  });

  it('goes to Remote after docking when the page was the first thing shown', async () => {
    const user = renderSwitch('page', ['/ssh-files/srv-1']);
    await user.click(screen.getByRole('button', { name: 'Show in panel' }));
    // Not connected yet: the panel is still named after the server it opens.
    expect(dock.openSftpDock).toHaveBeenCalledWith('srv-1', 'server');
    await waitFor(() => expect(where()).toBe('/remote'));
  });

  it('opens a new window for the session, then frees this one', async () => {
    withSession();
    const user = renderSwitch('page');
    await user.click(screen.getByRole('button', { name: 'Open in a new window' }));
    expect(bridge.$fn('sftp.popOut')).toHaveBeenCalledWith('sess-1', {});
    await waitFor(() => expect(where()).toBe('/docker'));
    expect(dock.closeSftpDock).not.toHaveBeenCalled();
  });

  it('opens the new window at the folders both panes show', async () => {
    withSession({ remote: '/tmp/vis-dark', local: '/home/me/site' });
    const user = renderSwitch('page');
    await user.click(screen.getByRole('button', { name: 'Open in a new window' }));
    expect(bridge.$fn('sftp.popOut')).toHaveBeenCalledWith('sess-1', {
      remotePath: '/tmp/vis-dark',
      localPath: '/home/me/site',
    });
  });

  it('sends only the folders a pane has listed', async () => {
    withSession({ remote: '/srv' });
    const user = renderSwitch('dock', ['/docker']);
    await user.click(screen.getByRole('button', { name: 'Open in a new window' }));
    expect(bridge.$fn('sftp.popOut')).toHaveBeenCalledWith('sess-1', { remotePath: '/srv' });
  });

  it('cannot open a new window before there is a session', () => {
    renderSwitch('page');
    expect(
      (screen.getByRole('button', { name: 'Open in a new window' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('stays on the page and says why when the window does not open', async () => {
    withSession();
    bridge.$set('sftp.popOut', async () => {
      throw new Error('No window for you');
    });
    const user = renderSwitch('page');
    await user.click(screen.getByRole('button', { name: 'Open in a new window' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No window for you')),
    );
    expect(toast.error.mock.calls[0]?.[0]).toContain('Could not open prod in a new window');
    expect(where()).toBe('/ssh-files/srv-1');
  });

  it('stays on the page and says why when the panel does not open', async () => {
    dock.openSftpDock.mockImplementationOnce(() => {
      throw new Error('No drawer');
    });
    const user = renderSwitch('page');
    await user.click(screen.getByRole('button', { name: 'Show in panel' }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No drawer'));
    expect(where()).toBe('/ssh-files/srv-1');
  });
});

describe('SftpViewSwitch in the panel', () => {
  it('opens the page and closes the panel tab', async () => {
    withSession();
    const user = renderSwitch('dock', ['/docker']);
    expect(screen.queryByRole('button', { name: 'Show in panel' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open as page' }));
    await waitFor(() => expect(where()).toBe('/ssh-files/srv-1'));
    expect(dock.closeSftpDock).toHaveBeenCalledWith('srv-1');
  });

  it('opens a new window and closes the panel tab, leaving the route alone', async () => {
    withSession();
    const user = renderSwitch('dock', ['/', '/docker']);
    await user.click(screen.getByRole('button', { name: 'Open in a new window' }));
    expect(bridge.$fn('sftp.popOut')).toHaveBeenCalledWith('sess-1', {});
    await waitFor(() => expect(dock.closeSftpDock).toHaveBeenCalledWith('srv-1'));
    expect(where()).toBe('/docker');
  });

  it('keeps the panel tab when the window does not open', async () => {
    withSession();
    bridge.$set('sftp.popOut', async () => {
      throw new Error('Gone');
    });
    const user = renderSwitch('dock', ['/docker']);
    await user.click(screen.getByRole('button', { name: 'Open in a new window' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(dock.closeSftpDock).not.toHaveBeenCalled();
  });
});

describe('SftpViewSwitch in the pop-out window', () => {
  it('only offers the way back to the main window', async () => {
    withSession();
    const user = renderSwitch('window', ['/sftp-window']);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Back to main window' }));
    expect(bridge.$fn('sftp.backToMain')).toHaveBeenCalledTimes(1);
    expect(where()).toBe('/sftp-window');
  });

  it('says so when the main window cannot be reached', async () => {
    bridge.$set('sftp.backToMain', async () => {
      throw new Error('Main window closed');
    });
    const user = renderSwitch('window', ['/sftp-window']);
    await user.click(screen.getByRole('button', { name: 'Back to main window' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Main window closed')),
    );
  });
});
