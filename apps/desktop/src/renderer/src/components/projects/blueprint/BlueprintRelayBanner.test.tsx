import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BlueprintRelayBanner } from './BlueprintRelayBanner';

function board(tasks: { id: string; status: string }[]) {
  return {
    projectId: 'p1',
    docsFolder: 'docs',
    exists: tasks.length > 0,
    guidePresent: true,
    tasks: tasks.map((task) => ({ ...task, title: task.id })),
    order: tasks.map((task) => task.id),
    cycles: [],
    missing: [],
    issues: [],
    settings: {},
    active: null,
  };
}

beforeEach(() => useRelayBoardStore.setState({ projectId: null, focusTaskId: null }));

describe('BlueprintRelayBanner', () => {
  it('says the tasks are ready and opens the board', async () => {
    const { user } = renderWithProviders(<BlueprintRelayBanner projectId="p1" />, {
      bridge: {
        'relay.board': async () =>
          board([
            { id: 'T001', status: 'done' },
            { id: 'T002', status: 'todo' },
            { id: 'T003', status: 'todo' },
          ]),
      },
    });

    expect(await screen.findByText('Tasks ready')).toBeInTheDocument();
    expect(screen.getByText('3 tasks on the Relay board, 1 done.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open board' }));
    expect(useRelayBoardStore.getState().projectId).toBe('p1');
  });

  it('stays hidden until the agent has written tasks', async () => {
    const { bridge } = renderWithProviders(<BlueprintRelayBanner projectId="p1" />, {
      bridge: { 'relay.board': async () => board([]) },
    });

    await waitFor(() => expect(bridge.$fn('relay.board')).toHaveBeenCalled());
    expect(screen.queryByText('Tasks ready')).not.toBeInTheDocument();
  });
});
