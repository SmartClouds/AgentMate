// @vitest-environment jsdom
import type { Project } from '@agentmat/core';
import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCliStore } from '@/stores/cliStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { LauncherMenu } from './LauncherMenu';

const project = { id: 'p1', name: 'App', folderPath: 'C:\\code\\app', cliId: null } as Project;

const installed = (id: string) => ({
  id,
  installed: true,
  version: '1.0.0',
  executablePath: `/usr/local/bin/${id}`,
  lastCheckedAt: '2026-01-01T10:00:00.000Z',
});

// The order the menu lists them in, so the digit keys are predictable: 1 Claude, 2 Gemini.
// Copilot is the one agent here that has no model picker.
const ORDER = ['claude-code', 'gemini-cli', 'codex-cli', 'grok-cli', 'cursor-cli', 'copilot-cli'];

beforeEach(() => {
  useWorkspaceStore.setState({ workspaces: {} });
  useCliStore.setState({ cliOrder: ORDER, cliLaunchDefaults: {} });
});

function terminalTabs() {
  const tabs = Object.values(useWorkspaceStore.getState().workspaces.p1?.tabs ?? {});
  return tabs.filter((tab) => tab.kind === 'terminal');
}

function lastLaunch(): { input: string | undefined; label: string | undefined } {
  const tab = terminalTabs().at(-1);
  return tab?.kind === 'terminal'
    ? { input: tab.launchInput, label: tab.runLabel }
    : { input: undefined, label: undefined };
}

async function openMenu() {
  useWorkspaceStore.getState().openProject('p1');
  const groupId = useWorkspaceStore.getState().workspaces.p1?.focusedGroupId ?? '';
  const view = renderWithProviders(
    <LauncherMenu project={project} groupId={groupId}>
      <button type="button">New tab</button>
    </LauncherMenu>,
    { bridge: { 'cli.detectAll': ORDER.map(installed), platform: 'win32' } },
  );
  await view.user.click(screen.getByRole('button', { name: 'New tab' }));
  await screen.findByRole('menuitem', { name: /Claude Code CLI/ });
  return view;
}

/**
 * A row by its label. A row that carries the saved-default check also reads "Launch default"
 * first, and "Launch with defaults" repeats the model in its detail line, so the match is
 * anchored.
 */
function row(label: string): RegExp {
  return new RegExp(`^(Launch default ?)?${label.replace('.', '\\.')}`);
}

/**
 * Opens a row's flyout with the right arrow. jsdom has no layout, so the pointer's way from a
 * row into its flyout (Radix's grace area) can't be walked here. The real pointer path is
 * checked in the running app.
 */
async function openFlyout(user: UserEvent, name: RegExp): Promise<void> {
  screen.getByRole('menuitem', { name }).focus();
  await user.keyboard('{ArrowRight}');
}

async function openClaudeModel(user: UserEvent, model: string): Promise<void> {
  await openFlyout(user, /Claude Code CLI/);
  const item = await screen.findByRole('menuitem', { name: row(model) });
  item.focus();
  await user.keyboard('{ArrowRight}');
}

describe('LauncherMenu agent rows', () => {
  it('starts an agent with its launch defaults on a plain click', async () => {
    const { user } = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /Claude Code CLI/ }));
    expect(lastLaunch()).toEqual({ input: 'claude\r', label: undefined });
  });

  it('starts the Nth agent from its digit key', async () => {
    const { user } = await openMenu();
    await user.keyboard('2');
    expect(lastLaunch().input).toBe('gemini\r');
  });

  it('opens a picker for five CLIs and leaves the others as plain rows', async () => {
    const { user } = await openMenu();
    for (const name of [/Claude Code CLI/, /Codex CLI/, /Gemini CLI/, /Grok CLI/, /Cursor CLI/]) {
      expect(screen.getByRole('menuitem', { name }), String(name)).toHaveAttribute(
        'aria-haspopup',
        'menu',
      );
    }
    const copilot = screen.getByRole('menuitem', { name: /GitHub Copilot CLI/ });
    expect(copilot).not.toHaveAttribute('aria-haspopup');
    await user.click(copilot);
    expect(lastLaunch()).toEqual({ input: 'copilot\r', label: undefined });
  });

  it('does not let a digit typed in a flyout start another agent', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Claude Code CLI/);
    const opus = await screen.findByRole('menuitem', { name: row('Opus 5.5') });
    opus.focus();
    await user.keyboard('2');
    expect(terminalTabs()).toHaveLength(0);
  });
});

