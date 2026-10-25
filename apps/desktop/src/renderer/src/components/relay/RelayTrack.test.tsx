import type { Project } from '@agentmat/core';
import { act, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RelayTrack } from './RelayTrack';
import { board, card, leg, run } from './testing/fixtures';
import { useRelayContextStore } from './useRelay';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const project = {
  id: 'p1',
  name: 'CuraLink',
  folderPath: 'E:/work/curalink',
  cliId: 'claude-code',
} as unknown as Project;

const tasks = [
  card('T001', { status: 'done', estimate: 40_000 }),
  card('T002', { status: 'in-progress', estimate: 90_000, legCount: 2 }),
  card('T003', { estimate: 130_000 }),
  card('T004', {
    status: 'blocked',
    handoff: {
      outcome: 'blocked',
      tests: null,
      leg: 1,
      updated: null,
      missingSections: [],
      next: 'Postgres or SQLite?',
    },
  }),
];

function live() {
  return run({
    queue: ['T003'],
    current: leg({ taskId: 'T002', legNo: 2, contextTokens: 64_000 }),
  });
}

beforeEach(() => {
  useRelayBoardStore.setState({ projectId: null, focusTaskId: null });
  useRelayContextStore.setState({ byTab: {} });
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
});

describe('RelayTrack', () => {
  it('lays the tasks out as stations in run order, saying what each one is doing', async () => {
    renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks, active: live() }) },
    });
    const track = await screen.findByRole('list', { name: 'Relay track' });
    const stations = within(track).getAllByRole('listitem');
    expect(stations.map((station) => station.getAttribute('aria-label'))).toEqual([
      'T001 Task T001, Done',
      'T002 Task T002, Running now',
      'T003 Task T003, Up next in the relay',
      'T004 Task T004, Blocked',
    ]);
    expect(within(stations[3]).getByText('Postgres or SQLite?')).toBeInTheDocument();
    expect(screen.getByText('1 of 4 done')).toBeInTheDocument();
  });

  it('fills the running station’s ring from live context readings', async () => {
    const { bridge } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks, active: live() }) },
    });
    const track = await screen.findByRole('list', { name: 'Relay track' });
    const meter = within(track).getByRole('meter', { name: 'Context used' });
    expect(meter).toHaveAttribute('aria-valuenow', '64000');
    act(() =>
      bridge.$emit('relay.onContext', {
        projectId: 'p1',
        tabId: 'tab-1',
        taskId: 'T002',
        tokens: 170_000,
        budget: 200_000,
        guardAt: 160_000,
      }),
    );
    expect(meter).toHaveAttribute('aria-valuenow', '170000');
    expect(meter).toHaveAttribute('data-level', 'hot');
  });

  it('watches the folder while it is on screen and refreshes when main says the files changed', async () => {
    const { bridge, unmount } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks }) },
    });
    await screen.findByRole('list', { name: 'Relay track' });
    expect(bridge.$fn('relay.watch')).toHaveBeenCalledWith('p1');
    bridge.$set('relay.board', board({ tasks: [...tasks, card('T005')] }));
    act(() => bridge.$emit('relay.onChanged', { projectId: 'p1', reason: 'files' }));
    expect(await screen.findByRole('listitem', { name: /T005/ })).toBeInTheDocument();
    unmount();
    expect(bridge.$fn('relay.unwatch')).toHaveBeenCalledWith('p1');
  });

  it('follows the relay as main reports it', async () => {
    const { bridge } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks }) },
    });
    expect(await screen.findByRole('button', { name: 'Run relay' })).toBeInTheDocument();
    act(() => bridge.$emit('relay.onRun', live()));
    expect(await screen.findByRole('region', { name: 'Relay in progress' })).toBeInTheDocument();
    expect(screen.getByText(/T002 · Working/)).toBeInTheDocument();
    act(() => bridge.$emit('relay.onRun', run({ status: 'done' })));
    expect(await screen.findByRole('button', { name: 'Run relay' })).toBeInTheDocument();
  });

  it('runs one task in a new session with its prompt left for the user to send', async () => {
    const { user, bridge } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: {
        'relay.board': board({ tasks }),
        'relay.prepareRun': {
          prompt: 'AgentMate Relay: task T003',
          choice: { cliId: 'claude-code', model: 'opus', effort: 'high', autoSize: false },
          planFirst: false,
          legNo: 1,
        },
        'cli.list': [],
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Run T003 in a new session' }));
    expect(bridge.$fn('relay.prepareRun')).toHaveBeenCalledWith('p1', 'T003');
    const tab = Object.values(useWorkspaceStore.getState().workspaces.p1.tabs)[0];
    expect(tab).toMatchObject({
      kind: 'terminal',
      cliId: 'claude-code',
      runLabel: 'T003 · Opus 5.5 · High',
    });
  });

  it('starts the relay from a chosen task', async () => {
    const { user, bridge } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks }), 'relay.start': { ok: true, run: live() } },
    });
    await user.click(await screen.findByRole('button', { name: 'More for T003' }));
    await user.click(await screen.findByRole('menuitem', { name: /Run the relay from here/ }));
    expect(bridge.$fn('relay.start')).toHaveBeenCalledWith({
      projectId: 'p1',
      from: 'T003',
      trigger: { kind: 'now' },
    });
  });

  it('opens the board on a task', async () => {
    const { user } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks }) },
    });
    await user.click(await screen.findByRole('button', { name: /T003\s*Task T003/ }));
    expect(useRelayBoardStore.getState()).toMatchObject({ projectId: 'p1', focusTaskId: 'T003' });
  });

  it('explains the format and offers to start a board when there are no tasks', async () => {
    const { user, bridge } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks: [], exists: false, guidePresent: false }) },
    });
    expect(await screen.findByText('No tasks yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start a board' }));
    expect(bridge.$fn('relay.ensureGuide')).toHaveBeenCalledWith('p1', 'docs');
  });

  it('offers to plan the rest of a project that is already under way', async () => {
    const { user } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: {
        'relay.board': board({ tasks: [], exists: false, guidePresent: false }),
        'projects.list': [project],
        'cli.detectAll': [{ id: 'claude-code', installed: true }],
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Plan the rest with AI' }));
    expect(
      await screen.findByRole('heading', { name: 'Pick up a project in progress' }),
    ).toBeInTheDocument();
  });

  it('pauses a live relay and stops it after asking', async () => {
    const { user, bridge } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks, active: live() }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Pause the relay' }));
    expect(bridge.$fn('relay.pause')).toHaveBeenCalledWith('r1');
  });

  /** Hovers a finished station's "Done ~estimate" and gives back its tooltip. */
  async function doneTooltip(task: ReturnType<typeof card>, text: string) {
    const { user } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks: [task] }) },
    });
    const track = await screen.findByRole('list', { name: 'Relay track' });
    await user.hover(within(track).getByText(text));
    return screen.findByRole('tooltip');
  }

  it('shows a finished task’s tokens used against its estimate on hover', async () => {
    const tip = await doneTooltip(
      card('T001', { status: 'done', estimate: 60_000, legCount: 1, legPeaks: [52_000] }),
      '~60K',
    );
    expect(tip).toHaveTextContent('Tokens used1 session');
    expect(tip).toHaveTextContent('52Kof ~60K estimated');
    expect(tip).toHaveTextContent('8K under the estimate (13%)');
    expect(tip).not.toHaveTextContent('Session 1');
  });

  it('adds up a task’s sessions and lists them when it took more than one', async () => {
    const tip = await doneTooltip(
      card('T001', { status: 'done', estimate: 100_000, legCount: 3, legPeaks: [90_000, 40_000] }),
      '~100K',
    );
    expect(tip).toHaveTextContent('Tokens used2 sessions');
    expect(tip).toHaveTextContent('130Kof ~100K estimated');
    expect(tip).toHaveTextContent('30K over the estimate (30%)');
    expect(tip).toHaveTextContent('Session 190KSession 240K');
    expect(tip).toHaveTextContent('1 more session left no reading.');
  });

  it('says why a finished task has no count to compare', async () => {
    const tip = await doneTooltip(card('T001', { status: 'done', estimate: 80_000 }), '~80K');
    expect(tip).toHaveTextContent(/Finished outside a Relay session/);
  });

  it('never uses the native title attribute', async () => {
    const { container } = renderWithProviders(<RelayTrack project={project} />, {
      bridge: { 'relay.board': board({ tasks, active: live() }) },
    });
    await screen.findByRole('list', { name: 'Relay track' });
    expect(container.querySelector('[title]')).toBeNull();
  });
});
