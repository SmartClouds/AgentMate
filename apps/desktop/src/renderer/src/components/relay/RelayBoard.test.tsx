import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RelayBoardHost } from './RelayBoard';
import { CARD_DRAG_TYPE } from './RelayTaskCard';
import { board, card, leg, run } from './testing/fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const tasks = [
  card('T001', { status: 'done', epic: 'E01' }),
  card('T002', { epic: 'E01', estimate: 150_000 }),
  card('T003', { epic: 'E02' }),
  card('T004', {
    status: 'testing',
    handoff: {
      outcome: 'done',
      tests: 'failed',
      leg: 1,
      updated: null,
      missingSections: [],
      next: 'Fix the failing export test.',
    },
  }),
];

const detail = {
  task: { ...tasks[1], body: '## Goal\n\nCards move between columns.' },
  handoff: {
    taskId: 'T002',
    outcome: 'continue',
    tests: 'not-run',
    leg: 2,
    updated: null,
    sections: {
      purpose: 'Make cards draggable.',
      done: 'Column drop targets.',
      decisions: 'Native drag, no new dependency.',
      rejected: '',
      next: 'Wire Alt+Arrow.',
    },
    missingSections: ['rejected'],
    issues: [],
  },
  handoffText: '',
  legs: [
    {
      legId: 'l1',
      relayId: 'r1',
      taskId: 'T002',
      legNo: 1,
      cliId: 'claude-code',
      model: 'opus',
      effort: 'high',
      tabId: 't',
      startedAt: 0,
      endedAt: 125_000,
      outcome: 'continue',
      tests: 'not-run',
      result: 'continue',
      peakContextTokens: 158_000,
    },
  ],
};

function open(overrides: Record<string, unknown> = {}) {
  useRelayBoardStore.getState().open('p1');
  return renderWithProviders(<RelayBoardHost />, {
    bridge: {
      'relay.board': board({ tasks }),
      'projects.list': [{ id: 'p1', name: 'CuraLink', folderPath: 'E:/c' }],
      'relay.task': detail,
      ...overrides,
    },
  });
}

