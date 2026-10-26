import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useUiStore } from '@/stores/uiStore';
import { useUpdateStore } from '@/stores/updateStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The sidebar is how the app is navigated, so the things worth pinning down are: every entry is
 * a real link, the entry for the page you are on is marked current, and the badges that pull
 * attention (unread pipeline failures, an agent waiting on you) only appear when they should.
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

const { NAV_GROUPS, NAV_ITEMS, Sidebar } = await import('./Sidebar');
const { AboutDialog } = await import('./AboutDialog');

/** The About dialog is mounted once in AppShell; it comes along here so the card can open it. */
function renderSidebar(route = '/', bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <Sidebar />
      <AboutDialog />
    </>,
    { route, bridge },
  );
}

/** The link marked as the current page by NavLink. */
function currentLink(): HTMLElement {
  return screen.getByRole('link', { current: 'page' });
}

describe('Sidebar navigation', () => {
  it('lists every destination as a link', () => {
    renderSidebar();

    for (const item of NAV_ITEMS) {
      expect(screen.getByRole('link', { name: new RegExp(item.label) })).toBeTruthy();
    }
  });

  it('marks the dashboard current at the root, and only the dashboard', () => {
    renderSidebar('/');

    expect(currentLink().textContent).toContain('Dashboard');
    expect(screen.getAllByRole('link', { current: 'page' })).toHaveLength(1);
  });

  it('marks the entry for the page being shown', () => {
    renderSidebar('/mcp');

    expect(currentLink().textContent).toContain('MCP Servers');
  });

  it('keeps a nested route under its own entry', () => {
    renderSidebar('/projects/abc');

    expect(currentLink().textContent).toContain('Projects');
  });

  it('keeps Prompt Builder lit on Prompt History, which has no entry of its own', () => {
    renderSidebar('/prompt-history');

    expect(screen.getByRole('link', { name: /Prompt Builder/ }).textContent).toContain(
      'Prompt Builder',
    );
    // Prompt History is reached from the builder, so the builder is what stays highlighted.
    expect(screen.queryByRole('link', { name: /Prompt History/ })).toBeNull();
  });

  it('collapses to icons only, keeping the links reachable', () => {
    renderSidebar('/usage');
    act(() => useUiStore.setState({ sidebarMode: 'collapsed' }));

    // The labels go, the links stay, and the current page is still marked.
    expect(screen.queryByText('Token Usage')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(NAV_ITEMS.length);
    expect(currentLink().getAttribute('href')).toContain('/usage');
  });

  it('sorts the tools under headed groups', () => {
    renderSidebar();

    for (const group of NAV_GROUPS) {
      const section = screen.getByRole('group', { name: group });
      expect(within(section).getByText(group)).toBeTruthy();
    }
    const ship = screen.getByRole('group', { name: 'Ship' });
    expect(within(ship).getByRole('link', { name: /Pipelines/ })).toBeTruthy();
    expect(within(ship).queryByRole('link', { name: /Dashboard/ })).toBeNull();
  });

  it('keeps Settings out of the scrolling list, pinned below it', () => {
    renderSidebar('/settings');

    const list = screen.getByRole('navigation');
    expect(within(list).queryByRole('link', { name: /Settings/ })).toBeNull();
    expect(currentLink().textContent).toContain('Settings');
  });

  it('pins Help beside Settings, out of the scrolling list', () => {
    renderSidebar('/help');

    const list = screen.getByRole('navigation');
    expect(within(list).queryByRole('link', { name: /Help/ })).toBeNull();
    expect(currentLink().textContent).toContain('Help');
    expect(currentLink()).toHaveAttribute('href', '/help');
  });

  it('keeps the groups apart with plain dividers once collapsed', () => {
    renderSidebar();
    act(() => useUiStore.setState({ sidebarMode: 'collapsed' }));

    expect(screen.getByRole('group', { name: 'Build' })).toBeTruthy();
    expect(screen.queryByText('Build')).toBeNull();
  });

  it('draws each entry as a centred square on the icon rail, and as a full row otherwise', () => {
    renderSidebar('/usage');
    const linkTo = (href: string): HTMLElement => {
      const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === href);
      if (!link) throw new Error(`no link to ${href}`);
      return link;
    };

    expect(linkTo('/usage')).not.toHaveClass('h-8.5', 'w-8.5');
    expect(linkTo('/skills')).not.toHaveClass('h-8.5', 'w-8.5');

    act(() => useUiStore.setState({ sidebarMode: 'collapsed' }));

    // The current entry and a plain one both get the square, so the active pill and the hover
    // background are squares. On the rail the link is a tooltip trigger, and its class list has
    // to stay real classes rather than the source of a className function.
    for (const href of ['/usage', '/skills', '/settings']) {
      expect(linkTo(href)).toHaveClass('mx-auto', 'h-8.5', 'w-8.5', 'rounded-lg');
      expect(linkTo(href).className).not.toContain('=>');
    }
  });

  it('empties out when hidden, so the page gets the full width', () => {
    renderSidebar('/usage');
    act(() => useUiStore.setState({ sidebarMode: 'hidden' }));

    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('Sidebar badges', () => {
  it('shows the unread pipeline count on Pipelines', async () => {
    renderSidebar('/', { 'appNotifications.unreadCount': async () => 3 });

    const pipelines = await screen.findByRole('link', { name: /Pipelines/ });
    await waitFor(() => expect(within(pipelines).getByText('3')).toBeTruthy());
  });

  it('caps a large unread count rather than stretching the sidebar', async () => {
    renderSidebar('/', { 'appNotifications.unreadCount': async () => 143 });

    const pipelines = await screen.findByRole('link', { name: /Pipelines/ });
    await waitFor(() => expect(within(pipelines).getByText('99+')).toBeTruthy());
  });

  it('refreshes the count when the main process reports a change', async () => {
    let unread = 1;
    const { bridge } = renderSidebar('/', {
      'appNotifications.unreadCount': async () => unread,
    });
    const pipelines = await screen.findByRole('link', { name: /Pipelines/ });
    await waitFor(() => expect(within(pipelines).getByText('1')).toBeTruthy());

    unread = 4;
    act(() => bridge.$emit('appNotifications.onChanged'));

    await waitFor(() => expect(within(pipelines).getByText('4')).toBeTruthy());
  });

  it('carries no badge when nothing is unread', async () => {
    renderSidebar('/', { 'appNotifications.unreadCount': async () => 0 });

    const pipelines = await screen.findByRole('link', { name: /Pipelines/ });
    await waitFor(() => expect(pipelines.textContent).toBe('Pipelines'));
  });

  it('survives a bridge that cannot answer the unread count', async () => {
    renderSidebar('/', {
      'appNotifications.unreadCount': () => Promise.reject(new Error('no database')),
    });

    const pipelines = await screen.findByRole('link', { name: /Pipelines/ });
    expect(pipelines.textContent).toBe('Pipelines');
  });
});

describe('Sidebar version and updates', () => {
  it('shows the running version', async () => {
    renderSidebar('/', { 'app.getVersion': async () => '2.4.1' });

    expect(await screen.findByRole('button', { name: /Runova v2\.4\.1/ })).toBeTruthy();
  });

  it('shows the Runova icon, the maker and the version chip on the about card', async () => {
    renderSidebar('/', { 'app.getVersion': async () => '2.4.1' });

    const card = await screen.findByRole('button', { name: /Runova v2\.4\.1/ });
    expect(card).toHaveAccessibleName('Runova v2.4.1, by SmartClouds, about');
    expect(card).toHaveAttribute('aria-haspopup', 'dialog');
    expect(within(card).getByText('by SmartClouds')).toBeInTheDocument();
    expect(within(card).getByText('v2.4.1')).toBeInTheDocument();
    // The name beside it already says Runova, so the icon itself stays silent.
    const icon = card.querySelector('img');
    expect(icon).toHaveAttribute('alt', '');
    expect(icon?.getAttribute('src')).toContain('app-icon');
    expect(icon).toHaveAttribute('sizes', '28px');
    expect(icon?.getAttribute('srcset')).toMatch(/ 56w, .+ 144w$/);
    expect(card.querySelector('.brand-tile')).toBeNull();
  });

  it('opens About when the card is clicked, without starting an update check', async () => {
    const { user, bridge } = renderSidebar('/', { 'app.getVersion': async () => '2.4.1' });

    await user.click(await screen.findByRole('button', { name: /Runova v2\.4\.1/ }));

    expect(await screen.findByRole('dialog', { name: 'About Runova' })).toBeInTheDocument();
    expect(() => bridge.$fn('app.checkForUpdates')).toThrow(/not been touched/);
  });

  it('checks for updates from the About dialog the card opens', async () => {
    const { user, bridge } = renderSidebar('/', {
      'app.getVersion': async () => '2.4.1',
      'app.checkForUpdates': async () => ({ state: 'not-available' }),
    });

    await user.click(await screen.findByRole('button', { name: /Runova v2\.4\.1/ }));
    const about = await screen.findByRole('dialog', { name: 'About Runova' });
    await user.click(within(about).getByRole('button', { name: 'Check for updates' }));

    expect(bridge.$fn('app.checkForUpdates')).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("You're on the latest version."),
    );
  });

  it('shows a check in progress in place of the version', async () => {
    renderSidebar('/', { 'app.getVersion': async () => '2.4.1' });
    const card = await screen.findByRole('button', { name: /Runova v2\.4\.1/ });

    act(() => useUpdateStore.setState({ status: { state: 'checking' } }));

    expect(within(card).getByText('Checking…')).toBeInTheDocument();
    expect(within(card).queryByText('v2.4.1')).toBeNull();
    expect(card).toHaveAccessibleName(/Runova v2\.4\.1, by SmartClouds, checking for updates/);
    expect(card).toHaveAttribute('aria-busy', 'true');
  });

  it('flags a waiting update on the card', async () => {
    renderSidebar('/', { 'app.getVersion': async () => '2.4.1' });
    const card = await screen.findByRole('button', { name: /Runova v2\.4\.1/ });
    expect(card).not.toHaveAccessibleName(/update available/);

    act(() =>
      useUpdateStore.setState({
        status: {
          state: 'downloaded',
          info: { version: '3.0.0', releaseDate: null, releaseNotes: null, sizeBytes: null },
        },
      }),
    );

    expect(card).toHaveAccessibleName('Runova v2.4.1, by SmartClouds, update available, about');
  });

  it('shrinks to the Runova icon on the icon rail, still opening About', async () => {
    const { user } = renderSidebar('/', { 'app.getVersion': async () => '2.4.1' });
    act(() => useUiStore.setState({ sidebarMode: 'collapsed' }));

    const icon = await screen.findByRole('button', { name: /Runova v2\.4\.1, by SmartClouds/ });
    // The words go with the labels; only the icon is left on the rail.
    expect(screen.queryByText('by SmartClouds')).toBeNull();
    expect(screen.queryByText('v2.4.1')).toBeNull();
    expect(icon.querySelector('img')?.getAttribute('src')).toContain('app-icon');

    await user.hover(icon);
    expect((await screen.findAllByText('About Runova')).length).toBeGreaterThan(0);

    await user.click(icon);
    expect(await screen.findByRole('dialog', { name: 'About Runova' })).toBeInTheDocument();
  });

  it('keeps the update dot on the rail when an update is waiting', async () => {
    renderSidebar('/', { 'app.getVersion': async () => '2.4.1' });
    act(() => useUiStore.setState({ sidebarMode: 'collapsed' }));
    const icon = await screen.findByRole('button', { name: /Runova v2\.4\.1/ });
    const quiet = icon.childElementCount;

    act(() =>
      useUpdateStore.setState({
        status: {
          state: 'available',
          info: { version: '3.0.0', releaseDate: null, releaseNotes: null, sizeBytes: null },
          partialBytes: 0,
        },
      }),
    );

    expect(icon.childElementCount).toBe(quiet + 1);
    expect(icon).toHaveAccessibleName(/update available, about$/);
  });
});

describe('Sidebar workspace attention', () => {
  it('flags Workspace when an agent is waiting for an answer', async () => {
    renderSidebar('/');
    const workspace = screen.getByRole('link', { name: /Workspace/ });
    const before = workspace.childElementCount;

    act(() => useAgentStatusStore.setState({ statuses: { 'tab-1': 'needs-input' } }));

    await waitFor(() => expect(workspace.childElementCount).toBeGreaterThan(before));
  });
});
