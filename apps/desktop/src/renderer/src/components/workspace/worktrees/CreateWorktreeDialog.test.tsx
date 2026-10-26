// @vitest-environment jsdom
import type { Project, WorktreeInfo } from '@runova/core';
import type { WorktreeDefaults } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CreateWorktreeDialog } from './CreateWorktreeDialog';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const launch = vi.hoisted(() => ({
  launchSetupTab: vi.fn(() => 'setup-tab'),
  launchPromptTab: vi.fn(() => 'agent-tab'),
  launchAgentTab: vi.fn(() => 'agent-tab'),
  projectCliId: vi.fn(() => 'claude-code'),
}));
vi.mock('@/lib/workspace/launch', () => launch);

const project = {
  id: 'p1',
  name: 'App',
  folderPath: 'C:\\code\\app',
  cliId: null,
  worktreeSetup: { command: 'pnpm install', copyGlobs: null },
} as unknown as Project;

const defaults: WorktreeDefaults = {
  isRepo: true,
  defaultBranch: 'main',
  currentBranch: 'main',
  branches: [
    { name: 'dev', local: true, remote: false },
    { name: 'main', local: true, remote: false },
    { name: 'busy', local: true, remote: false, worktreePath: 'C:\\code\\app.worktrees\\busy' },
  ],
  copyGlobs: ['.env', '.env.*'],
  setupCommand: 'pnpm install',
};

const worktree = {
  id: 'wt-1',
  projectId: 'p1',
  path: 'C:\\code\\app.worktrees\\feat-login',
  branch: 'feat/login',
  baseBranch: 'main',
  createdAt: '2026-09-25T00:00:00.000Z',
  createdByApp: true,
  missing: false,
  locked: false,
  status: null,
} satisfies WorktreeInfo;

const onClose = vi.fn();

function renderDialog(bridge: Record<string, unknown> = {}, request = {}) {
  return renderWithProviders(
    <CreateWorktreeDialog
      project={project}
      request={{ projectId: 'p1', ...request }}
      onClose={onClose}
    />,
    {
      bridge: {
        'worktrees.defaults': defaults,
        'worktrees.suggestPath': (_id: string, branch: string) =>
          Promise.resolve(`C:\\code\\app.worktrees\\${branch.replaceAll('/', '-')}`),
        'worktrees.previewCopy': ['.env'],
        'worktrees.create': { ok: true, worktree },
        'worktrees.copyFiles': ['.env'],
        'cli.detectAll': [{ id: 'claude-code', installed: true }],
        platform: 'win32',
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  navigate.mockClear();
  onClose.mockClear();
  for (const fn of Object.values(launch)) fn.mockClear();
});

describe('CreateWorktreeDialog', () => {
  it('starts from the default branch and shows where the worktree will go', async () => {
    const { user } = renderDialog();
    const name = await screen.findByLabelText('Branch name');
    expect(screen.getByRole('combobox', { name: 'Based on' })).toHaveTextContent('main');
    await user.type(name, 'feat/login');
    expect(await screen.findByText('C:\\code\\app.worktrees\\feat-login')).toBeInTheDocument();
    expect(screen.getByText('1 file: .env')).toBeInTheDocument();
    expect(screen.getByLabelText('Setup command')).toHaveValue('pnpm install');
  });

  it('keeps Create off until the branch name is usable, and says why', async () => {
    const { user } = renderDialog();
    await screen.findByLabelText('Branch name');
    const create = screen.getByRole('button', { name: /Create worktree/ });
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText('Branch name'), 'bad name');
    expect(screen.getByText('Branch names cannot contain spaces.')).toBeInTheDocument();
    expect(create).toBeDisabled();

    await user.clear(screen.getByLabelText('Branch name'));
    await user.type(screen.getByLabelText('Branch name'), 'dev');
    expect(screen.getByText(/A branch named dev already exists/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use the existing branch' }));
    expect(screen.getByRole('radio', { name: 'Existing branch' })).toBeChecked();
  });

  it('suggests a branch name from the task', async () => {
    const { user, bridge } = renderDialog({
      'worktrees.suggestBranch': { ok: true, text: 'feat/add-login' },
    });
    await user.type(await screen.findByLabelText('Task'), 'Add a login page');
    await user.click(screen.getByRole('button', { name: 'Suggest a branch name from the task' }));
    await waitFor(() => expect(screen.getByLabelText('Branch name')).toHaveValue('feat/add-login'));
    expect(bridge.$fn('worktrees.suggestBranch')).toHaveBeenCalledWith(
      'p1',
      'Add a login page',
      expect.any(String),
    );
  });

  it('leaves branches that are open elsewhere out of the existing branch list', async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole('radio', { name: 'Existing branch' }));
    await user.click(screen.getByRole('combobox', { name: 'Branch' }));
    const list = await screen.findByRole('listbox');
    expect(within(list).getByText('dev')).toBeInTheDocument();
    expect(within(list).queryByText('busy')).toBeNull();
    expect(screen.getByText('1 branch is open in another worktree.')).toBeInTheDocument();
  });

  it('creates the worktree, shows each step, and opens its workspace with the agent', async () => {
    const { user, bridge } = renderDialog();
    await user.type(await screen.findByLabelText('Task'), 'Add a login page');
    await user.type(screen.getByLabelText('Branch name'), 'feat/login');
    await screen.findByText('C:\\code\\app.worktrees\\feat-login');
    await user.click(screen.getByRole('button', { name: /Create worktree/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bridge.$fn('worktrees.create')).toHaveBeenCalledWith({
      projectId: 'p1',
      branch: 'feat/login',
      mode: 'new',
      base: 'main',
      path: null,
    });
    expect(bridge.$fn('worktrees.copyFiles')).toHaveBeenCalledWith('p1', 'wt-1', ['.env']);
    expect(navigate).toHaveBeenCalledWith('/workspace/p1~wt-1');
    expect(launch.launchSetupTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1~wt-1', folderPath: worktree.path }),
      'pnpm install',
    );
    expect(launch.launchPromptTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1~wt-1' }),
      { cliId: 'claude-code', prompt: 'Add a login page' },
    );
  });

  it('starts the agent bare when there is no task, and can skip it', async () => {
    const { user } = renderDialog();
    await user.type(await screen.findByLabelText('Branch name'), 'x');
    await user.click(screen.getByRole('button', { name: /Create worktree/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(launch.launchAgentTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1~wt-1' }),
      'claude-code',
    );
  });

  it('shows why creating failed and goes back to the form with everything kept', async () => {
    const { user } = renderDialog({
      'worktrees.create': { ok: false, error: "A branch named 'x' already exists." },
    });
    await user.type(await screen.findByLabelText('Branch name'), 'x');
    await user.click(screen.getByRole('button', { name: /Create worktree/ }));

    expect(await screen.findByText("A branch named 'x' already exists.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Branch name')).toHaveValue('x');
  });

  it('explains that a folder that is not a repository cannot have worktrees', async () => {
    renderDialog({ 'worktrees.defaults': { ...defaults, isRepo: false, branches: [] } });
    expect(await screen.findByText(/not a git repository yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create worktree/ })).toBeNull();
  });

  it('opens on an existing branch when asked to', async () => {
    renderDialog({}, { branch: 'dev', mode: 'existing' });
    expect(await screen.findByRole('radio', { name: 'Existing branch' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('dev');
  });
});
