import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type TerminalSessionMeta, useTerminalStore } from '@/stores/terminalStore';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';

/**
 * The drawer's frame: it is its own rounded island, the same on a page and on the Workspace
 * (only the gutters change), and hiding it keeps the terminals mounted so their shells keep
 * streaming. xterm and the AI dialogs are stubbed, since only the shell is under test here.
 */

vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ meta }: { meta: TerminalSessionMeta }) => (
    <div data-testid="terminal-pane">{meta.id}</div>
  ),
}));
vi.mock('./SshAskAiDialog', () => ({
  SshAskAiDialog: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="ask-ai-dialog">{sessionId}</div>
  ),
}));
vi.mock('./SshAgentHistoryDialog', () => ({
  SshAgentHistoryDialog: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="history-dialog">{sessionId}</div>
  ),
}));
vi.mock('./SshAgentStatusBar', () => ({
  SshAgentStatusBar: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="agent-status">{sessionId}</div>
  ),
}));
vi.mock('@/components/sftp/SftpDockPane', () => ({
  SftpDockPane: ({ serverId, active }: { serverId: string; active: boolean }) => (
    <div data-testid="sftp-dock" data-server={serverId} data-active={String(active)} />
  ),
}));

const { TerminalDrawer } = await import('./TerminalDrawer');
const { openSftpDock } = await import('@/lib/sftp/dock');

const sessions: TerminalSessionMeta[] = [
  { id: 's1', kind: 'local', title: 'PowerShell' },
  { id: 's2', kind: 'local', title: 'Command Prompt' },
];

let pathname = '';
function LocationProbe(): null {
  pathname = useLocation().pathname;
  return null;
}