describe('LauncherMenu model and effort picker', () => {
  it('starts Claude Code on the picked model', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Claude Code CLI/);
    await user.click(await screen.findByRole('menuitem', { name: row('Opus 5.5') }));
    expect(lastLaunch()).toEqual({ input: 'claude --model opus\r', label: 'Opus 5.5' });
  });

  it('starts it on a model and effort picked in the second flyout', async () => {
    const { user } = await openMenu();
    await openClaudeModel(user, 'Opus 5.5');
    expect(await screen.findByText('Effort for Opus 5.5')).toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'High' }));
    expect(lastLaunch()).toEqual({
      input: 'claude --model opus --effort high\r',
      label: 'Opus 5.5 · High',
    });
  });

  it('starts the model alone from the second flyout, leaving the effort to the defaults', async () => {
    useCliStore.setState({ cliLaunchDefaults: { 'claude-code': { effort: 'low' } } });
    const { user } = await openMenu();
    await openClaudeModel(user, 'Opus 5.5');
    const bare = await screen.findByRole('menuitem', { name: /Default effort/ });
    expect(within(bare).getByText('Your setting: Low')).toBeInTheDocument();
    await user.click(bare);
    expect(lastLaunch().input).toBe('claude --effort low --model opus\r');
  });

  it('opens the first flyout from the keyboard, where a launch row comes first', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Claude Code CLI/);
    await user.click(await screen.findByRole('menuitem', { name: /Launch with defaults/ }));
    expect(lastLaunch().input).toBe('claude\r');
  });

  it('starts Grok on a model and one of the efforts it takes', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Grok CLI/);
    const model = await screen.findByRole('menuitem', { name: row('Grok 4.7') });
    model.focus();
    await user.keyboard('{ArrowRight}');
    // Grok stops at High, so the higher levels are not offered.
    expect(await screen.findByRole('menuitem', { name: 'Low' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Max' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Low' }));
    expect(lastLaunch().input).toBe('grok --model grok-4.7 --reasoning-effort low\r');
  });

  it('starts Gemini on a model, with no effort step', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Gemini CLI/);
    const flash = await screen.findByRole('menuitem', { name: row('Gemini 3.8 Flash') });
    expect(flash).not.toHaveAttribute('aria-haspopup');
    await user.click(flash);
    expect(lastLaunch()).toEqual({
      input: 'gemini --model gemini-3.8-flash\r',
      label: 'Gemini 3.8 Flash',
    });
  });

  it('starts Cursor on a model, with no effort step', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Cursor CLI/);
    const sonnet = await screen.findByRole('menuitem', { name: row('Sonnet 4.5') });
    expect(sonnet).not.toHaveAttribute('aria-haspopup');
    await user.click(sonnet);
    expect(lastLaunch()).toEqual({
      input: 'cursor-agent --model sonnet-4.5\r',
      label: 'Sonnet 4.5',
    });
  });

  it('keeps the model but skips the launch defaults on an Alt+click', async () => {
    useCliStore.setState({ cliLaunchDefaults: { 'claude-code': { mode: 'plan' } } });
    const { user } = await openMenu();
    await openFlyout(user, /Claude Code CLI/);
    const opus = await screen.findByRole('menuitem', { name: row('Opus 5.5') });
    await user.keyboard('{Alt>}');
    await user.click(opus);
    await user.keyboard('{/Alt}');
    expect(lastLaunch().input).toBe('claude --model opus\r');
  });
});

describe('LauncherMenu flyout details', () => {
  it('shows each Claude model with its tier and none for Cursor', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Claude Code CLI/);
    const opus = await screen.findByRole('menuitem', { name: row('Opus 5.5') });
    expect(within(opus).getByText('Deep')).toBeInTheDocument();
    const haiku = screen.getByRole('menuitem', { name: row('Haiku 5.5') });
    expect(within(haiku).getByText('Fast')).toBeInTheDocument();
  });

  it('shows a tier on each Gemini model', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Gemini CLI/);
    const tiers = new Map([
      ['Gemini 3.5 Flash-Lite', 'Fast'],
      ['Gemini 3.8 Flash', 'Balanced'],
      ['Gemini 3.1 Pro', 'Deep'],
    ]);
    for (const [label, tier] of tiers) {
      const item = await screen.findByRole('menuitem', { name: row(label) });
      expect(within(item).getByText(tier), label).toBeInTheDocument();
    }
  });

  it('shows no tier on a Cursor model', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Cursor CLI/);
    const auto = await screen.findByRole('menuitem', { name: row('Auto') });
    expect(within(auto).queryByText(/Fast|Balanced|Deep|Frontier/)).toBeNull();
  });

  it('marks the saved launch default and says what a bare launch will use', async () => {
    useCliStore.setState({
      cliLaunchDefaults: { 'claude-code': { model: 'opus', effort: 'high' } },
    });
    const { user } = await openMenu();
    await openFlyout(user, /Claude Code CLI/);
    const bare = await screen.findByRole('menuitem', { name: /Launch with defaults/ });
    expect(within(bare).getByText('Opus 5.5 · High')).toBeInTheDocument();
    const opus = screen.getByRole('menuitem', { name: row('Opus 5.5') });
    expect(within(opus).getByText('Launch default')).toBeInTheDocument();
    const sonnet = screen.getByRole('menuitem', { name: row('Sonnet 5.5') });
    expect(within(sonnet).queryByText('Launch default')).toBeNull();
  });

  it('says the CLI picks for itself when nothing is saved', async () => {
    const { user } = await openMenu();
    await openFlyout(user, /Claude Code CLI/);
    const bare = await screen.findByRole('menuitem', { name: /Launch with defaults/ });
    expect(within(bare).getByText("The CLI's own default")).toBeInTheDocument();
  });
});
