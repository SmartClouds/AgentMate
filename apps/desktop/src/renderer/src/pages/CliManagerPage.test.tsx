import { CLI_REGISTRY, type InstalledCli } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The CLI Manager is a catalogue with side effects: it decides which of the registry's CLIs are
 * on this machine, and every button either opens a terminal with a command in it or writes a
 * setting. Both of those are asserted through the bridge rather than the component.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { default: CliManagerPage } = await import('./CliManagerPage');

function detected(overrides: Partial<InstalledCli> & { id: string }): InstalledCli {
  return {
    installed: true,
    version: '1.0.0',
    executablePath: '/usr/local/bin/x',
    lastCheckedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

const claudeInstalled = detected({ id: 'claude-code', version: '1.2.3' });

/**
 * The card one CLI's name heads. The title and the card's buttons sit in different boxes, so the
 * card is the first ancestor that holds an action button of its own, which is what lets a test
 * click "Install" on the intended CLI rather than on whichever one comes first in the grid.
 */
function cliCard(name: string): HTMLElement {
  const title = screen.getByRole('heading', { name });
  let element: HTMLElement | null = title.parentElement;
  while (element) {
    const own = within(element)
      .queryAllByRole('button')
      .filter((button) => !button.contains(title));
    if (own.length > 0) return element;
    element = element.parentElement;
  }
  throw new Error(`No card found around "${name}"`);
}

function renderPage(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<CliManagerPage />, { route: '/cli-manager', bridge });
}

describe('CliManagerPage detection', () => {
  it('renders with nothing detected and offers the full catalogue instead', async () => {
    renderPage();

    expect(await screen.findByText('No AI CLIs installed yet')).toBeTruthy();
    expect(screen.getByText(/Click "Show all CLIs" above/)).toBeTruthy();
    // Every registry entry counts as missing when the scan found none of them.
    expect(
      screen.getByRole('button', { name: `Show all CLIs (${CLI_REGISTRY.length} not installed)` }),
    ).toBeTruthy();
  });

  it('opens the whole catalogue from the empty state', async () => {
    const { user } = renderPage();

    await user.click(await screen.findByRole('button', { name: /Browse the catalogue/ }));

    expect(screen.getByRole('heading', { name: 'Gemini CLI' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide not installed' })).toBeTruthy();
  });

  it('falls back to the same empty state when detection itself fails', async () => {
    renderPage({ 'cli.detectAll': () => Promise.reject(new Error('spawn ENOENT')) });

    expect(await screen.findByText(/No AI CLIs installed yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Check all for updates/ })).toBeTruthy();
  });

  it('lists an installed CLI with its version and hides the ones that are missing', async () => {
    renderPage({ 'cli.detectAll': [claudeInstalled] });

    await screen.findByRole('heading', { name: 'Claude Code CLI' });
    const card = cliCard('Claude Code CLI');
    expect(within(card).getByText('1.2.3')).toBeTruthy();
    expect(within(card).getByText("Anthropic's agentic coding CLI.")).toBeTruthy();

    expect(screen.queryByRole('heading', { name: 'Gemini CLI' })).toBeNull();
    expect(screen.queryByText(/No AI CLIs installed yet/)).toBeNull();
    expect(
      screen.getByRole('button', {
        name: `Show all CLIs (${CLI_REGISTRY.length - 1} not installed)`,
      }),
    ).toBeTruthy();
  });

  it('reveals the missing CLIs on demand and hides them again', async () => {
    const { user } = renderPage({ 'cli.detectAll': [claudeInstalled] });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });

    await user.click(screen.getByRole('button', { name: /^Show all CLIs/ }));

    const gemini = cliCard('Gemini CLI');
    expect(within(gemini).getByText('Not installed')).toBeTruthy();
    expect(within(gemini).getByRole('button', { name: /Install/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Hide not installed' }));
    expect(screen.queryByRole('heading', { name: 'Gemini CLI' })).toBeNull();
  });

  it('narrows the cards to the CLIs whose name or description matches the filter', async () => {
    const { user } = renderPage({ 'cli.detectAll': [claudeInstalled] });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });
    await user.click(screen.getByRole('button', { name: /^Show all CLIs/ }));

    const filter = screen.getByRole('searchbox', { name: 'Filter CLIs' });
    await user.type(filter, 'gemini');

    expect(screen.getByRole('heading', { name: 'Gemini CLI' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Claude Code CLI' })).toBeNull();

    // Escape clears the filter and brings every card back.
    await user.keyboard('{Escape}');
    expect(filter).toHaveValue('');
    expect(screen.getByRole('heading', { name: 'Claude Code CLI' })).toBeTruthy();
  });

  it('says so when the filter matches nothing, and clears it on request', async () => {
    const { user } = renderPage({ 'cli.detectAll': [claudeInstalled] });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });

    await user.type(screen.getByRole('searchbox', { name: 'Filter CLIs' }), 'zzz-nothing');

    expect(screen.getByText('Nothing matches “zzz-nothing”.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(screen.getByRole('heading', { name: 'Claude Code CLI' })).toBeTruthy();
  });

  it('re-scans without the main process cache when asked to refresh', async () => {
    const { user, bridge } = renderPage({ 'cli.detectAll': [claudeInstalled] });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });

    await user.click(screen.getByRole('button', { name: /Refresh/ }));

    expect(toast.info).toHaveBeenCalledWith('Re-scanning installed CLIs…');
    await waitFor(() => expect(bridge.$fn('cli.detectAll')).toHaveBeenCalledWith(true));
  });
});

describe('CliManagerPage install', () => {
  it('puts the install command in a terminal for the user to confirm', async () => {
    const { user, bridge } = renderPage({
      'cli.detectAll': [claudeInstalled],
      'cli.getInstallCommand': async () => 'npm install -g @google/gemini-cli',
      'cli.checkCommandPrerequisite': async () => null,
    });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });
    await user.click(screen.getByRole('button', { name: /^Show all CLIs/ }));

    await user.click(within(cliCard('Gemini CLI')).getByRole('button', { name: /Install/ }));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('Press Enter in the terminal to install Gemini CLI.'),
    );
    expect(bridge.$fn('cli.getInstallCommand')).toHaveBeenCalledWith('gemini-cli');
    expect(bridge.$fn('cli.checkCommandPrerequisite')).toHaveBeenCalledWith(
      'npm install -g @google/gemini-cli',
    );
    // Nothing is run for the user: the command is typed into a session they still have to accept.
    const session = useTerminalStore
      .getState()
      .sessions.find((one) => one.title === 'Install Gemini CLI');
    expect(session?.initialInput).toBe('npm install -g @google/gemini-cli');
  });

  it('asks for Node.js first rather than opening a terminal where npm would fail', async () => {
    const { user } = renderPage({
      'cli.detectAll': [claudeInstalled],
      'cli.getInstallCommand': async () => 'npm install -g @google/gemini-cli',
      'cli.checkCommandPrerequisite': { name: 'Node.js', url: 'https://nodejs.org/en/download' },
    });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });
    await user.click(screen.getByRole('button', { name: /^Show all CLIs/ }));

    await user.click(within(cliCard('Gemini CLI')).getByRole('button', { name: /Install/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Gemini CLI needs Node.js, which isn't installed.",
        expect.objectContaining({ action: expect.objectContaining({ label: 'Get Node.js' }) }),
      ),
    );
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    expect(toast.info).not.toHaveBeenCalledWith(
      'Press Enter in the terminal to install Gemini CLI.',
    );
  });

  it('says so instead of opening an empty terminal when this OS has no install command', async () => {
    // The blank answer is what an unsupported platform returns.
    const { user } = renderPage({ 'cli.detectAll': [claudeInstalled] });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });
    await user.click(screen.getByRole('button', { name: /^Show all CLIs/ }));

    await user.click(within(cliCard('Gemini CLI')).getByRole('button', { name: /Install/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'No install command available for Gemini CLI on this OS.',
      ),
    );
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });
});

