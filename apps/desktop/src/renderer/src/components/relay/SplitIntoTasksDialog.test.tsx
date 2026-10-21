import type { ProposalEntry, RelayProposal } from '@agentmat/core';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { useRelayPlannerStore } from './RelayPlannerPicker';
import { SplitIntoTasksDialog } from './SplitIntoTasksDialog';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const PROPOSAL: RelayProposal = {
  summary: 'Two tasks.',
  add: [
    { id: 'T014', title: 'Search API', estimate: 90_000 },
    { id: 'T015', title: 'Search UI', estimate: 80_000, depends: ['T014'] },
  ],
  change: [],
  split: [],
  remove: [],
};
const ENTRIES: ProposalEntry[] = [
  { kind: 'add', id: 'T014', title: 'Search API', fields: [] },
  { kind: 'add', id: 'T015', title: 'Search UI', fields: [] },
];
const PLANNED = { ok: true, proposal: PROPOSAL, entries: ENTRIES, cliName: 'Claude Code' };
const APPLIED = {
  written: ['T014-search-api.md', 'T015-search-ui.md', 'T003-export.md'],
  removed: [],
  warnings: [],
};

const project = { id: 'p1', name: 'Apollo', folderPath: '/work/apollo', cliId: 'claude-code' };
const board = {
  projectId: 'p1',
  docsFolder: 'docs',
  exists: true,
  guidePresent: true,
  tasks: [
    { id: 'T003', title: 'Export', status: 'in-progress' },
    { id: 'T001', title: 'Login', status: 'done' },
  ],
  order: ['T001', 'T003'],
  cycles: [],
  missing: [],
  issues: [],
  settings: {},
  active: null,
};

function bridge(overrides: Record<string, unknown> = {}) {
  return {
    'projects.list': [project, { ...project, id: 'p2', name: 'Hermes' }],
    'cli.detectAll': [{ id: 'claude-code', installed: true }],
    'relay.decompose': async () => PLANNED,
    'relay.applyProposal': async () => APPLIED,
    'relay.start': async () => ({ ok: true, run: { id: 'r1' } }),
    'relay.board': async () => board,
    ...overrides,
  };
}

function open(props: Partial<Parameters<typeof SplitIntoTasksDialog>[0]> = {}, overrides = {}) {
  return renderWithProviders(
    <SplitIntoTasksDialog
      open
      onOpenChange={() => undefined}
      request="Add a patient search page"
      projectId="p1"
      {...props}
    />,
    { bridge: bridge(overrides) },
  );
}

