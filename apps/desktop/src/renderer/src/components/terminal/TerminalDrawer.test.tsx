import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type TerminalSessionMeta, useTerminalStore } from '@/stores/terminalStore';
import { installAgentmatBridge } from '../../../../test/renderer/agentmatBridge';

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
vi.mock('./SshAskAiDialog', () => ({ SshAskAiDialog: () => null }));
vi.mock('./SshAgentHistoryDialog', () => ({ SshAgentHistoryDialog: () => null }));
vi.mock('./SshAgentStatusBar', () => ({ SshAgentStatusBar: () => null }));

const { TerminalDrawer } = await import('./TerminalDrawer');

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
      installAgentmatBridge({ platform });
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

  it('treats closing a run tab as stopping the run, and offers its Docker containers', async () => {
    const runningForProject = vi.fn(async () => []);
    installAgentmatBridge({ 'docker.runningForProject': runningForProject });
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