function column(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

function fakeTransfer(id?: string) {
  const data = new Map<string, string>(id ? [[CARD_DRAG_TYPE, id]] : []);
  return {
    types: [CARD_DRAG_TYPE],
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => data.set(type, value),
    effectAllowed: 'all',
    dropEffect: 'none',
  };
}

beforeEach(() => {
  useRelayBoardStore.setState({ projectId: null, focusTaskId: null });
});

describe('RelayBoardHost', () => {
  it('shows nothing until a board is opened', () => {
    renderWithProviders(<RelayBoardHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lays the tasks out in five columns under the project name', async () => {
    open();
    const dialog = await screen.findByRole('dialog', { name: 'CuraLink' });
    expect(
      await within(dialog).findByRole('article', { name: 'T002 Task T002' }),
    ).toBeInTheDocument();
    expect(
      within(column('To do'))
        .getAllByRole('article')
        .map((el) => el.dataset.card),
    ).toEqual(['T002', 'T003']);
    expect(
      within(column('Done')).getByRole('article', { name: 'T001 Task T001' }),
    ).toBeInTheDocument();
    expect(within(column('Testing')).getByText('Fix the failing export test.')).toBeInTheDocument();
    expect(within(column('Testing')).getByLabelText('Tests fail')).toBeInTheDocument();
    expect(within(column('Blocked')).queryAllByRole('article')).toEqual([]);
  });

  it('catches up with the code, from the toolbar and from an empty board', async () => {
    const { user } = open({ 'relay.board': board({ tasks: [] }) });
    await user.click(await screen.findByRole('button', { name: 'Plan the rest with AI' }));
    expect(
      await screen.findByRole('heading', { name: 'Pick up a project in progress' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Catch up' }));
    expect(
      await screen.findByRole('heading', { name: 'Pick up a project in progress' }),
    ).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const { user } = open();
    await screen.findByRole('dialog', { name: 'CuraLink' });
    await user.keyboard('{Escape}');
    expect(useRelayBoardStore.getState().projectId).toBeNull();
  });

  it('moves a card to the next column with Alt+Right, at once and then on disk', async () => {
    // The write stays pending, so what shows is the move made before main answers.
    const { user, bridge } = open({ 'relay.setStatus': () => new Promise(() => undefined) });
    const cardButton = within(
      await screen.findByRole('article', { name: 'T003 Task T003' }),
    ).getByRole('button');
    cardButton.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(
      within(column('In progress')).getByRole('article', { name: 'T003 Task T003' }),
    ).toBeInTheDocument();
    expect(bridge.$fn('relay.setStatus')).toHaveBeenCalledWith('p1', 'T003', 'in-progress');
  });

  it('reorders a card inside its column with Alt+Up', async () => {
    const { user, bridge } = open({ 'relay.reorder': () => new Promise(() => undefined) });
    const cardButton = within(
      await screen.findByRole('article', { name: 'T003 Task T003' }),
    ).getByRole('button');
    cardButton.focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(bridge.$fn('relay.reorder')).toHaveBeenCalledWith('p1', ['T003', 'T002']);
    expect(
      within(column('To do'))
        .getAllByRole('article')
        .map((el) => el.dataset.card),
    ).toEqual(['T003', 'T002']);
  });

  it('drops a dragged card into another column', async () => {
    const { bridge } = open();
    const dragged = await screen.findByRole('article', { name: 'T002 Task T002' });
    const transfer = fakeTransfer();
    fireEvent.dragStart(dragged, { dataTransfer: transfer });
    fireEvent.dragOver(column('Blocked'), { dataTransfer: transfer });
    fireEvent.drop(column('Blocked'), { dataTransfer: transfer });
    expect(bridge.$fn('relay.setStatus')).toHaveBeenCalledWith('p1', 'T002', 'blocked');
  });

  it('drops a card before another to set its place', async () => {
    const { bridge } = open();
    const target = await screen.findByRole('article', { name: 'T002 Task T002' });
    fireEvent.drop(target, { dataTransfer: fakeTransfer('T004') });
    await waitFor(() =>
      expect(bridge.$fn('relay.setStatus')).toHaveBeenCalledWith('p1', 'T004', 'todo'),
    );
    expect(bridge.$fn('relay.reorder')).toHaveBeenCalledWith('p1', ['T004', 'T002', 'T003']);
  });

  it('opens a card to show its baton, its sessions and its spec', async () => {
    const { user, bridge } = open();
    await user.click(
      within(await screen.findByRole('article', { name: 'T002 Task T002' })).getByRole('button'),
    );
    const sheet = await screen.findByRole('complementary', { name: 'T002 details' });
    const baton = await within(sheet).findByRole('region', { name: 'Baton' });
    expect(within(baton).getByText('Make cards draggable.')).toBeInTheDocument();
    expect(within(baton).getByText('Not written yet.')).toBeInTheDocument();
    expect(within(sheet).getByText(/Session 1/)).toBeInTheDocument();
    expect(within(sheet).getByText(/peak 158K/)).toBeInTheDocument();
    expect(within(sheet).getByText('Cards move between columns.')).toBeInTheDocument();
    expect(bridge.$fn('relay.task')).toHaveBeenCalledWith('p1', 'T002');

    await user.click(within(sheet).getByRole('button', { name: 'Move to' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Blocked' }));
    expect(bridge.$fn('relay.setStatus')).toHaveBeenCalledWith('p1', 'T002', 'blocked');
  });

  it('opens straight on the task it was asked to focus', async () => {
    useRelayBoardStore.getState().open('p1', 'T002');
    renderWithProviders(<RelayBoardHost />, {
      bridge: { 'relay.board': board({ tasks }), 'relay.task': detail, 'projects.list': [] },
    });
    expect(await screen.findByRole('complementary', { name: 'T002 details' })).toBeInTheDocument();
  });

  it('filters the cards by epic', async () => {
    const { user } = open();
    await screen.findByRole('article', { name: 'T002 Task T002' });
    await user.click(screen.getByRole('button', { name: 'E02' }));
    expect(screen.queryByRole('article', { name: 'T002 Task T002' })).toBeNull();
    expect(screen.getByRole('article', { name: 'T003 Task T003' })).toBeInTheDocument();
  });

  it('shows the live leg on its card, and the relay controls in place of Run', async () => {
    open({
      'relay.board': board({
        tasks,
        active: run({ current: leg({ taskId: 'T002', contextTokens: 90_000 }) }),
      }),
    });
    const live = await screen.findByRole('article', { name: 'T002 Task T002' });
    expect(within(live).getByRole('meter', { name: 'Context used' })).toHaveAttribute(
      'aria-valuenow',
      '90000',
    );
    expect(screen.getByRole('region', { name: 'Relay in progress' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run relay' })).toBeNull();
  });

  it('shows a done card’s tokens used against its estimate on hover', async () => {
    const { user } = open({
      'relay.board': board({
        tasks: [
          card('T001', { status: 'done', estimate: 60_000, legCount: 1, legPeaks: [66_000] }),
        ],
      }),
    });
    await user.hover(await screen.findByRole('img', { name: 'Estimate 60K of 200K' }));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('66Kof ~60K estimated');
    expect(tip).toHaveTextContent('6K over the estimate (10%)');
  });

  it('never uses the native title attribute', async () => {
    open();
    const dialog = await screen.findByRole('dialog', { name: 'CuraLink' });
    await within(dialog).findByRole('article', { name: 'T002 Task T002' });
    expect(dialog.querySelector('[title]')).toBeNull();
  });
});
