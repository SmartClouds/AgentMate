// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useCliStore } from '@/stores/cliStore';
import { CliLaunchDefaultsSettings } from './CliLaunchDefaultsSettings';
import { CliOrderSettings } from './CliOrderSettings';

/**
 * The Launch defaults section with the real CLI store. It shows only what terminals start with:
 * the background task arguments from AI CLI Manager never show up here, since tabs don't use them.
 */

const settingsUpdate = vi.fn((_patch: unknown) => Promise.resolve({}));

function renderSection(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CliLaunchDefaultsSettings />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function claudeRow(): Promise<HTMLElement> {
  const name = await screen.findByText(/^Claude Code/);
  const button = name.closest('button');
  if (!button) throw new Error('Claude Code row has no toggle');
  return button;
}

async function openClaudeRow(): Promise<HTMLElement> {
  const toggle = await claudeRow();
  fireEvent.click(toggle);
  const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  if (!panel) throw new Error('Claude Code panel did not open');
  return panel;
}

beforeEach(() => {
  settingsUpdate.mockClear();
  Object.assign(window, {
    agentmat: {
      platform: 'win32',
      settings: { update: settingsUpdate },
      cli: {
        detectAll: () => Promise.resolve([{ id: 'claude-code', installed: true }]),
      },
      agents: { statusHookSettings: () => Promise.resolve(null) },
    },
  });
  useCliStore.setState({
    cliArgs: {},
    cliLaunchDefaults: {},
    cliOrder: [],
    lastRunInfoByCli: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('CliLaunchDefaultsSettings', () => {
  it('says Not set when nothing is set here', async () => {
    renderSection();
    const row = await claudeRow();
    expect(within(row).getByText('Not set')).toBeTruthy();

    const panel = await openClaudeRow();
    expect(within(panel).getByText('(no flags added)')).toBeTruthy();
  });

  it('does not treat the last model a CLI ran on as a setting', async () => {
    useCliStore.setState({
      lastRunInfoByCli: { 'claude-code': { model: 'claude-haiku-4-5' } },
    });
    renderSection();
    const row = await claudeRow();
    expect(within(row).getByText('Not set')).toBeTruthy();
    expect(within(row).queryByText(/Haiku/)).toBeNull();
  });

  it('ignores a model saved in the Arguments box, since tabs never send it', async () => {
    useCliStore.setState({ cliArgs: { 'claude-code': '--model haiku --verbose' } });
    renderSection();
    const row = await claudeRow();
    expect(within(row).getByText('Not set')).toBeTruthy();
    expect(within(row).queryByText(/Haiku/)).toBeNull();

    const panel = await openClaudeRow();
    expect(panel.querySelector('code.font-mono')?.textContent).toBe('claude (no flags added)');
  });

  it('previews the command a terminal types', async () => {
    useCliStore.setState({
      cliArgs: { 'claude-code': '--verbose' },
      cliLaunchDefaults: { 'claude-code': { model: 'opus', mode: 'auto' } },
    });
    renderSection();
    const panel = await openClaudeRow();
    const preview = panel.querySelector('code.font-mono');
    expect(preview?.textContent).toBe('claude --model opus --permission-mode auto');
  });

  describe('Grok and Cursor', () => {
    async function openRow(name: RegExp): Promise<HTMLElement> {
      window.agentmat.cli.detectAll = () =>
        Promise.resolve(
          ['claude-code', 'grok-cli', 'cursor-cli'].map((id) => ({
            id,
            installed: true as const,
            version: '1.0.0',
            executablePath: `/usr/local/bin/${id}`,
            lastCheckedAt: '2026-01-01T10:00:00.000Z',
          })),
        );
      renderSection();
      const toggle = (await screen.findByText(name)).closest('button');
      if (!toggle) throw new Error(`${name} row has no toggle`);
      fireEvent.click(toggle);
      const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
      if (!panel) throw new Error(`${name} panel did not open`);
      return panel;
    }

    async function optionLabels(panel: HTMLElement): Promise<string[]> {
      fireEvent.click(within(panel).getByRole('combobox'));
      const options = await screen.findAllByRole('option');
      return options.map((option) => option.textContent ?? '');
    }

    it('lists the Grok models and offers its three effort levels', async () => {
      const panel = await openRow(/^Grok CLI/);
      const labels = await optionLabels(panel);
      expect(labels).toEqual([
        'Grok 4.7',
        'Grok 4.6',
        'Grok 4.5',
        'Grok 4.3',
        'Grok 4.20',
        'Grok Build 0.1',
      ]);
      fireEvent.click(screen.getByRole('option', { name: 'Grok 4.7' }));
      fireEvent.click(await within(panel).findByRole('radio', { name: 'High' }));
      expect(useCliStore.getState().cliLaunchDefaults['grok-cli']).toEqual({
        model: 'grok-4.7',
        effort: 'high',
      });
      expect(panel.querySelector('code.font-mono')?.textContent).toBe(
        'grok --model grok-4.7 --reasoning-effort high',
      );
      // Grok stops at High.
      expect(within(panel).queryByRole('radio', { name: 'Max' })).toBeNull();
    });

    it('lists the Cursor models and has no effort setting', async () => {
      const panel = await openRow(/^Cursor CLI/);
      expect(await optionLabels(panel)).toEqual([
        'Auto',
        'Composer 2.5',
        'Fable 5.1 (high)',
        'Opus 5.5 (high)',
        'Sonnet 5.5 (high)',
        'Haiku 5.5 (high)',
        'GPT-5.6 Sol (high)',
        'Gemini 4 Argon (high)',
        'Gemini 3.8 Flash (high)',
        'Grok 4.7 (high)',
      ]);
      fireEvent.click(screen.getByRole('option', { name: 'Sonnet 5.5 (high)' }));
      expect(within(panel).queryByRole('radiogroup', { name: 'Effort' })).toBeNull();
      expect(useCliStore.getState().cliLaunchDefaults['cursor-cli']).toEqual({
        model: 'claude-sonnet-5-5-high',
      });
      expect(panel.querySelector('code.font-mono')?.textContent).toBe(
        'cursor-agent --model claude-sonnet-5-5-high',
      );
    });
  });

  it('never holds the full-page loading overlay while the CLI sweep runs', async () => {
    // A sweep that takes tens of seconds, as it does on a machine with few CLIs installed.
    // Both sections of the Agents tab share the query, and the last one to mount sets its meta.
    window.agentmat.cli.detectAll = () => new Promise(() => undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <CliLaunchDefaultsSettings />
          <CliOrderSettings />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(client.isFetching()).toBeGreaterThan(0));
    // The same rule useStartupLoading applies to decide whether the page is blanked.
    const blanking = client.isFetching({
      predicate: (query) => !query.meta?.silentLoading && query.state.data === undefined,
    });
    expect(blanking).toBe(0);
  });
});
