import { launchPickArgs, launchPickLabel } from '@runova/core';
import type { AutoFixSession } from '@shared/ciAutoFixTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

/**
 * Switching auto-fix on hands a branch to an agent, so the setup says plainly what will happen
 * (which CLI on which model, which branch, how many tries) before anything starts, and the chip afterwards keeps
 * saying where it stands.
 */

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { AutoFixControl } = await import('./AutoFixControl');

const target = {
  projectId: 'proj-1',
  repo: 'acme/shop',
  workflowId: 9,
  workflowName: 'CI',
  branch: 'main',
  runId: 100,
  runNumber: 7,
};

const project = {
  id: 'proj-1',
  name: 'Shop',
  folderPath: '/work/shop',
  cliId: null,
  agentType: 'claude-code',
};

const installed = (...ids: string[]) =>
  ['claude-code', 'codex-cli', 'gemini-cli'].map((id) => ({ id, installed: ids.includes(id) }));

function session(patch: Partial<AutoFixSession> = {}): AutoFixSession {
  return {
    id: 'fix-1',
    projectId: 'proj-1',
    projectName: 'Shop',
    repo: 'acme/shop',
    workflowId: 9,
    workflowName: 'CI',
    branch: 'main',
    cliId: 'claude-code',
    runArgs: [],
    runLabel: null,
    maxAttempts: 3,
    runId: 100,
    runNumber: 7,
    waitFor: null,
    phase: 'watching',
    blocker: null,
    message: null,
    attempts: [],
    agent: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function render(
  options: { live?: boolean; bridge?: Record<string, unknown> } = {},
): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(<AutoFixControl target={target} live={options.live ?? true} />, {
    bridge: {
      'cli.detectAll': installed('claude-code', 'codex-cli'),
      'settings.get': { ciAutoFixCliId: null, ciAutoFixMaxAttempts: 3 },
      'projects.list': [project],
      ...options.bridge,
    },
  });
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('a live run without auto-fix', () => {
  it('offers to switch it on, and says what will happen before it does', async () => {
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Auto-fix this run if it fails' }));

    expect(await screen.findByRole('heading', { name: 'Auto-fix this run' })).toBeVisible();
    expect(
      await screen.findByText(
        'If run #7 fails, Claude Code CLI fixes it in a new tab of Shop. Runova then commits the fix, pushes it to main and checks the next run, up to 3 tries.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/Keep Shop on main with nothing uncommitted/)).toBeVisible();
  });

  it('starts with the CLI picked for auto-fix in Settings when it is installed', async () => {
    const { user } = render({
      bridge: { 'settings.get': { ciAutoFixCliId: 'codex-cli', ciAutoFixMaxAttempts: 2 } },
    });
    await user.click(await screen.findByRole('button', { name: 'Auto-fix this run if it fails' }));
    expect(await screen.findByText(/Codex CLI fixes it/)).toBeVisible();
    expect(screen.getByText(/up to 2 tries/)).toBeVisible();
  });

  it('turns it on with the chosen CLI and number of tries', async () => {
    const { user, bridge } = render({
      bridge: { 'ciAutoFix.start': { ok: true, session: session() } },
    });
    await user.click(await screen.findByRole('button', { name: 'Auto-fix this run if it fails' }));
    await screen.findByText(/Claude Code CLI fixes it/);
    await user.click(screen.getByRole('button', { name: 'More tries' }));
    await user.click(screen.getByRole('button', { name: 'Turn on auto-fix' }));

    await waitFor(() =>
      expect(bridge.$fn('ciAutoFix.start')).toHaveBeenCalledWith({
        ...target,
        cliId: 'claude-code',
        runArgs: [],
        runLabel: null,
        maxAttempts: 4,
      }),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('turns it on with the chosen model and effort', async () => {
    const { user, bridge } = render({
      bridge: { 'ciAutoFix.start': { ok: true, session: session() } },
    });
    await user.click(await screen.findByRole('button', { name: 'Auto-fix this run if it fails' }));
    await user.click(await screen.findByRole('combobox', { name: 'Model for auto-fix' }));
    // No model means the CLI default, and the effort flag only goes along with a model.
    expect(screen.queryByRole('radiogroup', { name: 'Effort' })).toBeNull();
    await user.click(await screen.findByRole('option', { name: /Opus/ }));
    await user.click(await screen.findByRole('radio', { name: 'High' }));
    const pick = { model: 'opus', effort: 'high' } as const;
    expect(
      await screen.findByText(
        `Claude Code CLI (${launchPickLabel('claude-code', pick)}) fixes it`,
        { exact: false },
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Turn on auto-fix' }));

    await waitFor(() =>
      expect(bridge.$fn('ciAutoFix.start')).toHaveBeenCalledWith({
        ...target,
        cliId: 'claude-code',
        runArgs: launchPickArgs('claude-code', pick),
        runLabel: launchPickLabel('claude-code', pick),
        maxAttempts: 3,
      }),
    );
  });

  it('starts with the model and effort from Settings, and drops them for another CLI', async () => {
    const { user } = render({
      bridge: {
        'settings.get': {
          ciAutoFixCliId: 'claude-code',
          ciAutoFixModel: 'opus',
          ciAutoFixEffort: 'high',
          ciAutoFixMaxAttempts: 3,
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Auto-fix this run if it fails' }));
    const label = launchPickLabel('claude-code', { model: 'opus', effort: 'high' });
    expect(await screen.findByRole('combobox', { name: 'Model for auto-fix' })).toHaveTextContent(
      /Opus/,
    );
    expect(screen.getByRole('radio', { name: 'High' })).toBeChecked();
    expect(screen.getByText(`Claude Code CLI (${label})`, { exact: false })).toBeVisible();

    await user.click(screen.getByRole('combobox', { name: 'Agent CLI for auto-fix' }));
    await user.click(await screen.findByRole('option', { name: /Codex/ }));
    expect(await screen.findByText(/Codex CLI fixes it/)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Model for auto-fix' })).toHaveTextContent(
      'CLI default',
    );
  });

  it('keeps the tries between 1 and 5', async () => {
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: 'Auto-fix this run if it fails' }));
    await screen.findByText(/Claude Code CLI fixes it/);
    const fewer = screen.getByRole('button', { name: 'Fewer tries' });
    await user.click(fewer);
    await user.click(fewer);
    await user.click(fewer);
    expect(screen.getByText('1', { selector: 'output' })).toBeVisible();
    expect(fewer).toBeDisabled();
    const more = screen.getByRole('button', { name: 'More tries' });
    for (let i = 0; i < 6; i += 1) if (!more.hasAttribute('disabled')) await user.click(more);
    expect(screen.getByText('5', { selector: 'output' })).toBeVisible();
    expect(more).toBeDisabled();
  });

  it('points to the CLI Manager when no agent CLI is installed', async () => {
    const { user } = render({ bridge: { 'cli.detectAll': installed() } });
    await user.click(await screen.findByRole('button', { name: 'Auto-fix this run if it fails' }));
    expect(await screen.findByText(/No agent CLI is installed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Turn on auto-fix' })).toBeDisabled();
  });
});

describe('a run auto-fix is handling', () => {
  it('shows where it stands in words', async () => {
    render({
      bridge: {
        'ciAutoFix.list': [
          session({
            phase: 'fixing',
            attempts: [
              {
                n: 1,
                runId: 100,
                runNumber: 7,
                startedAt: 0,
                tabId: 'tab-1',
                baseSha: 'a',
                commitSha: null,
                nextRunId: null,
                nextRunNumber: null,
                outcome: 'fixing',
              },
            ],
          }),
        ],
      },
    });
    expect(await screen.findByRole('button', { name: /Auto-fix: Fixing 1\/3/ })).toBeVisible();
  });

  it('opens the session panel from the chip', async () => {
    const { user } = render({ bridge: { 'ciAutoFix.list': [session()] } });
    await user.click(await screen.findByRole('button', { name: /Auto-fix: Auto-fix on/ }));
    expect(await screen.findByRole('button', { name: 'Stop auto-fix' })).toBeVisible();
  });

  it('still shows a finished session on a run that is no longer live', async () => {
    render({ live: false, bridge: { 'ciAutoFix.list': [session({ phase: 'gave-up' })] } });
    expect(await screen.findByRole('button', { name: /Auto-fix: Gave up/ })).toBeVisible();
  });
});

describe('a finished run without auto-fix', () => {
  it('shows nothing', async () => {
    const { container } = render({ live: false });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
