import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { RelayPlannerResult } from '../../shared/relayTypes';

const deps = vi.hoisted(() => ({
  show: vi.fn(
    (_input: { title: string; body: string; route: string; onClick?: () => void }) => true,
  ),
  focused: { value: false },
  focus: vi.fn(),
  broadcast: vi.fn(),
  project: vi.fn(async (_id: string): Promise<{ name: string } | null> => ({ name: 'Apollo' })),
}));

vi.mock('../notifications/osNotification', () => ({ showOsNotification: deps.show }));
vi.mock('../mainWindow', () => ({
  getMainWindow: () => ({ isFocused: () => deps.focused.value }),
  focusMainWindow: deps.focus,
}));
vi.mock('../ipc/send', () => ({ broadcastToWindows: deps.broadcast }));
vi.mock('../worktrees/resolve', () => ({ findProjectScope: deps.project }));

const { announcePlannerResult } = await import('./plannerNotice');

const INPUT = { requestId: 'relay-plan-1', projectId: 'p1' };
const PLANNED: RelayPlannerResult = {
  ok: true,
  proposal: {
    summary: 'Two tasks.',
    add: [
      { id: 'T014', title: 'Search API' },
      { id: 'T015', title: 'Search UI' },
    ],
    change: [],
    split: [],
    remove: [],
  },
  entries: [
    { kind: 'add', id: 'T014', title: 'Search API', fields: [] },
    { kind: 'add', id: 'T015', title: 'Search UI', fields: [] },
  ],
  cliName: 'Claude Code',
};

beforeEach(() => {
  deps.show.mockClear();
  deps.focus.mockClear();
  deps.broadcast.mockClear();
  deps.project.mockClear();
  deps.focused.value = false;
});

describe('announcePlannerResult', () => {
  it('says the tasks are ready when the user is in another app', async () => {
    await announcePlannerResult('split', INPUT, PLANNED);
    expect(deps.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Tasks are ready to review',
        body: 'Apollo: 2 tasks to look over.',
      }),
    );
  });

  it('brings the app forward and reopens the plan on a click', async () => {
    await announcePlannerResult('split', INPUT, PLANNED);
    deps.show.mock.calls[0][0].onClick?.();
    expect(deps.focus).toHaveBeenCalled();
    expect(deps.broadcast).toHaveBeenCalledWith(IPC.relay.onPlannerOpen, 'relay-plan-1');
  });

  it('counts changes for a revision and a catch-up', async () => {
    await announcePlannerResult('revise', INPUT, PLANNED);
    await announcePlannerResult('catch-up', INPUT, PLANNED);
    expect(deps.show.mock.calls.map(([call]) => [call.title, call.body])).toEqual([
      ['Board review is ready', 'Apollo: 2 changes to look over.'],
      ['The rest of the project is planned', 'Apollo: 2 changes to look over.'],
    ]);
  });

  it('passes on why a planner stopped', async () => {
    await announcePlannerResult('split', INPUT, {
      ok: false,
      error: 'Claude Code was still working after 60 minutes and was stopped.',
    });
    expect(deps.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Planning stopped',
        body: 'Apollo: Claude Code was still working after 60 minutes and was stopped.',
      }),
    );
  });

  it('leaves a focused window to the in-app toast', async () => {
    deps.focused.value = true;
    await announcePlannerResult('split', INPUT, PLANNED);
    expect(deps.show).not.toHaveBeenCalled();
  });

  it('says nothing about a run the user cancelled', async () => {
    await announcePlannerResult('split', INPUT, { ok: false, error: 'x', cancelled: true });
    expect(deps.show).not.toHaveBeenCalled();
  });

  it('still notifies when the project is gone', async () => {
    deps.project.mockResolvedValueOnce(null);
    await announcePlannerResult('split', INPUT, PLANNED);
    expect(deps.show).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Relay: 2 tasks to look over.' }),
    );
  });
});