async function plan(user: ReturnType<typeof open>['user']): Promise<void> {
  const button = await screen.findByRole('button', { name: 'Plan tasks' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await screen.findByRole('list', { name: 'Proposed changes' });
}

beforeEach(() => {
  useRelayPlannerStore.setState({ choice: null });
  useRelayBoardStore.setState({ projectId: null, focusTaskId: null });
  toast.error.mockClear();
  toast.success.mockClear();
});

describe('SplitIntoTasksDialog', () => {
  it('asks the planner for tasks with the request, the budget and the planner', async () => {
    const { user, bridge: fake } = open();

    expect(screen.getByRole('textbox', { name: 'What should the tasks deliver?' })).toHaveValue(
      'Add a patient search page',
    );
    await user.click(screen.getByRole('radio', { name: '400K' }));
    await plan(user);

    expect(fake.$fn('relay.decompose')).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        request: 'Add a patient search page',
        budget: 400_000,
        cliId: 'claude-code',
        requestId: expect.stringMatching(/^relay-plan-/),
      }),
    );
    expect(screen.getByRole('listitem', { name: /New task T014/ })).toBeInTheDocument();
  });

  it('explains a planner that failed and lets the user try again', async () => {
    const { user } = open(
      {},
      {
        'relay.decompose': async () => ({ ok: false, error: 'Claude Code is not signed in.' }),
      },
    );

    const button = await screen.findByRole('button', { name: 'Plan tasks' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    expect(await screen.findByText('Claude Code is not signed in.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plan tasks' })).toBeEnabled();
  });

  it('cancels a planner that is still running', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { user, bridge: fake } = open(
      {},
      {
        'relay.decompose': () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    );

    const button = await screen.findByRole('button', { name: 'Plan tasks' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText(/is reading the project/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel planning' }));

    const requestId = (fake.$fn('relay.decompose').mock.calls[0][0] as { requestId: string })
      .requestId;
    expect(fake.$fn('relay.cancelPlanner')).toHaveBeenCalledWith(requestId);
    await act(async () => finish(PLANNED));
    expect(screen.queryByRole('list', { name: 'Proposed changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plan tasks' })).toBeInTheDocument();
  });

  it('adds the edited tasks and starts a relay on just those tasks', async () => {
    const { user, bridge: fake } = open();
    await plan(user);

    await user.click(screen.getByRole('button', { name: 'Leave out T015' }));
    await user.click(screen.getByRole('radio', { name: /Run now/ }));
    await user.click(screen.getByRole('switch', { name: 'Plan first' }));
    await user.click(screen.getByRole('button', { name: 'Add 1 task to board' }));

    await waitFor(() => expect(fake.$fn('relay.start')).toHaveBeenCalled());
    expect(fake.$fn('relay.applyProposal')).toHaveBeenCalledWith('p1', {
      ...PROPOSAL,
      add: [PROPOSAL.add[0]],
    });
    expect(fake.$fn('relay.start')).toHaveBeenCalledWith({
      projectId: 'p1',
      only: ['T014', 'T015'],
      trigger: { kind: 'now' },
      options: { planFirst: true },
    });
    expect(await screen.findByText(/Added T014 and T015/)).toBeInTheDocument();
  });

  it('only adds the tasks when the user chose to', async () => {
    const start = vi.fn();
    const { user } = open({}, { 'relay.start': start });
    await plan(user);

    await user.click(screen.getByRole('button', { name: 'Add 2 tasks to board' }));

    expect(await screen.findByText(/Added T014 and T015/)).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Open board' }));
    expect(useRelayBoardStore.getState().projectId).toBe('p1');
  });

  it('starts after another task is done', async () => {
    const { user, bridge: fake } = open();
    await plan(user);

    await user.click(screen.getByRole('radio', { name: /After a task/ }));
    await user.click(screen.getByRole('combobox', { name: 'Task to wait for' }));
    await user.click(await screen.findByRole('option', { name: /T003 Export/ }));
    await user.click(screen.getByRole('button', { name: 'Add 2 tasks to board' }));

    await waitFor(() => expect(fake.$fn('relay.start')).toHaveBeenCalled());
    expect(fake.$fn('relay.start')).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { kind: 'after-task', projectId: 'p1', taskId: 'T003' },
        options: { planFirst: false },
      }),
    );
  });

  it('starts after an agent session that is working now', async () => {
    useWorkspaceStore.getState().openProject('p1');
    const tabId = useWorkspaceStore
      .getState()
      .addTerminal('p1', { title: 'Claude Code', cliId: 'claude-code', cwd: '/work/apollo' });
    useAgentStatusStore.setState({ statuses: { [tabId]: 'working' } });
    const { user, bridge: fake } = open();
    await plan(user);

    await user.click(screen.getByRole('radio', { name: /After a session/ }));
    await user.click(screen.getByRole('combobox', { name: 'Session to wait for' }));
    await user.click(await screen.findByRole('option', { name: /Claude Code/ }));
    await user.click(screen.getByRole('button', { name: 'Add 2 tasks to board' }));

    await waitFor(() => expect(fake.$fn('relay.start')).toHaveBeenCalled());
    expect(fake.$fn('relay.start')).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { kind: 'after-session', sessionId: tabId, label: 'Apollo · Claude Code' },
      }),
    );
  });

  it('starts at a chosen time', async () => {
    const { user, bridge: fake } = open();
    await plan(user);

    await user.click(screen.getByRole('radio', { name: /At a time/ }));
    fireEvent.change(screen.getByLabelText('Start at'), {
      target: { value: '2030-01-02T09:30' },
    });
    await user.click(screen.getByRole('button', { name: 'Add 2 tasks to board' }));

    await waitFor(() => expect(fake.$fn('relay.start')).toHaveBeenCalled());
    expect(fake.$fn('relay.start')).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { kind: 'at', at: new Date('2030-01-02T09:30').getTime() },
      }),
    );
  });

  it('lets the user pick the project when it opens from the Prompt Builder', async () => {
    const { user, bridge: fake } = open({ projectId: null });

    expect(screen.getByRole('button', { name: 'Plan tasks' })).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    await user.click(await screen.findByRole('option', { name: 'Hermes' }));
    await plan(user);

    expect(fake.$fn('relay.decompose')).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p2' }),
    );
  });

  it('never uses the native title attribute', async () => {
    const { user } = open();
    await plan(user);
    expect(document.body.querySelector('[title]')).toBeNull();
  });
});
