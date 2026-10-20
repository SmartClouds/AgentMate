import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { SshFilesViewProps } from './SshFilesView';

/**
 * A server's file manager as a terminal drawer tab (E25 F6). The view itself has its own tests;
 * here only what the tab hands it counts, and when it steps aside for the page.
 */

const seen = vi.hoisted(() => ({ views: [] as SshFilesViewProps[] }));
vi.mock('./SshFilesView', () => ({
  SshFilesView: (props: SshFilesViewProps) => {
    seen.views.push(props);
    return (
      <div data-testid="files-view" data-variant={props.variant}>
        {props.viewActions}
      </div>
    );
  },
}));
vi.mock('./SftpViewSwitch', () => ({
  SftpViewSwitch: ({ serverId, variant }: { serverId: string; variant: string }) => (
    <div data-testid="view-switch" data-server={serverId} data-variant={variant} />
  ),
}));

const { SftpDockPane } = await import('./SftpDockPane');

function renderPane(route = '/dashboard', active = true) {
  return renderWithProviders(<SftpDockPane serverId="srv-1" active={active} />, { route });
}

beforeEach(() => {
  seen.views.length = 0;
  useTerminalStore.setState({ isOpen: true, isMaximized: false, sessions: [] });
});

describe('SftpDockPane', () => {
  it('draws the compact view with the dock view switch, counted as shown while active', () => {
    renderPane();

    expect(screen.getByTestId('files-view')).toHaveAttribute('data-variant', 'dock');
    const props = seen.views.at(-1);
    expect(props).toMatchObject({ serverId: 'srv-1', variant: 'dock', trackVisibility: true });
    const toggle = screen.getByTestId('view-switch');
    expect(toggle).toHaveAttribute('data-server', 'srv-1');
    expect(toggle).toHaveAttribute('data-variant', 'dock');
  });

  it('stays mounted but hidden and uncounted behind another tab or a shut drawer', () => {
    const { container } = renderPane('/dashboard', false);

    expect(screen.getByTestId('files-view')).toBeInTheDocument();
    expect(container.querySelector('[data-sftp-dock="srv-1"]')).toHaveClass('hidden');
    expect(seen.views.at(-1)?.trackVisibility).toBe(false);
  });

  it("steps aside on the same server's page, so the window never draws it twice", async () => {
    const { user } = renderPane('/ssh-files/srv-1');

    expect(screen.queryByTestId('files-view')).toBeNull();
    expect(screen.getByText('Shown on the page')).toBeInTheDocument();

    useTerminalStore.setState({ isMaximized: true });
    await user.click(screen.getByRole('button', { name: 'Show the page' }));
    expect(useTerminalStore.getState()).toMatchObject({ isOpen: false, isMaximized: false });
  });

  it("keeps showing the files on another server's page", () => {
    renderPane('/ssh-files/srv-2');
    expect(screen.getByTestId('files-view')).toBeInTheDocument();
    expect(screen.queryByText('Shown on the page')).toBeNull();
  });

  it('hides the placeholder too while the tab is not on screen', () => {
    const { container } = renderPane('/ssh-files/srv-1', false);
    expect(container.querySelector('[data-sftp-dock="srv-1"]')).toHaveClass('hidden');
  });
});
