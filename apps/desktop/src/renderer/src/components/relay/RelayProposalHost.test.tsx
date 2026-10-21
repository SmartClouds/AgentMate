import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RelayProposalHost } from './RelayProposalHost';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

function proposal(id: string, fromTaskId: string | null, adds = 2) {
  const add = Array.from({ length: adds }, (_, index) => ({
    id: `T02${index}`,
    title: `Follow-up ${index + 1}`,
    estimate: 40_000,
  }));
  return {
    id,
    projectId: 'p1',
    projectName: 'Apollo',
    fromTaskId,
    proposal: { summary: 'Found while testing.', add, change: [], split: [], remove: [] },
    entries: add.map((task) => ({ kind: 'add', id: task.id, title: task.title, fields: [] })),
    receivedAt: 1,
  };
}

function renderHost(
  pending: unknown[],
  decide: unknown = async () => ({
    written: ['T020-a.md', 'T021-b.md'],
    removed: [],
    warnings: [],
  }),
) {
  const view = renderWithProviders(<RelayProposalHost />, {
    bridge: {
      'relay.pendingProposals': async () => pending,
      'relay.decideProposal': decide,
    },
  });
  const announce = (next: unknown) =>
    act(() => {
      view.bridge.$emit('relay.onProposal', next);
    });
  return { ...view, announce };
}

beforeEach(() => {
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('RelayProposalHost', () => {
  it('shows nothing while no proposal waits', async () => {
    const { bridge } = renderHost([]);
    await waitFor(() => expect(bridge.$fn('relay.pendingProposals')).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the session that proposed the tasks and shows them', async () => {
    renderHost([proposal('m1', 'T004')]);

    const dialog = await screen.findByRole('dialog', {
      name: "T004's session proposes 2 new tasks",
    });
    expect(within(dialog).getByText('Follow-up 1')).toBeInTheDocument();
    expect(within(dialog).getByText(/Apollo/)).toBeInTheDocument();
  });

  it('adds the tasks when the user approves', async () => {
    const { user, bridge } = renderHost([proposal('m1', 'T004')]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Add to board' }));

    expect(bridge.$fn('relay.decideProposal')).toHaveBeenCalledWith('m1', true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(
      'Added to Apollo’s board',
      expect.objectContaining({ description: '2 task files written.' }),
    );
  });

  it('drops the proposal when the user declines, then shows the next one', async () => {
    const { user, bridge } = renderHost([proposal('m1', 'T004'), proposal('m2', null, 1)]);
    const first = await screen.findByRole('dialog');
    expect(within(first).getByText('1 of 2 proposals')).toBeInTheDocument();

    await user.click(within(first).getByRole('button', { name: 'Decline' }));

    expect(bridge.$fn('relay.decideProposal')).toHaveBeenCalledWith('m1', false);
    expect(
      await screen.findByRole('dialog', { name: 'An agent in Apollo proposes 1 new task' }),
    ).toBeInTheDocument();
  });

  it('picks up a proposal that arrives while the app is open', async () => {
    const { announce } = renderHost([]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    announce(proposal('m3', 'T007'));

    expect(
      await screen.findByRole('dialog', { name: "T007's session proposes 2 new tasks" }),
    ).toBeInTheDocument();
  });

  it('says so when the board could not take the proposal', async () => {
    const { user } = renderHost([proposal('m1', 'T004')], async () => {
      throw new Error('The tasks folder is read-only.');
    });
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Add to board' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not add the proposed tasks',
        expect.objectContaining({ description: 'The tasks folder is read-only.' }),
      ),
    );
  });
});