describe('CliManagerPage broken install', () => {
  const claudeBroken = detected({
    id: 'claude-code',
    version: null,
    executablePath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
    runError: 'The system cannot execute the specified program.',
  });

  it("says a CLI that is found but won't start can't run, and why", async () => {
    renderPage({ 'cli.detectAll': [claudeBroken] });

    await screen.findByRole('heading', { name: 'Claude Code CLI' });
    const card = cliCard('Claude Code CLI');
    expect(within(card).getByText("Won't run")).toBeTruthy();
    expect(within(card).getByText(/fails to start/)).toBeTruthy();
    expect(within(card).getByText(claudeBroken.executablePath!)).toBeTruthy();
    expect(within(card).getByText('The system cannot execute the specified program.')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Set as default' })).toBeNull();
  });

  it('puts the reinstall command in a terminal for the user to confirm', async () => {
    const { user, bridge } = renderPage({
      'cli.detectAll': [claudeBroken],
      'cli.getReinstallCommand': async () => 'npm install -g @anthropic-ai/claude-code@latest',
      'cli.checkCommandPrerequisite': async () => null,
    });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });

    await user.click(within(cliCard('Claude Code CLI')).getByRole('button', { name: /Reinstall/ }));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        'Press Enter in the terminal to reinstall Claude Code CLI.',
      ),
    );
    expect(bridge.$fn('cli.getReinstallCommand')).toHaveBeenCalledWith('claude-code');
    const session = useTerminalStore
      .getState()
      .sessions.find((one) => one.title === 'Reinstall Claude Code CLI');
    expect(session?.initialInput).toBe('npm install -g @anthropic-ai/claude-code@latest');
  });

  it('leaves a CLI that will not start out of the update check', async () => {
    const { user, bridge } = renderPage({ 'cli.detectAll': [claudeBroken] });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });

    await user.click(screen.getByRole('button', { name: /Check all for updates/ }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('No installed CLIs to check.'));
    expect(() => bridge.$fn('cli.checkForUpdate')).toThrow();
  });
});

