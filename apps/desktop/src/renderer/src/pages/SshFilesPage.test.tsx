import type { SshSavedServer } from '@shared/apiTypes';
import type { SftpQueueSnapshot, SftpSessionInfo } from '@shared/sftpTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshFilesViewProps } from '@/components/sftp/SshFilesView';
import { usePageHeaderStore } from '@/stores/pageHeaderStore';
import { resetSftpStore, useSftpStore } from '@/stores/sftpStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';
import SshFilesPage from './SshFilesPage';

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

vi.mock('@/lib/sftp/dock', () => ({ openSftpDock: vi.fn(), closeSftpDock: vi.fn() }));

/** The file manager has tests of its own (SshFilesView.test); here only what the page adds. */
const seen = vi.hoisted(() => ({ views: [] as SshFilesViewProps[] }));
vi.mock('@/components/sftp/SshFilesView', () => ({
  SshFilesView: (props: SshFilesViewProps) => {
    seen.views.push(props);
    return (
      <div data-testid="sftp-view" data-server={props.serverId}>
        {props.viewActions}
      </div>
    );
  },
}));

/**
 * `/ssh-files/:serverId` (E25): the page names the server in its header and draws the file
 * manager as its page variant. With no server in the route it points to Remote.
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

const EMPTY_QUEUE: SftpQueueSnapshot = {
  sessionId: 'sess-1',
  batches: [],
  conflict: null,
  pendingConflicts: 0,
};

const BRIDGE = {
  'ssh.listServers': [SERVER],
  'sftp.open': SESSION,
  'sftp.queue': EMPTY_QUEUE,
  'sftp.list': { path: '/home/deploy', parent: '/home', entries: [] },
};

beforeEach(() => {
  resetSftpStore();
  seen.views.length = 0;
  usePageHeaderStore.setState({ title: '', subtitle: undefined });
});

describe('SshFilesPage', () => {
  it('names the server in the header once it is known', async () => {
    renderWithProviders(<SshFilesPage />, {
      route: '/ssh-files/srv-1',
      path: 'ssh-files/:serverId',
      bridge: BRIDGE,
    });
    // Before anything is known the header still says what the page is.
    expect(usePageHeaderStore.getState().title).toBe('Files: server');
    // The view (mocked here) is what connects.
    await useSftpStore.getState().connect('srv-1');
    await waitFor(() => expect(usePageHeaderStore.getState().title).toBe('Files: prod'));
    expect(usePageHeaderStore.getState().subtitle).toBe('deploy@prod.example:2222');
  });

  it('draws the file manager as the page variant, for the server in the route', () => {
    renderWithProviders(<SshFilesPage />, {
      route: '/ssh-files/srv-1',
      path: 'ssh-files/:serverId',
      bridge: BRIDGE,
    });
    expect(screen.getByTestId('sftp-view').dataset.server).toBe('srv-1');
    expect(seen.views.at(-1)).toMatchObject({ serverId: 'srv-1', variant: 'page' });
  });

  it('hands the view the page switch: to the panel or to a window of its own', () => {
    renderWithProviders(<SshFilesPage />, {
      route: '/ssh-files/srv-1',
      path: 'ssh-files/:serverId',
      bridge: BRIDGE,
    });
    const view = screen.getByTestId('sftp-view');
    expect(within(view).getByRole('button', { name: 'Show in panel' })).toBeTruthy();
    expect(within(view).getByRole('button', { name: 'Open in a new window' })).toBeTruthy();
    expect(within(view).queryByRole('button', { name: 'Open as page' })).toBeNull();
  });

  it('asks for a server when the route names none, and points to Remote', async () => {
    const { user } = renderWithProviders(<SshFilesPage />, {
      route: '/ssh-files',
      path: 'ssh-files',
      bridge: BRIDGE,
    });
    expect(screen.getByText('No server picked')).toBeTruthy();
    expect(screen.queryByTestId('sftp-view')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Remote' }));
    await waitFor(() => expect(screen.queryByText('No server picked')).toBeNull());
  });
});
