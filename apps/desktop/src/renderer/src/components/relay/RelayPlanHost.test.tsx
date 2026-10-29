import type { ProposalEntry, RelayProposal } from '@runova/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRelayPlanDialogStore } from '@/stores/relayPlanDialogStore';
import { planJobKey, useRelayPlanJobsStore } from '@/stores/relayPlanJobsStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RelayPlanHost } from './RelayPlanHost';
import { useRelayPlannerStore } from './RelayPlannerPicker';
import { RelayPlanStatusSegment } from './RelayPlanStatusSegment';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
);
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

const project = { id: 'p1', name: 'Apollo', folderPath: '/work/apollo', cliId: 'claude-code' };
const board = {
  projectId: 'p1',
  docsFolder: 'docs',
  exists: true,
  guidePresent: true,
  tasks: [{ id: 'T001', title: 'Login', status: 'done' }],
  order: ['T001'],
  cycles: [],
  missing: [],
  issues: [],
  settings: {},
  active: null,
};

/** A planner call whose answer the test hands over when it chooses. */
function held() {
  const calls: ((value: unknown) => void)[] = [];
  const run = () =>
    new Promise((resolve) => {
      calls.push(resolve);
    });
  return { run, finish: (value: unknown) => calls.shift()?.(value) };
}

function render(overrides: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <RelayPlanHost />
      <RelayPlanStatusSegment />
    </>,
    {
      bridge: {
        'projects.list': [project],
        'cli.detectAll': [{ id: 'claude-code', installed: true }],
        'relay.board': async () => board,
        'relay.applyProposal': async () => ({
          written: ['T014-search-api.md'],
          removed: [],
          warnings: [],
        }),
        ...overrides,
      },
    },
  );
}

function showSplit(): void {
  act(() =>
    useRelayPlanDialogStore.getState().show({
      kind: 'split',
      projectId: 'p1',
      request: 'Add a patient search page',
    }),
  );
}

