import type { GithubWorkflowInfo } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * Starting a run by hand is the natural moment to say "and fix it if it breaks", so the dialog
 * offers auto-fix next to the branch. It is only offered for a branch, since a fix cannot be
 * pushed to a tag.
 */

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: vi.fn(async () => true) }));

const { RunWorkflowDialog } = await import('./RunWorkflowDialog');

const workflow: GithubWorkflowInfo = {
  id: 9,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  state: 'active',
  htmlUrl: '',
  badgeUrl: '',
  dispatchable: true,
  dispatchInputs: [],
};

const onStarted = vi.fn();

function render(projectId?: string, bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <RunWorkflowDialog
      open
      onOpenChange={() => undefined}
      repo="acme/shop"
      workflow={workflow}
      projectId={projectId}
      onStarted={onStarted}
    />,
    {
      bridge: {
        'pipelines.refs': { ok: true, defaultBranch: 'main', branches: ['main'], tags: ['v1.0'] },
        'pipelines.dispatch': { ok: true },
        'ciAutoFix.start': {
          ok: true,
          session: { id: 'fix-1', workflowName: 'CI', branch: 'main' },
        },
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  onStarted.mockClear();
  toast.success.mockClear();
});

describe('RunWorkflowDialog', () => {
  it('starts the workflow on the default branch', async () => {
    const { user, bridge } = render('proj-1');
    await screen.findByText('main');
    await user.click(screen.getByRole('button', { name: 'Run workflow' }));
    await waitFor(() =>
      expect(bridge.$fn('pipelines.dispatch')).toHaveBeenCalledWith({
        repo: 'acme/shop',
        workflowId: 9,
        ref: 'main',
        inputs: {},
      }),
    );
    expect(onStarted).toHaveBeenCalled();
  });

  it('switches auto-fix on for the dispatched run when asked', async () => {
    const { user, bridge } = render('proj-1');
    await screen.findByText('main');
    await user.click(screen.getByRole('checkbox', { name: 'Auto-fix if it fails' }));
    await user.click(screen.getByRole('button', { name: 'Run workflow' }));
    await waitFor(() =>
      expect(bridge.$fn('ciAutoFix.start')).toHaveBeenCalledWith({
        projectId: 'proj-1',
        repo: 'acme/shop',
        workflowId: 9,
        workflowName: 'CI',
        branch: 'main',
      }),
    );
  });

  it('leaves auto-fix off unless it is ticked', async () => {
    const { user, bridge } = render('proj-1');
    await screen.findByText('main');
    await user.click(screen.getByRole('button', { name: 'Run workflow' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(() => bridge.$fn('ciAutoFix.start')).toThrow();
  });

  it('does not switch auto-fix on when the run did not start', async () => {
    const { user, bridge } = render('proj-1', {
      'pipelines.dispatch': { ok: false, error: 'No workflow_dispatch trigger.' },
    });
    await screen.findByText('main');
    await user.click(screen.getByRole('checkbox', { name: 'Auto-fix if it fails' }));
    await user.click(screen.getByRole('button', { name: 'Run workflow' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(() => bridge.$fn('ciAutoFix.start')).toThrow();
  });

  it('does not offer auto-fix without a project to fix it in', async () => {
    render();
    await screen.findByText('main');
    expect(screen.queryByRole('checkbox', { name: 'Auto-fix if it fails' })).toBeNull();
  });
});
