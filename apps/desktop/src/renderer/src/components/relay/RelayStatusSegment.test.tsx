import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RelayStatusSegment } from './RelayStatusSegment';
import { leg, run } from './testing/fixtures';
import { useRelayContextStore } from './useRelay';

const PROJECTS = [
  { id: 'p1', name: 'CuraLink' },
  { id: 'p2', name: 'Runova' },
];

function live() {
  return run({
    queue: ['T004', 'T005'],
    finished: [
      { taskId: 'T001', result: 'done', at: 0 },
      { taskId: 'T002', result: 'done', at: 0 },
    ],
    current: leg({ taskId: 'T003', tabId: 'tab-3' }),
  });
}

beforeEach(() => {
  useRelayBoardStore.setState({ projectId: null, focusTaskId: null });
  useRelayContextStore.setState({ byTab: {} });
});

describe('RelayStatusSegment', () => {
  it('stays out of the bar while no relay is live', async () => {
    const { bridge } = renderWithProviders(<RelayStatusSegment />, {
      bridge: { 'projects.list': PROJECTS, 'relay.runs': [run({ status: 'done' })] },
    });
    await waitForRuns(bridge);
    expect(screen.queryByRole('button', { name: /Relay/ })).toBeNull();
  });

  it('shows the live relay with its task, progress and context, and opens its board', async () => {
    useRelayContextStore.setState({
      byTab: {
        'tab-3': {
          projectId: 'p1',
          tabId: 'tab-3',
          taskId: 'T003',
          tokens: 128_000,
          budget: 200_000,
          guardAt: 160_000,
        },
      },
    });
    const { user } = renderWithProviders(<RelayStatusSegment />, {
      bridge: {
        'projects.list': PROJECTS,
        'relay.runs': (projectId: string) => (projectId === 'p1' ? [live()] : []),
      },
    });
    const segment = await screen.findByRole('button', { name: /Relay/ });
    expect(segment).toHaveTextContent('T003');
    expect(segment).toHaveTextContent('2/5');
    expect(segment).toHaveTextContent('64%');
    await user.click(segment);
    expect(useRelayBoardStore.getState().projectId).toBe('p1');
  });

  it('appears when a relay starts and leaves when it ends', async () => {
    const { bridge } = renderWithProviders(<RelayStatusSegment />, {
      bridge: { 'projects.list': PROJECTS, 'relay.runs': [] },
    });
    await waitForRuns(bridge);
    act(() => bridge.$emit('relay.onRun', live()));
    expect(await screen.findByRole('button', { name: /Relay/ })).toBeInTheDocument();
    act(() => bridge.$emit('relay.onRun', run({ status: 'cancelled' })));
    expect(screen.queryByRole('button', { name: /Relay/ })).toBeNull();
  });

  it('says a scheduled relay is waiting', async () => {
    const { bridge } = renderWithProviders(<RelayStatusSegment />, {
      bridge: { 'projects.list': PROJECTS, 'relay.runs': [] },
    });
    await waitForRuns(bridge);
    act(() =>
      bridge.$emit(
        'relay.onRun',
        run({ status: 'waiting', triggerText: 'Starts when T004 is done' }),
      ),
    );
    expect(await screen.findByRole('button', { name: /Relay/ })).toHaveTextContent('Scheduled');
  });
});

async function waitForRuns(bridge: { $fn: (path: string) => { mock: { calls: unknown[] } } }) {
  await waitFor(() => expect(bridge.$fn('relay.runs').mock.calls.length).toBeGreaterThan(0));
}