async function startPlanning(user: ReturnType<typeof render>['user']): Promise<void> {
  const button = await screen.findByRole('button', { name: 'Plan tasks' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await screen.findByText(/is reading the project/);
}

/** The footer's Close, which says the planner goes on; the corner X is named Close as well. */
function closeDialog(user: ReturnType<typeof render>['user']) {
  const [footerClose] = within(screen.getByRole('dialog')).getAllByRole('button', {
    name: 'Close',
  });
  return user.click(footerClose);
}

beforeEach(() => {
  useRelayPlannerStore.setState({ choice: null });
  toast.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('RelayPlanHost', () => {
  it('shows nothing until a page asks for a dialog', () => {
    render();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps planning after the dialog closes, and picks up where it was on reopening', async () => {
    const planner = held();
    const cancelPlanner = vi.fn();
    const { user } = render({
      'relay.decompose': planner.run,
      'relay.cancelPlanner': cancelPlanner,
    });
    showSplit();
    await startPlanning(user);

    await closeDialog(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cancelPlanner).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Planning keeps going in the background',
      expect.objectContaining({ description: expect.stringMatching(/notification/) }),
    );
    expect(useRelayPlanJobsStore.getState().jobs[planJobKey('split', 'p1')]?.status).toBe(
      'running',
    );

    // The status bar shows the run, and a click brings the dialog back on it.
    const segment = screen.getByRole('button', {
      name: 'Planning tasks for Apollo in the background',
    });
    expect(segment).toHaveTextContent(/Splitting 0:\d\d/);
    await user.click(segment);
    expect(await screen.findByText(/is reading the project/)).toBeInTheDocument();

    await act(async () => planner.finish(PLANNED));
    expect(await screen.findByRole('list', { name: 'Proposed changes' })).toBeInTheDocument();
    // The user was looking at it, so no toast.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('announces a plan that finished behind a closed dialog and reopens it from the toast', async () => {
    const planner = held();
    const { user } = render({ 'relay.decompose': planner.run });
    showSplit();
    await startPlanning(user);
    await closeDialog(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await act(async () => planner.finish(PLANNED));
    expect(toast.success).toHaveBeenCalledWith(
      'Tasks for Apollo are ready',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Review' }) }),
    );
    expect(
      screen.getByRole('button', { name: 'The plan for Apollo is ready to review' }),
    ).toHaveTextContent('Tasks ready');

    act(() => toast.success.mock.calls[0][1].action.onClick());
    expect(await screen.findByRole('list', { name: 'Proposed changes' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'What should the tasks deliver?' })).toHaveValue(
      'Add a patient search page',
    );
  });

  it('keeps the user’s edits to the proposal across a close and reopen', async () => {
    const { user } = render({ 'relay.decompose': async () => PLANNED });
    showSplit();
    const button = await screen.findByRole('button', { name: 'Plan tasks' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByRole('list', { name: 'Proposed changes' });
    await user.click(screen.getByRole('button', { name: 'Leave out T015' }));
    expect(screen.getByRole('button', { name: 'Add 1 task to board' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    showSplit();
    expect(await screen.findByRole('button', { name: 'Add 1 task to board' })).toBeInTheDocument();
  });

  it('discards a plan and goes back to the form', async () => {
    const { user } = render({ 'relay.decompose': async () => PLANNED });
    showSplit();
    const button = await screen.findByRole('button', { name: 'Plan tasks' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByRole('list', { name: 'Proposed changes' });

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('list', { name: 'Proposed changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plan tasks' })).toBeInTheDocument();
    expect(useRelayPlanJobsStore.getState().jobs[planJobKey('split', 'p1')]).toBeUndefined();
    expect(
      screen.queryByRole('button', { name: /ready to review|in the background/ }),
    ).not.toBeInTheDocument();
  });

  it('forgets the plan once its tasks are on the board', async () => {
    const { user } = render({ 'relay.decompose': async () => PLANNED });
    showSplit();
    const button = await screen.findByRole('button', { name: 'Plan tasks' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByRole('list', { name: 'Proposed changes' });

    await user.click(screen.getByRole('button', { name: 'Add 2 tasks to board' }));
    expect(await screen.findByText(/Added T014 to the board/)).toBeInTheDocument();
    expect(useRelayPlanJobsStore.getState().jobs[planJobKey('split', 'p1')]).toBeUndefined();
  });

  it('shows a failure from the background, and lets the user try again', async () => {
    const planner = held();
    const { user } = render({ 'relay.decompose': planner.run });
    showSplit();
    await startPlanning(user);
    await closeDialog(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await act(async () =>
      planner.finish({
        ok: false,
        error: 'Claude Code CLI was still working after 60 minutes and was stopped.',
      }),
    );
    expect(toast.error).toHaveBeenCalledWith('Planning for Apollo stopped', expect.anything());
    const segment = screen.getByRole('button', { name: /^Planning for Apollo stopped/ });
    expect(segment).toHaveTextContent('Planning failed');

    await user.click(segment);
    expect(
      await screen.findByText(
        'Claude Code CLI was still working after 60 minutes and was stopped.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plan tasks' })).toBeEnabled();
  });

  it('reopens the plan when its OS notification is clicked', async () => {
    const planner = held();
    const { user, bridge } = render({ 'relay.decompose': planner.run });
    showSplit();
    await startPlanning(user);
    const { requestId } = bridge.$fn('relay.decompose').mock.calls[0][0] as { requestId: string };
    await closeDialog(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await act(async () => planner.finish(PLANNED));

    act(() => bridge.$emit('relay.onPlannerOpen', 'relay-plan-unknown'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => bridge.$emit('relay.onPlannerOpen', requestId));
    expect(await screen.findByRole('list', { name: 'Proposed changes' })).toBeInTheDocument();
  });

  it('runs a catch-up in the background the same way', async () => {
    const planner = held();
    const cancelPlanner = vi.fn();
    const { user, bridge } = render({
      'relay.catchUp': planner.run,
      'relay.cancelPlanner': cancelPlanner,
    });
    act(() => useRelayPlanDialogStore.getState().show({ kind: 'catch-up', projectId: 'p1' }));
    expect(
      await screen.findByRole('heading', { name: 'Pick up a project in progress' }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole('textbox', { name: 'Anything it should know? (optional)' }),
      'Skip the admin pages.',
    );
    const button = screen.getByRole('button', { name: 'Plan the rest' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByText(/is reading the code/);

    await closeDialog(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cancelPlanner).not.toHaveBeenCalled();
    await act(async () => planner.finish(PLANNED));
    expect(toast.success).toHaveBeenCalledWith('The rest of Apollo is planned', expect.anything());

    await user.click(
      screen.getByRole('button', { name: 'The plan for Apollo is ready to review' }),
    );
    expect(await screen.findByRole('list', { name: 'Proposed changes' })).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Anything it should know? (optional)' }),
    ).toHaveValue('Skip the admin pages.');
    expect(bridge.$fn('relay.catchUp')).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', note: 'Skip the admin pages.', recordDone: true }),
    );
  });

  it('still stops a planner when the user cancels it', async () => {
    const planner = held();
    const { user, bridge } = render({ 'relay.decompose': planner.run });
    showSplit();
    await startPlanning(user);
    await user.click(screen.getByRole('button', { name: 'Cancel planning' }));
    expect(bridge.$fn('relay.cancelPlanner')).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Plan tasks' })).toBeInTheDocument();
    await act(async () => planner.finish(PLANNED));
    expect(screen.queryByRole('list', { name: 'Proposed changes' })).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('RelayPlanStatusSegment', () => {
  it('counts the other plans and puts a ready one first', async () => {
    const first = held();
    const second = held();
    render({ 'relay.decompose': first.run, 'relay.revise': second.run });
    const { startPlanJob } = await import('@/stores/relayPlanJobsStore');
    const base = { projectId: 'p1', projectName: 'Apollo', text: '', budget: 200_000 };
    act(() => {
      void startPlanJob({ ...base, kind: 'split' }, () =>
        window.runova.relay.decompose({} as never),
      );
      void startPlanJob({ ...base, kind: 'revise' }, () => window.runova.relay.revise({} as never));
    });
    const running = screen.getByRole('button', { name: /in the background/ });
    expect(running).toHaveTextContent('+1');

    await act(async () => second.finish(PLANNED));
    const ready = screen.getByRole('button', { name: 'The plan for Apollo is ready to review' });
    expect(ready).toHaveTextContent('Tasks ready');
    expect(ready).toHaveTextContent('+1');
  });
});
