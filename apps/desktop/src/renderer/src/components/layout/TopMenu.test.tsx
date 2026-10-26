import { act, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useUpdateStore } from '@/stores/updateStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The top menu bar is the sidebar laid out sideways, so it has to reach the same places: the
 * ungrouped pages as links, every sidebar heading as a menu of its pages, Settings at the end,
 * the page you are on marked, and the same attention badges.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { NAV_GROUPS, NAV_ITEMS } = await import('./mainNav');
const { TopMenu } = await import('./TopMenu');
const { AboutDialog } = await import('./AboutDialog');

/** Shows the router's current path, so a test can see where a click went. */
function LocationProbe(): React.JSX.Element {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

/** The About dialog is mounted once in AppShell; it comes along here so the chip can open it. */
function renderTopMenu(route = '/', bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <TopMenu />
      <LocationProbe />
      <AboutDialog />
    </>,
    { route, bridge },
  );
}

const bar = (): HTMLElement => screen.getByRole('navigation', { name: 'Main menu' });

describe('TopMenu tabs', () => {
  it('shows the ungrouped pages as links', () => {
    renderTopMenu();

    for (const label of ['Dashboard', 'Workspace', 'Projects']) {
      const link = within(bar()).getByRole('link', { name: new RegExp(label) });
      expect(link).toHaveAttribute('href', NAV_ITEMS.find((item) => item.label === label)?.to);
    }
  });

  it('keeps the grouped pages off the bar until their menu opens', () => {
    renderTopMenu();

    expect(screen.queryByRole('link', { name: /Pipelines/ })).toBeNull();
    for (const group of NAV_GROUPS) {
      expect(within(bar()).getByRole('button', { name: new RegExp(group) })).toBeInTheDocument();
    }
  });

  it('marks the tab for the page being shown, and only that one', () => {
    renderTopMenu('/projects/abc');

    const current = screen.getAllByRole('link', { current: 'page' });
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Projects');
  });

  it('puts Settings at the end as a link', () => {
    renderTopMenu('/settings');

    const settings = within(bar()).getByRole('link', { name: /Settings/ });
    expect(settings).toHaveAttribute('href', '/settings');
    expect(settings).toHaveAttribute('aria-current', 'page');
  });

  it('puts Help next to Settings and keeps it out of the page tabs', () => {
    renderTopMenu('/help/vault');

    const help = within(bar()).getByRole('link', { name: /Help/ });
    expect(help).toHaveAttribute('href', '/help');
    expect(help).toHaveAttribute('aria-current', 'page');
    expect(within(bar()).getAllByRole('link', { name: /Help/ })).toHaveLength(1);
  });
});

