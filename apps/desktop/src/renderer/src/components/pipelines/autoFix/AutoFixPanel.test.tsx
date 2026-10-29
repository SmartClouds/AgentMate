import type { AutoFixAttempt, AutoFixSession } from '@shared/ciAutoFixTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

/**
 * The panel is where the user steps in: when auto-fix needs them it says why in a sentence with
 * the one action that unblocks it, and stopping asks first, since an agent may be mid-edit.
 */

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { AutoFixPanel } = await import('./AutoFixPanel');

function attempt(patch: Partial<AutoFixAttempt> = {}): AutoFixAttempt {
  return {
    n: 1,
    runId: 100,
    runNumber: 7,
    startedAt: 0,
    tabId: 'tab-1',
    baseSha: 'aaa',
    commitSha: null,
    nextRunId: null,
    nextRunNumber: null,
    outcome: 'fixing',
    ...patch,
  };
}

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
    runLabel: 'Opus 5.5',
    maxAttempts: 3,
    runId: 100,
    runNumber: 7,
    waitFor: null,
    phase: 'fixing',
    blocker: null,
    message: null,
    attempts: [attempt()],
    agent: { hooks: true, sawWork: true, quietSince: null },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const bridge = {
  'ciAutoFix.stop': async () => null,
  'ciAutoFix.commitNow': async () => null,
  'ciAutoFix.retry': async () => null,
  'ciAutoFix.dismiss': async () => true,
};

beforeEach(() => {
  navigate.mockClear();
  confirm.mockClear();
  confirm.mockResolvedValue(true);
});

describe('AutoFixPanel', () => {
  it('names the CLI and model, and says what it is doing', () => {
    renderWithProviders(<AutoFixPanel session={session()} />, { bridge });
    expect(screen.getByText('Fixing 1/3')).toBeVisible();
    expect(screen.getByText('Claude Code CLI · Opus 5.5')).toBeVisible();
    expect(screen.getByText('Claude Code CLI is working on the failure in its tab.')).toBeVisible();
  });

  it('opens the agent tab in its project workspace', async () => {
    const { user } = renderWithProviders(<AutoFixPanel session={session()} />, { bridge });
    await user.click(screen.getByRole('button', { name: 'Open agent tab' }));
    expect(navigate).toHaveBeenCalledWith('/workspace/proj-1?session=tab-1');
  });

  it('commits and pushes on request, without waiting for the agent to look done', async () => {
    const { user, bridge: fake } = renderWithProviders(<AutoFixPanel session={session()} />, {
      bridge,
    });
    await user.click(screen.getByRole('button', { name: 'Commit & push now' }));
    expect(fake.$fn('ciAutoFix.commitNow')).toHaveBeenCalledWith('fix-1');
  });

  it('asks before stopping, and leaves it on when the user backs out', async () => {
    confirm.mockResolvedValueOnce(false);
    const { user, bridge: fake } = renderWithProviders(<AutoFixPanel session={session()} />, {
      bridge,
    });
    await user.click(screen.getByRole('button', { name: 'Stop auto-fix' }));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Stop auto-fix for CI?', confirmLabel: 'Stop auto-fix' }),
    );
    expect(() => fake.$fn('ciAutoFix.stop')).toThrow();

    await user.click(screen.getByRole('button', { name: 'Stop auto-fix' }));
    await waitFor(() => expect(fake.$fn('ciAutoFix.stop')).toHaveBeenCalledWith('fix-1'));
  });

  it('says what blocks it and offers Retry for something the user fixes outside', async () => {
    const { user, bridge: fake } = renderWithProviders(
      <AutoFixPanel
        session={session({
          phase: 'attention',
          blocker: 'dirty-tree',
          message: 'The project has uncommitted changes.',
          attempts: [attempt({ tabId: null })],
        })}
      />,
      { bridge },
    );
    expect(screen.getByText('The project has uncommitted changes.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open agent tab' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fake.$fn('ciAutoFix.retry')).toHaveBeenCalledWith('fix-1');
  });

  it('sends the user to the tab when the agent asked a question', () => {
    renderWithProviders(
      <AutoFixPanel
        session={session({
          phase: 'attention',
          blocker: 'needs-input',
          message: 'The agent is waiting for an answer in its tab.',
        })}
      />,
      { bridge },
    );
    expect(screen.getByRole('button', { name: 'Answer in tab' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Commit & push now' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('lists every attempt with its runs and commit', () => {
    renderWithProviders(
      <AutoFixPanel
        session={session({
          phase: 'watching',
          runId: 102,
          runNumber: 9,
          attempts: [
            attempt({
              outcome: 'failed',
              commitSha: 'bbbbbbb111',
              nextRunId: 101,
              nextRunNumber: 8,
            }),
            attempt({
              n: 2,
              runId: 101,
              runNumber: 8,
              outcome: 'pushed',
              commitSha: 'ccccccc222',
              nextRunId: 102,
              nextRunNumber: 9,
            }),
          ],
        })}
      />,
      { bridge },
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Attempt 1');
    expect(items[0]).toHaveTextContent('Run #7 failed');
    expect(items[0]).toHaveTextContent('Pushed bbbbbbb');
    expect(items[0]).toHaveTextContent('Run #8 failed');
    expect(items[1]).toHaveTextContent('Run #9 running');
  });

  it('can clear a finished session from the list', async () => {
    const { user, bridge: fake } = renderWithProviders(
      <AutoFixPanel
        session={session({ phase: 'succeeded', attempts: [attempt({ outcome: 'passed' })] })}
      />,
      { bridge },
    );
    expect(screen.queryByRole('button', { name: 'Stop auto-fix' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(fake.$fn('ciAutoFix.dismiss')).toHaveBeenCalledWith('fix-1');
  });
});