function renderDrawer(props: React.ComponentProps<typeof TerminalDrawer> = {}) {
  const view = render(
    <MemoryRouter initialEntries={['/projects']}>
      <TooltipProvider>
        <TerminalDrawer {...props} />
      </TooltipProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
  const shell = (): HTMLElement => screen.getByRole('region', { name: 'Terminal', hidden: true });
  // The island is the frame's last child: the resize grip sits before it, in the gap above.
  const island = (): HTMLElement => shell().lastElementChild as HTMLElement;
  return { ...view, shell, island };
}

beforeEach(() => {
  useTerminalStore.setState({
    isOpen: true,
    drawerHeight: 300,
    isMaximized: false,
    sessions,
    activeSessionId: 's1',
  });
});

afterEach(() => {
  useTerminalStore.setState({
    isOpen: false,
    isMaximized: false,
    sessions: [],
    activeSessionId: null,
  });
});

describe('TerminalDrawer shell', () => {
  it('calls the new-tab buttons Terminal on every platform, never the shell name', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      installRunovaBridge({ platform });
      useTerminalStore.setState({ sessions: [], activeSessionId: null });
      const view = renderDrawer();
      // The empty-state button and the tab-strip icon button both open a plain terminal.
      expect(screen.getAllByRole('button', { name: /^New Terminal/ }).length).toBeGreaterThan(0);
      expect(screen.getByText('New Terminal')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /New (zsh|bash|PowerShell)/ })).toBeNull();
      expect(screen.queryByText(/New (zsh|bash|PowerShell)/)).toBeNull();
      view.unmount();
    }
  });

  it('draws the drawer as its own island, sized from the store', () => {
    const { shell, island } = renderDrawer();

    expect(shell()).not.toHaveClass('hidden');
    expect(island()).toHaveClass('chrome-island');
    expect(island()).toHaveStyle({ height: '300px' });
    // An island in the flow, not an overlay pinned over the page.
    expect(shell()).not.toHaveClass('absolute');
    expect(shell()).toHaveClass('mb-1.5');
  });

  it('keeps the same island on a page and on the Workspace, with gutters to match each', () => {
    const page = renderDrawer({ placement: 'page' });
    const pageIsland = page.island().className;
    expect(page.shell()).toHaveClass('mx-2');
    page.unmount();

    const workspace = renderDrawer({ placement: 'workspace' });
    expect(workspace.island().className).toBe(pageIsland);
    // The Workspace's panes and project panel are inset 6px, so the drawer lines up with them.
    expect(workspace.shell()).toHaveClass('mx-1.5');
    expect(workspace.shell()).not.toHaveClass('mx-2');
  });

  it('puts the resize grip above the island, outside its clipped corners', () => {
    const { island } = renderDrawer();
    const grip = screen.getByRole('separator', { name: 'Resize terminal' });

    expect(island().contains(grip)).toBe(false);
    expect(grip.nextElementSibling).toBe(island());
  });

  it('hides on close without unmounting the terminals', () => {
    const { shell } = renderDrawer();
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Close terminal panel' }));

    expect(useTerminalStore.getState().isOpen).toBe(false);
    expect(shell()).toHaveClass('hidden');
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2);

    act(() => useTerminalStore.getState().openDrawer());
    expect(shell()).not.toHaveClass('hidden');
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2);
  });

  it('moves the tabs without moving the terminals behind them', () => {
    renderDrawer();
    const tabNames = (): (string | null)[] =>
      screen.getAllByRole('tab').map((tab) => tab.textContent);
    const panes = screen.getAllByTestId('terminal-pane');
    expect(tabNames()).toEqual(['PowerShell', 'Command Prompt']);

    act(() => useTerminalStore.getState().moveSession(0, 1));

    expect(tabNames()).toEqual(['Command Prompt', 'PowerShell']);
    // Taking a terminal out of the page and putting it back costs it its scroll position and its
    // keyboard focus, and the panes sit on top of each other, so their order is never seen.
    const after = screen.getAllByTestId('terminal-pane');
    expect(after).toHaveLength(2);
    after.forEach((pane, index) => {
      expect(pane).toBe(panes[index]);
    });
    expect(after.map((pane) => pane.textContent)).toEqual(['s1', 's2']);
  });

  it('treats closing a run tab as stopping the run, and offers its Docker containers', async () => {
    const runningForProject = vi.fn(async () => []);
    installRunovaBridge({ 'docker.runningForProject': runningForProject });
    useTerminalStore.setState({
      sessions: [
        { id: 's1', kind: 'local', title: 'PowerShell', cwd: 'E:\\shop' },
        {
          id: 'dev',
          kind: 'local',
          title: 'Web Shop',
          cwd: 'E:\\shop',
          run: {
            commandId: 'dev',
            label: 'Dev',
            command: 'docker compose up -d',
            kind: 'web',
            startedAt: 1,
          },
        },
      ],
      activeSessionId: 's1',
    });
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Close PowerShell' }));
    // A plain shell is just closed: there is no run whose containers could be left behind.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runningForProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close Web Shop' }));
    await vi.waitFor(() => expect(runningForProject).toHaveBeenCalledWith('E:\\shop'));
    expect(useTerminalStore.getState().sessions).toEqual([]);
  });

  it('stays hidden while asked to, even when open', () => {
    const { shell } = renderDrawer({ hidden: true });
    expect(shell()).toHaveClass('hidden');
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2);
  });

  it('fills the page area when maximized, inset like the island it replaces', () => {
    const { shell, island } = renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal' }));

    // In the store, so the shell can hide the page under it.
    expect(useTerminalStore.getState().isMaximized).toBe(true);
    expect(shell()).toHaveClass('absolute', 'inset-x-2', 'top-0', 'bottom-1.5');
    expect(island()).toHaveClass('chrome-island', 'flex-1');
    expect(island().style.height).toBe('');
    expect(screen.queryByRole('separator', { name: 'Resize terminal' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Restore terminal' }));
    expect(shell()).not.toHaveClass('absolute');
    expect(island()).toHaveStyle({ height: '300px' });
  });

  it('insets the maximized drawer like the Workspace panes on the Workspace', () => {
    const { shell } = renderDrawer({ placement: 'workspace' });

    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal' }));

    expect(shell()).toHaveClass('absolute', 'inset-1.5');
  });
});

describe('TerminalDrawer SFTP files button', () => {
  it('opens the file manager of the server behind an SSH tab', () => {
    useTerminalStore.setState({
      sessions: [{ id: 'ssh1', kind: 'ssh', title: 'prod', sshServerId: 'srv-7' }],
      activeSessionId: 'ssh1',
    });
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Browse files over SFTP' }));
    expect(pathname).toBe('/ssh-files/srv-7');
  });

  it('is not offered on a local tab or an SSH tab with no saved server', () => {
    const view = renderDrawer();
    expect(screen.queryByRole('button', { name: 'Browse files over SFTP' })).toBeNull();
    view.unmount();

    useTerminalStore.setState({
      sessions: [{ id: 'ssh2', kind: 'ssh', title: 'typed by hand' }],
      activeSessionId: 'ssh2',
    });
    renderDrawer();
    expect(screen.queryByRole('button', { name: 'Browse files over SFTP' })).toBeNull();
  });
});

describe('TerminalDrawer file manager tab', () => {
  const files: TerminalSessionMeta = {
    id: 'f1',
    kind: 'sftp',
    title: 'prod',
    sftpServerId: 'srv-7',
  };

  it('shows the server files instead of a terminal, with nothing that needs a shell', () => {
    useTerminalStore.setState({ sessions: [files], activeSessionId: 'f1' });
    const { island } = renderDrawer();

    const tab = screen.getByRole('tab', { name: /prod/ });
    expect(tab.querySelector('[data-sftp-tab]')).not.toBeNull();
    const dock = screen.getByTestId('sftp-dock');
    expect(dock).toHaveAttribute('data-server', 'srv-7');
    expect(dock).toHaveAttribute('data-active', 'true');
    expect(screen.queryByTestId('terminal-pane')).toBeNull();

    for (const name of ['Ask AI to run a task here', 'AI task history', 'Browse files over SFTP']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByTestId('ask-ai-dialog')).toBeNull();
    expect(screen.queryByTestId('history-dialog')).toBeNull();
    expect(screen.queryByTestId('agent-status')).toBeNull();
    expect(screen.getByText('SFTP')).toBeInTheDocument();
    // The glass panes sit on the island, not on the dark terminal fill.
    expect(island().querySelector('.terminal-well')).toBeNull();
    // A new terminal is still one click away.
    expect(screen.getByRole('button', { name: /^New Terminal/ })).toBeInTheDocument();
  });

  it('keeps the files mounted but not on screen behind a shell tab or a shut drawer', () => {
    useTerminalStore.setState({ sessions: [sessions[0] as TerminalSessionMeta, files] });
    useTerminalStore.setState({ activeSessionId: 's1' });
    renderDrawer();

    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1);
    expect(screen.getByTestId('sftp-dock')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('ask-ai-dialog')).toHaveTextContent('s1');
    expect(screen.queryByText('SFTP')).toBeNull();

    act(() => useTerminalStore.getState().setActiveSession('f1'));
    expect(screen.getByTestId('sftp-dock')).toHaveAttribute('data-active', 'true');

    act(() => useTerminalStore.getState().closeDrawer());
    expect(screen.getByTestId('sftp-dock')).toHaveAttribute('data-active', 'false');
  });

  it('closes without ending anything: the SFTP session stays for the page and the window', async () => {
    const runningForProject = vi.fn(async () => []);
    const bridge = installRunovaBridge({ 'docker.runningForProject': runningForProject });
    useTerminalStore.setState({ sessions: [files], activeSessionId: 'f1' });
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Close prod' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useTerminalStore.getState().sessions).toEqual([]);
    expect(() => bridge.$fn('terminal.kill')).toThrow();
    expect(() => bridge.$fn('ssh.kill')).toThrow();
    expect(runningForProject).not.toHaveBeenCalled();
  });

  it("names the files tab apart from the same server's SSH tab", () => {
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useTerminalStore.getState().openSshSession({ id: 'srv-7', nickname: 'prod' } as never);
    openSftpDock('srv-7', 'prod');
    renderDrawer();

    expect(screen.getByRole('tab', { name: 'prod' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Files: prod' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Close Files: prod' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close prod' })).toBeInTheDocument();
  });

  it('draws nothing for a file manager tab with no server', () => {
    useTerminalStore.setState({
      sessions: [{ id: 'f2', kind: 'sftp', title: 'lost' }],
      activeSessionId: 'f2',
    });
    renderDrawer();
    expect(screen.queryByTestId('sftp-dock')).toBeNull();
    expect(screen.queryByTestId('terminal-pane')).toBeNull();
  });
});
