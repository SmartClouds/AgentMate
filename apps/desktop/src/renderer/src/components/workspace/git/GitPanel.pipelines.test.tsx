import type { Project } from '@agentmat/core';
import type {
  GithubWorkflowInfo,
  GithubWorkflowRunInfo,
  ProjectPipelineStatus,
  PullRequestStatus,
  WorkspaceGitState,
} from '@shared/apiTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { GitPanel } from './GitPanel';

/**
 * The large Pipelines view as it's reached from the panel: the expand button in the Pipelines
 * header and a click on a pipeline's card, both fed by the same live status the section shows.
 */

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app', cliId: 'claude' } as Project;

function workflow(id: number, name: string): GithubWorkflowInfo {
  return {
    id,
    name,
    path: `.github/workflows/${name.toLowerCase()}.yml`,
    state: 'active',
    htmlUrl: `https://github.com/acme/app/actions/workflows/${name.toLowerCase()}.yml`,
    badgeUrl: '',
    dispatchable: false,
    dispatchInputs: [],
  };
}

function run(
  workflowId: number,
  name: string,
  conclusion: GithubWorkflowRunInfo['conclusion'],
): GithubWorkflowRunInfo {
  return {
    id: workflowId * 100,
    workflowId,
    name,
    displayTitle: `${name} commit`,
    runNumber: workflowId,
    headBranch: 'master',
    status: 'completed',
    conclusion,
    htmlUrl: `https://github.com/acme/app/actions/runs/${workflowId * 100}`,
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  };
}

const pipelineStatus: ProjectPipelineStatus = {
  projectId: 'p1',
  cliAvailable: true,
  authenticated: true,
  github: { owner: 'acme', repo: 'app' },
  workflows: [workflow(1, 'CD'), workflow(2, 'Nightly')],
  runsByWorkflowId: { 1: run(1, 'CD', 'failure'), 2: run(2, 'Nightly', 'success') },
};

const prStatus: PullRequestStatus = {
  cliAvailable: true,
  authenticated: true,
  github: { owner: 'acme', repo: 'app' },
  branch: 'feature',
  defaultBranch: 'master',
  onDefaultBranch: false,
  ahead: 0,
  hasUpstream: true,
  dirty: false,
  pr: null,
};

function gitState(overrides: Partial<WorkspaceGitState> = {}): WorkspaceGitState {
  return {
    isRepo: true,
    branch: 'feature',
    detached: false,
    head: 'abc1234',
    upstream: 'origin/feature',
    ahead: 0,
    behind: 0,
    hasRemote: true,
    operation: null,
    conflicts: [],
    staged: [],
    unstaged: [],
    untracked: [],
    untrackedTruncated: false,
    projectPrefix: '',
    ...overrides,
  } as WorkspaceGitState;
}

const status = vi.fn();
const runDetails = vi.fn();

function renderPanel(state: WorkspaceGitState = gitState()) {
  return renderWithProviders(<GitPanel project={project} visible />, {
    bridge: {
      'git.workspaceState': state,
      'git.fetch': { ok: true, message: '' },
      'git.status': { branches: [], defaultBranch: 'master' },
      'pullRequests.status': prStatus,
      'settings.get': { reviewCommands: [] },
      'pipelines.status': status,
      'pipelines.runDetails': runDetails,
      'pipelines.runAnnotations': { ok: true, annotations: [], counts: {} },
      'shell.openExternal': vi.fn(),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  status.mockResolvedValue(pipelineStatus);
  runDetails.mockResolvedValue({ ok: true, jobs: [] });
  useWorkspaceStore.getState().revealPanelSection('pipelines');
});

describe('GitPanel large pipelines view', () => {
  it('opens from the Pipelines header on the first pipeline, failures first', async () => {
    const { user } = renderPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Open pipelines in a larger view' }),
    );

    const dialog = await screen.findByRole('dialog', { name: 'Pipelines' });
    expect(within(dialog).getByRole('heading', { name: 'CD' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^CD/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: /^Nightly/ })).toBeInTheDocument();
  });

  it('opens on the pipeline whose card was clicked', async () => {
    const { user } = renderPanel();
    const card = await screen.findByRole('button', { name: /Nightly/ });

    await user.click(card);

    const dialog = await screen.findByRole('dialog', { name: 'Pipelines' });
    expect(within(dialog).getByRole('heading', { name: 'Nightly' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Nightly/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('opens on the first pipeline again when reopened from the header', async () => {
    const { user } = renderPanel();
    await user.click(await screen.findByRole('button', { name: /Nightly/ }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Open pipelines in a larger view' }));

    const dialog = await screen.findByRole('dialog', { name: 'Pipelines' });
    expect(within(dialog).getByRole('heading', { name: 'CD' })).toBeInTheDocument();
  });

  it('closes on Escape and leaves the panel as it was', async () => {
    const { user } = renderPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Open pipelines in a larger view' }),
    );
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useWorkspaceStore.getState().gitPanel.openSourceSections.pipelines).toBe(true);
  });

  it('keeps the rows in the open dialog when a refresh fails', async () => {
    const { user, queryClient } = renderPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Open pipelines in a larger view' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Pipelines' });

    status.mockResolvedValueOnce({ ...pipelineStatus, error: 'rate limited' });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelineStatus('p1') });
    });

    expect(status).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole('button', { name: /^CD/ })).toBeInTheDocument();
    expect(within(dialog).queryByText('Could not load pipelines')).not.toBeInTheDocument();
  });

  it('has nothing to expand without a remote', async () => {
    renderPanel(gitState({ hasRemote: false, upstream: null }));
    // The section only renders once the git state has loaded.
    expect(await screen.findByRole('region', { name: 'Pipelines' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open pipelines in a larger view' }),
    ).not.toBeInTheDocument();
  });

  it('does not read GitHub for pipelines while the section is folded', async () => {
    useWorkspaceStore.getState().setSourceSectionOpen('pipelines', false);
    renderPanel();
    await screen.findByRole('region', { name: 'Pipelines' });

    // Give a stray fetch every chance to happen.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 100));
    });

    expect(status).not.toHaveBeenCalled();
  });
});
