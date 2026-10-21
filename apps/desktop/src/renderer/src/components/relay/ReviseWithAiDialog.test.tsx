import type { ProposalEntry, RelayProposal } from '@agentmat/core';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { useRelayPlannerStore } from './RelayPlannerPicker';
import { ReviseWithAiDialog } from './ReviseWithAiDialog';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const PROPOSAL: RelayProposal = {
  summary: 'The docs added archived patients.',
  add: [{ id: 'T020', title: 'Archived search', estimate: 70_000 }],
  change: [{ id: 'T004', title: 'Search all patients' }],
  split: [],
  remove: [{ id: 'T009', reason: 'No longer in the docs.' }],
};
const ENTRIES: ProposalEntry[] = [
  { kind: 'add', id: 'T020', title: 'Archived search', fields: [] },
  {
    kind: 'change',
    id: 'T004',
    title: 'Search all patients',
    fields: [{ field: 'title', before: 'Search', after: 'Search all patients' }],
  },
  { kind: 'remove', id: 'T009', title: 'Old', fields: [], reason: 'No longer in the docs.' },
];

const board = {
  projectId: 'p1',
  docsFolder: 'planning',
  exists: true,
  guidePresent: true,
  tasks: [],
  order: [],
  cycles: [],
  missing: [],
  issues: [],
  settings: { options: { defaultBudget: 400_000 } },
  active: null,
};

function open(overrides: Record<string, unknown> = {}, onOpenChange = vi.fn()) {
  const view = renderWithProviders(
    <ReviseWithAiDialog projectId="p1" open onOpenChange={onOpenChange} />,
    {
      bridge: {
        'projects.list': [{ id: 'p1', name: 'Apollo', folderPath: '/w', cliId: 'claude-code' }],
        'cli.detectAll': [{ id: 'claude-code', installed: true }],
        'relay.board': async () => board,
        'relay.revise': async () => ({
          ok: true,
          proposal: PROPOSAL,
          entries: ENTRIES,
          cliName: 'Claude Code',
        }),
        'relay.applyProposal': async () => ({
          written: ['T020-archived-search.md', 'T004-search.md'],
          removed: ['T009-old.md'],
          warnings: ['T001 is done, so it was not changed.'],
        }),
        ...overrides,
      },
    },
  );
  return { ...view, onOpenChange };
}