describe('TopMenu group menus', () => {
  it('opens a group and lists its pages', async () => {
    const { user } = renderTopMenu();

    await user.click(screen.getByRole('button', { name: /Agents/ }));

    const menu = await screen.findByRole('menu');
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).toEqual(
      NAV_ITEMS.filter((item) => item.group === 'Agents').map((item) => item.label),
    );
    expect(within(menu).getByRole('menuitem', { name: /MCP Servers/ })).toHaveAttribute(
      'href',
      '/mcp',
    );
  });

  it('goes to the page picked from a menu and closes the menu behind it', async () => {
    const { user } = renderTopMenu('/');

    await user.click(screen.getByRole('button', { name: /Agents/ }));
    await user.click(await screen.findByRole('menuitem', { name: /MCP Servers/ }));

    expect(screen.getByTestId('path')).toHaveTextContent('/mcp');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('goes to a page picked with the keyboard too', async () => {
    const { user } = renderTopMenu('/');

    screen.getByRole('button', { name: /Ship/ }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    // Opening from the keyboard lands on Pipelines, the first entry; one step down is Deploy.
    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/deploy$/);
  });

  it('marks the group holding the page being shown', () => {
    renderTopMenu('/mcp');

    expect(screen.getByRole('button', { name: /Agents/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /Build/ })).not.toHaveAttribute('aria-current');
    expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0);
  });

  it('keeps Build marked on Prompt History, which sits under Prompt Builder', async () => {
    const { user } = renderTopMenu('/prompt-history');

    const build = screen.getByRole('button', { name: /Build/ });
    expect(build).toHaveAttribute('aria-current', 'true');

    await user.click(build);
    expect(await screen.findByRole('menuitem', { name: /Prompt Builder/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the dashboard only at the root, not under every page', () => {
    renderTopMenu('/usage');

    expect(screen.getByRole('link', { name: /Dashboard/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: /Agents/ })).toHaveAttribute('aria-current', 'true');
  });
});

describe('TopMenu badges', () => {
  it('dots the Ship menu and counts inside it when pipeline results are unread', async () => {
    const { user } = renderTopMenu('/', { 'appNotifications.unreadCount': async () => 3 });

    const ship = await screen.findByRole('button', { name: /Ship.*3 unread/ });
    expect(screen.getByRole('button', { name: /Build/ }).textContent).not.toContain('unread');

    await user.click(ship);
    const pipelines = await screen.findByRole('menuitem', { name: /Pipelines/ });
    expect(within(pipelines).getByText('3')).toBeInTheDocument();
  });

  it('leaves Ship plain when nothing is unread', async () => {
    renderTopMenu('/', { 'appNotifications.unreadCount': async () => 0 });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Ship/ }).textContent).not.toContain('unread'),
    );
  });

  it('flags the Workspace tab when an agent is waiting for an answer', async () => {
    renderTopMenu('/');
    expect(screen.getByRole('link', { name: /Workspace/ }).textContent).toBe('Workspace');

    act(() => useAgentStatusStore.setState({ statuses: { 'tab-1': 'needs-input' } }));

    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: /Workspace, an agent needs your input/ }),
      ).toBeTruthy(),
    );
  });
});

describe('TopMenu version and updates', () => {
  it('opens About from the version chip, without starting an update check', async () => {
    const { user, bridge } = renderTopMenu('/', { 'app.getVersion': async () => '2.4.1' });

    const button = await screen.findByRole('button', { name: /Runova v2\.4\.1/ });
    expect(button.textContent).toBe('v2.4.1');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(button);

    expect(await screen.findByRole('dialog', { name: 'About Runova' })).toBeInTheDocument();
    expect(() => bridge.$fn('app.checkForUpdates')).toThrow(/not been touched/);
  });

  it('keeps the update check reachable from the bar, through About', async () => {
    const { user } = renderTopMenu('/', {
      'app.getVersion': async () => '2.4.1',
      'app.checkForUpdates': async () => ({ state: 'not-available' }),
    });

    await user.click(await screen.findByRole('button', { name: /Runova v2\.4\.1/ }));
    const about = await screen.findByRole('dialog', { name: 'About Runova' });
    await user.click(within(about).getByRole('button', { name: 'Check for updates' }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("You're on the latest version."),
    );
  });

  it('names the maker on the version chip, and its hint says it opens About', async () => {
    const { user } = renderTopMenu('/', { 'app.getVersion': async () => '2.4.1' });

    const button = await screen.findByRole('button', {
      name: 'Runova v2.4.1, by SmartClouds, about',
    });
    await user.hover(button);

    expect((await screen.findAllByText('About Runova')).length).toBeGreaterThan(0);
  });

  it('keeps the update dot on the chip when an update is waiting', async () => {
    renderTopMenu('/', { 'app.getVersion': async () => '2.4.1' });
    const button = await screen.findByRole('button', { name: /Runova v2\.4\.1/ });
    const quiet = button.childElementCount;

    act(() =>
      useUpdateStore.setState({
        status: {
          state: 'available',
          info: { version: '3.0.0', releaseDate: null, releaseNotes: null, sizeBytes: null },
          partialBytes: 0,
        },
      }),
    );

    expect(button.childElementCount).toBe(quiet + 1);
    expect(button).toHaveAccessibleName('Runova v2.4.1, by SmartClouds, update available, about');
  });

  it('shows a check in progress on the chip', async () => {
    renderTopMenu('/', { 'app.getVersion': async () => '2.4.1' });
    const button = await screen.findByRole('button', { name: /Runova v2\.4\.1/ });

    act(() => useUpdateStore.setState({ status: { state: 'checking' } }));

    expect(button.textContent).toBe('Checking…');
    expect(button).toHaveAccessibleName(/checking for updates/);
  });
});
