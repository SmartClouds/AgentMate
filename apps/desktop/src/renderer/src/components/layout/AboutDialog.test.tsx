import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAboutStore } from '@/stores/aboutStore';
import { useUpdateStore } from '@/stores/updateStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * About Runova is where the version, the update check, the source link and the SmartClouds
 * credit live now that the about card and the version chip open it. What matters: it says what
 * the app is, that it's open source and who makes it, which version is running, the update check
 * behaves the same as it did from the card, and links open in the browser rather than inside the
 * app window.
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

const { AboutDialog, SMARTCLOUDS_URL, SOURCE_URL, WEBSITE_URL } = await import('./AboutDialog');

const AVAILABLE = {
  state: 'available',
  info: { version: '3.0.0', releaseDate: null, releaseNotes: null, sizeBytes: null },
  partialBytes: 0,
} as const;

function renderAbout(bridge: Record<string, unknown> = {}) {
  useAboutStore.setState({ open: true });
  return renderWithProviders(<AboutDialog />, {
    bridge: { 'app.getVersion': async () => '2.4.1', ...bridge },
  });
}

const dialog = (): Promise<HTMLElement> => screen.findByRole('dialog', { name: 'About Runova' });

describe('AboutDialog contents', () => {
  it('shows the app icon, the version, what the app is and who makes it', async () => {
    renderAbout();
    const about = await dialog();

    const icon = within(about).getByRole('img', { name: 'Runova' });
    expect(icon.getAttribute('src')).toContain('app-icon');
    expect(icon).toHaveAttribute('sizes', '72px');
    expect(await within(about).findByText('v2.4.1')).toBeInTheDocument();
    // The description is about the app itself, not the company.
    expect(about).toHaveAccessibleDescription(
      /^Runova is an Agentic Development Environment \(ADE\) for AI coding agents\./,
    );
    expect(about).toHaveAccessibleDescription(
      /Claude Code, Codex, Cursor, Gemini, Grok, OpenCode or a plain shell/,
    );
    expect(about).toHaveAccessibleDescription(/from prompt to review to commit/);
    expect(about).not.toHaveAccessibleDescription(/SmartClouds/);
    expect(
      within(about).getByText('Runova is built and maintained by SmartClouds.'),
    ).toBeInTheDocument();
    expect(within(about).getByText(`© ${new Date().getFullYear()}`)).toBeInTheDocument();
  });

  it('credits SmartClouds at the foot, with their logo and name, linking to their site', async () => {
    const { bridge } = renderAbout();
    const about = await dialog();

    const credit = within(about).getByRole('link', { name: /^A product of SmartClouds/ });
    const logo = within(credit).getByRole('img', { name: 'SmartClouds' });
    expect(logo.getAttribute('src')).toContain('smartclouds-logo');
    expect(logo.getAttribute('srcset')).toMatch(/ 1x, .+ 2x$/);
    // The logo sits on the panel itself, with no dark box around it.
    expect(logo.parentElement).toBe(credit);
    expect(within(credit).getByText('A product of')).toBeInTheDocument();
    expect(within(credit).getByText('SmartClouds')).toBeInTheDocument();
    // The credit replaces the old "by SmartClouds" line and the name in the copyright.
    expect(within(about).queryByText('by SmartClouds')).toBeNull();
    expect(within(about).queryByText(/© \d{4} SmartClouds/)).toBeNull();

    const click = createEvent.click(credit);
    fireEvent(credit, click);
    expect(click.defaultPrevented).toBe(true);
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(SMARTCLOUDS_URL);
  });

  it('says the app is free and open source under the MIT license', async () => {
    renderAbout();

    expect(
      within(await dialog()).getByText("It's free and open source under the MIT license."),
    ).toBeInTheDocument();
  });

  it('says "dev" in a development build', async () => {
    renderAbout({ 'app.getVersion': async () => 'dev' });

    expect(await within(await dialog()).findByText('dev')).toBeInTheDocument();
  });

  it('renders nothing until it is opened', () => {
    renderWithProviders(<AboutDialog />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('AboutDialog update check', () => {
  it('runs the check and shows it working until the answer comes back', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const { user, bridge } = renderAbout({
      'app.checkForUpdates': () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });

    await user.click(within(await dialog()).getByRole('button', { name: 'Check for updates' }));

    const busy = screen.getByRole('button', { name: 'Checking…' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    // A second press while the first is still out does not start another check.
    await user.click(busy);
    expect(bridge.$fn('app.checkForUpdates')).toHaveBeenCalledTimes(1);

    await act(async () => answer({ state: 'not-available' }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("You're on the latest version."),
    );
    expect(screen.getByRole('button', { name: 'Check for updates' })).not.toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('shows a check started somewhere else as in progress too', async () => {
    renderAbout();
    const about = await dialog();

    act(() => useUpdateStore.setState({ status: { state: 'checking' } }));

    expect(within(about).getByRole('button', { name: 'Checking…' })).toBeInTheDocument();
  });

  it('reports a failed check instead of looking like nothing happened', async () => {
    const { user } = renderAbout({
      'app.checkForUpdates': async () => ({ state: 'error', message: 'Update server down.' }),
    });

    await user.click(within(await dialog()).getByRole('button', { name: 'Check for updates' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Update server down.'));
  });

  it('hands a found update to the update dialog and steps aside for it', async () => {
    const { user } = renderAbout({ 'app.checkForUpdates': async () => AVAILABLE });

    await user.click(within(await dialog()).getByRole('button', { name: 'Check for updates' }));

    await waitFor(() => expect(useUpdateStore.getState().dialogOpen).toBe(true));
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAboutStore.getState().open).toBe(false);
  });

  it('offers the waiting update instead of another check', async () => {
    useUpdateStore.setState({
      status: {
        state: 'downloaded',
        info: { version: '3.0.0', releaseDate: null, releaseNotes: null, sizeBytes: null },
      },
    });
    const { user, bridge } = renderAbout();
    const about = await dialog();

    expect(within(about).queryByRole('button', { name: 'Check for updates' })).toBeNull();
    await user.click(within(about).getByRole('button', { name: 'View update' }));

    expect(useUpdateStore.getState().dialogOpen).toBe(true);
    expect(() => bridge.$fn('app.checkForUpdates')).toThrow(/not been touched/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('AboutDialog links', () => {
  it('opens the source on GitHub in the browser, not in the app window', async () => {
    const { bridge } = renderAbout();
    const link = within(await dialog()).getByRole('link', { name: /^Source on GitHub/ });
    expect(link).toHaveAttribute('href', 'https://github.com/SmartClouds/Runova');

    const click = createEvent.click(link);
    fireEvent(link, click);

    expect(click.defaultPrevented).toBe(true);
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(SOURCE_URL);
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledTimes(1);
    expect(SOURCE_URL).toBe('https://github.com/SmartClouds/Runova');
    expect(SMARTCLOUDS_URL).toBe('https://smartclouds.co');
  });

  it("opens Runova's website in the browser", async () => {
    const { bridge } = renderAbout();
    const link = within(await dialog()).getByRole('link', { name: /^Website/ });
    expect(link).toHaveAttribute('href', 'https://runovahq.com');
    expect(link).toHaveAccessibleName('Website, opens in your browser');

    const click = createEvent.click(link);
    fireEvent(link, click);

    expect(click.defaultPrevented).toBe(true);
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(WEBSITE_URL);
  });

  it('tells where the name comes from', async () => {
    renderAbout();
    expect(await dialog()).toHaveTextContent(/a runway, where launches happen, and a nova/);
  });

  it('says the links leave the app', async () => {
    renderAbout();
    const about = await dialog();

    expect(within(about).getByRole('link', { name: /^Source on GitHub/ })).toHaveAccessibleName(
      'Source on GitHub, opens in your browser',
    );
    expect(within(about).getByRole('link', { name: /^A product of/ })).toHaveAccessibleName(
      'A product of SmartClouds, opens in your browser',
    );
  });
});

describe('AboutDialog dismissal and focus', () => {
  it('closes on Escape', async () => {
    const { user } = renderAbout();
    await dialog();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAboutStore.getState().open).toBe(false);
  });

  it('closes from its close button', async () => {
    const { user } = renderAbout();

    await user.click(within(await dialog()).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps keyboard focus inside while open', async () => {
    const { user } = renderAbout();
    const about = await dialog();

    expect(about).toContainElement(document.activeElement as HTMLElement);
    // The check, the source link, the credit and Close, then round again.
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(about).toContainElement(document.activeElement as HTMLElement);
    }
  });
});