async function review(user: ReturnType<typeof open>['user']): Promise<void> {
  const button = await screen.findByRole('button', { name: 'Review tasks' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

beforeEach(() => {
  useRelayPlannerStore.setState({ choice: null });
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('ReviseWithAiDialog', () => {
  it('says the docs lead and done tasks stay as they are', async () => {
    open();
    expect(await screen.findByText(/planning\//)).toBeInTheDocument();
    expect(screen.getByText(/never changes a task that is done/i)).toBeInTheDocument();
  });

  it('asks for a revision with the note, the budget and the planner', async () => {
    const { user, bridge } = open();

    await user.type(
      screen.getByRole('textbox', { name: /What should change/ }),
      'Cover archived patients',
    );
    await review(user);

    await screen.findByRole('list', { name: 'Proposed changes' });
    expect(bridge.$fn('relay.revise')).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        note: 'Cover archived patients',
        budget: 400_000,
        cliId: 'claude-code',
        requestId: expect.stringMatching(/^relay-plan-/),
      }),
    );
  });

  it('applies what the user kept and says what changed', async () => {
    const { user, bridge, onOpenChange } = open();
    await review(user);
    await screen.findByRole('list', { name: 'Proposed changes' });

    await user.click(screen.getByRole('button', { name: 'Leave out T009' }));
    await user.click(screen.getByRole('button', { name: 'Apply 2 changes' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(bridge.$fn('relay.applyProposal')).toHaveBeenCalledWith('p1', {
      ...PROPOSAL,
      remove: [],
    });
    expect(toast.success).toHaveBeenCalledWith(
      'Board updated',
      expect.objectContaining({ description: '2 task files written, 1 removed.' }),
    );
    expect(toast.warning).toHaveBeenCalledWith('T001 is done, so it was not changed.');
  });

  it('says so when the tasks already match the docs', async () => {
    const { user } = open({
      'relay.revise': async () => ({
        ok: true,
        proposal: { summary: '', add: [], change: [], split: [], remove: [] },
        entries: [],
        cliName: 'Claude Code',
      }),
    });
    await review(user);

    expect(await screen.findByText('The tasks already match the docs.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Apply/ })).not.toBeInTheDocument();
  });

  it('explains a failed revision', async () => {
    const { user } = open({
      'relay.revise': async () => ({ ok: false, error: 'The planner timed out after 10 minutes.' }),
    });
    await review(user);

    expect(await screen.findByText('The planner timed out after 10 minutes.')).toBeInTheDocument();
  });

  describe('catching up a project in progress', () => {
    const CATCH_UP: RelayProposal = {
      summary: 'Login is built and search is half done.',
      add: [
        { title: 'Login', status: 'done', handoff: { done: 'src/auth.' } },
        { title: 'Search', estimate: 80_000, handoff: { done: 'The API.', next: 'The page.' } },
        { title: 'Export', estimate: 60_000 },
      ],
      change: [],
      split: [],
      remove: [],
    };
    const CATCH_UP_ENTRIES: ProposalEntry[] = [
      { kind: 'add', id: 'T001', title: 'Login', fields: [], status: 'done', handoff: true },
      { kind: 'add', id: 'T002', title: 'Search', fields: [], handoff: true },
      { kind: 'add', id: 'T003', title: 'Export', fields: [] },
    ];

    function catchUp(onOpenChange = vi.fn()) {
      const view = renderWithProviders(
        <ReviseWithAiDialog projectId="p1" mode="catch-up" open onOpenChange={onOpenChange} />,
        {
          bridge: {
            'projects.list': [{ id: 'p1', name: 'Apollo', folderPath: '/w', cliId: 'claude-code' }],
            'cli.detectAll': [{ id: 'claude-code', installed: true }],
            'relay.board': async () => board,
            'relay.catchUp': async () => ({
              ok: true,
              proposal: CATCH_UP,
              entries: CATCH_UP_ENTRIES,
              cliName: 'Claude Code',
            }),
            'relay.applyProposal': async () => ({
              written: ['T001-login.md', 'T002-search.md', 'T003-export.md'],
              removed: [],
              warnings: [],
            }),
          },
        },
      );
      return { ...view, onOpenChange };
    }

    it('reads the code and history, with or without the finished work on the board', async () => {
      const { user, bridge } = catchUp();
      expect(
        await screen.findByRole('heading', { name: 'Pick up a project in progress' }),
      ).toBeInTheDocument();
      const recordDone = screen.getByRole('switch', { name: /Put finished work on the board/ });
      expect(recordDone).toBeChecked();
      await user.click(recordDone);
      await user.type(
        screen.getByRole('textbox', { name: /Anything it should know/ }),
        'The plan is in docs/ROADMAP.md',
      );
      const plan = screen.getByRole('button', { name: 'Plan the rest' });
      await waitFor(() => expect(plan).toBeEnabled());
      await user.click(plan);

      await screen.findByRole('list', { name: 'Proposed changes' });
      expect(bridge.$fn('relay.catchUp')).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'p1',
          recordDone: false,
          note: 'The plan is in docs/ROADMAP.md',
          budget: 400_000,
        }),
      );
    });

    it('shows where the project stands, then puts it on the board', async () => {
      const { user, bridge, onOpenChange } = catchUp();
      const plan = await screen.findByRole('button', { name: 'Plan the rest' });
      await waitFor(() => expect(plan).toBeEnabled());
      await user.click(plan);

      const standing = await screen.findByRole('img', { name: 'Where the project stands' });
      expect(standing).toHaveAccessibleDescription('1 finished, 1 half done, 1 to do');
      await user.click(screen.getByRole('button', { name: 'Apply 3 changes' }));

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(bridge.$fn('relay.applyProposal')).toHaveBeenCalledWith('p1', CATCH_UP);
      expect(toast.success).toHaveBeenCalledWith(
        'Board updated',
        expect.objectContaining({
          description: '3 task files written.',
          action: expect.objectContaining({ label: 'Open the board' }),
        }),
      );
    });
  });

  it('stops a revision that is still running', async () => {
    const { user, bridge } = open({ 'relay.revise': () => new Promise(() => undefined) });
    await review(user);

    await user.click(await screen.findByRole('button', { name: 'Cancel planning' }));
    expect(bridge.$fn('relay.cancelPlanner')).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Review tasks' })).toBeInTheDocument();
  });
});