describe('CliManagerPage settings', () => {
  it('saves the arguments typed for a CLI and previews the command they build', async () => {
    const { user, bridge } = renderPage({ 'cli.detectAll': [claudeInstalled] });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });
    const card = cliCard('Claude Code CLI');

    const args = within(card).getByRole('textbox');
    await user.type(args, '--model sonnet');
    // Saved on blur, not per keystroke, so a half-typed flag never reaches a run.
    expect(() => bridge.$fn('settings.update')).toThrow();

    await user.tab();

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        cliArgs: { 'claude-code': '--model sonnet' },
      }),
    );
    expect(within(card).getByText('claude --model sonnet')).toBeTruthy();
  });

  it('remembers which CLI is the default one', async () => {
    const { user, bridge } = renderPage({ 'cli.detectAll': [claudeInstalled] });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });
    const card = cliCard('Claude Code CLI');

    await user.click(within(card).getByRole('button', { name: 'Set as default' }));

    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ defaultCliId: 'claude-code' });
    expect(within(card).getByRole('button', { name: 'Default CLI' })).toBeTruthy();

    // Clicking again unsets it rather than leaving the user with no way back.
    await user.click(within(card).getByRole('button', { name: 'Default CLI' }));
    expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ defaultCliId: null });
  });
});

describe('CliManagerPage updates', () => {
  it('has nothing to check when no CLI is installed', async () => {
    const { user } = renderPage();
    await screen.findByText(/No AI CLIs installed yet/);

    await user.click(screen.getByRole('button', { name: /Check all for updates/ }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('No installed CLIs to check.'));
  });

  it('reports that everything is current when no update is out', async () => {
    const { user } = renderPage({
      'cli.detectAll': [claudeInstalled],
      'cli.checkForUpdate': async () => ({
        cliId: 'claude-code',
        supported: true,
        currentVersion: '1.2.3',
        latestVersion: '1.2.3',
        updateAvailable: false,
      }),
    });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });

    await user.click(screen.getByRole('button', { name: /Check all for updates/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('All CLIs are up to date.'));
  });

  it('offers the update command for confirmation when a newer version exists', async () => {
    const { user, bridge } = renderPage({
      'cli.detectAll': [claudeInstalled],
      'cli.checkForUpdate': async () => ({
        cliId: 'claude-code',
        supported: true,
        currentVersion: '1.2.3',
        latestVersion: '2.0.0',
        updateAvailable: true,
      }),
      'cli.getUpdateCommand': async () => 'claude update',
    });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });

    await user.click(screen.getByRole('button', { name: /Check all for updates/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Update Claude Code CLI?')).toBeTruthy();
    expect(within(dialog).getByText(/1\.2\.3/)).toBeTruthy();
    expect(within(dialog).getByText(/2\.0\.0/)).toBeTruthy();
    expect(within(dialog).getByText('claude update')).toBeTruthy();
    expect(bridge.$fn('cli.checkForUpdate')).toHaveBeenCalledWith('claude-code', '1.2.3');

    await user.click(within(dialog).getByRole('button', { name: 'Update' }));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        'Press Enter in the terminal to update Claude Code CLI.',
      ),
    );
    const session = useTerminalStore
      .getState()
      .sessions.find((one) => one.title === 'Update Claude Code CLI');
    expect(session?.initialInput).toBe('claude update');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes the update dialog without a terminal when the update needs something missing', async () => {
    const { user } = renderPage({
      'cli.detectAll': [detected({ id: 'gemini-cli', version: '0.1.0' })],
      'cli.checkForUpdate': async () => ({
        cliId: 'gemini-cli',
        supported: true,
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        updateAvailable: true,
      }),
      'cli.getUpdateCommand': async () => 'npm install -g @google/gemini-cli@latest',
      'cli.checkCommandPrerequisite': { name: 'Node.js', url: 'https://nodejs.org/en/download' },
    });
    await screen.findByRole('heading', { name: 'Gemini CLI' });

    await user.click(screen.getByRole('button', { name: /Check all for updates/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Update' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Gemini CLI needs Node.js, which isn't installed.",
        expect.anything(),
      ),
    );
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('counts the CLIs it could not check rather than claiming they are current', async () => {
    const { user } = renderPage({
      'cli.detectAll': [claudeInstalled, detected({ id: 'aider', version: '0.9.0' })],
      'cli.checkForUpdate': async (cliId: unknown) => ({
        cliId: String(cliId),
        // Only one of the two has somewhere to look the latest version up.
        supported: cliId === 'claude-code',
        currentVersion: null,
        latestVersion: cliId === 'claude-code' ? '1.2.3' : null,
        updateAvailable: false,
      }),
    });
    await screen.findByRole('heading', { name: 'Claude Code CLI' });

    await user.click(screen.getByRole('button', { name: /Check all for updates/ }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'All checkable CLIs are up to date (1 could not be checked).',
      ),
    );
  });
});
