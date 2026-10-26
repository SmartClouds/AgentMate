import type { ScheduledTask } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { useTempUserData } from '../../test/main/ipcHarness';
import { dueTasks, MISSED_GRACE_MS, missedTasks } from './scheduler';

const window = vi.hoisted(() => ({
  current: null as null | {
    isDestroyed: () => boolean;
    webContents: {
      isDestroyed: () => boolean;
      isLoading: () => boolean;
      send: ReturnType<typeof vi.fn>;
    };
  },
}));

vi.mock('../mainWindow', () => ({ getMainWindow: () => window.current }));

const userData = useTempUserData();

function fakeWindow(loading = false) {
  const send = vi.fn();
  window.current = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, isLoading: () => loading, send },
  };
  return send;
}

async function tick(tasks: ScheduledTask[]): Promise<ScheduledTask[]> {
  userData.writeData('scheduled-tasks.json', tasks);
  const { runScheduledTaskTick } = await import('./scheduler');
  await runScheduledTaskTick(now);
  const { store } = await import('../store');
  return store.getScheduledTasks();
}

/**
 * An automatic task fires once, close to its time. One that came due while the app was closed
 * must not open a CLI hours late, so it is reported as missed instead. Manual tasks and tasks
 * already run or cancelled are never touched.
 */

const now = new Date('2026-09-23T12:00:00.000Z');

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 't',
    projectId: 'p1',
    rawInput: 'do it',
    promptType: 'Feature',
    targetAI: 'Claude Code',
    content: 'do it',
    runAt: now.toISOString(),
    status: 'pending',
    createdAt: '2026-09-20T00:00:00.000Z',
    runMode: 'auto',
    ...overrides,
  };
}

function ago(ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

describe('scheduled task timing', () => {
  it('fires an automatic task once its time has come', () => {
    const tasks = [
      task({ id: 'now', runAt: ago(0) }),
      task({ id: 'just-late', runAt: ago(MISSED_GRACE_MS) }),
      task({ id: 'future', runAt: ago(-60_000) }),
    ];
    expect(dueTasks(tasks, now).map((t) => t.id)).toEqual(['now', 'just-late']);
    expect(missedTasks(tasks, now)).toEqual([]);
  });

  it('marks a task missed when it is past the grace window', () => {
    const tasks = [task({ id: 'old', runAt: ago(MISSED_GRACE_MS + 1) })];
    expect(dueTasks(tasks, now)).toEqual([]);
    expect(missedTasks(tasks, now).map((t) => t.id)).toEqual(['old']);
  });

  it('leaves manual, old-format and finished tasks alone', () => {
    const tasks = [
      task({ id: 'manual', runMode: 'manual' }),
      task({ id: 'legacy', runMode: undefined, runAt: ago(MISSED_GRACE_MS * 10) }),
      task({ id: 'done', status: 'completed' }),
      task({ id: 'cancelled', status: 'cancelled' }),
      task({ id: 'missed', status: 'missed', runAt: ago(MISSED_GRACE_MS * 10) }),
      task({ id: 'bad-date', runAt: 'not a date' }),
    ];
    expect(dueTasks(tasks, now)).toEqual([]);
    expect(missedTasks(tasks, now)).toEqual([]);
  });
});

describe('scheduler tick', () => {
  it('marks a due task completed before telling the window to open it', async () => {
    const send = fakeWindow();

    const stored = await tick([task({ id: 'due', runAt: ago(1000) })]);

    expect(stored[0]).toMatchObject({ status: 'completed', ranAt: now.toISOString() });
    expect(send).toHaveBeenCalledWith(
      IPC.scheduledTasks.onDue,
      expect.objectContaining({ id: 'due' }),
    );
  });

  it('marks a long-overdue task missed without opening it', async () => {
    const send = fakeWindow();

    const stored = await tick([task({ id: 'old', runAt: ago(MISSED_GRACE_MS * 30) })]);

    expect(stored[0].status).toBe('missed');
    expect(send).not.toHaveBeenCalledWith(IPC.scheduledTasks.onDue, expect.anything());
  });

  it('leaves a due task waiting while the window is still loading', async () => {
    const send = fakeWindow(true);

    const stored = await tick([task({ id: 'due', runAt: ago(1000) })]);

    expect(stored[0].status).toBe('pending');
    expect(send).not.toHaveBeenCalled();
  });
});
