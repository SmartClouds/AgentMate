import type { ScheduledTask } from '@runova/core';
import { IPC } from '../../shared/ipcChannels';
import { updateScheduledTask } from '../ipc/scheduledTasks';
import { broadcastToWindows, sendToWindow } from '../ipc/send';
import { getMainWindow } from '../mainWindow';
import { store } from '../store';

const POLL_MS = 30 * 1000;

/**
 * How late an automatic task can be and still fire. Past this it was due while the app was
 * closed (or the machine asleep), and opening a CLI hours late would be a surprise, so it is
 * marked missed and waits for Run now instead.
 */
export const MISSED_GRACE_MS = 2 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;

function isWaitingAuto(task: ScheduledTask): boolean {
  return task.status === 'pending' && task.runMode === 'auto';
}

function runAtMs(task: ScheduledTask): number {
  return new Date(task.runAt).getTime();
}

/** Automatic tasks whose time has come and that are still within the grace window. */
export function dueTasks(tasks: ScheduledTask[], now: Date): ScheduledTask[] {
  const nowMs = now.getTime();
  return tasks.filter((task) => {
    if (!isWaitingAuto(task)) return false;
    const at = runAtMs(task);
    return Number.isFinite(at) && at <= nowMs && nowMs - at <= MISSED_GRACE_MS;
  });
}

/** Automatic tasks that are too far past their time to fire now. */
export function missedTasks(tasks: ScheduledTask[], now: Date): ScheduledTask[] {
  const nowMs = now.getTime();
  return tasks.filter((task) => {
    if (!isWaitingAuto(task)) return false;
    const at = runAtMs(task);
    return Number.isFinite(at) && nowMs - at > MISSED_GRACE_MS;
  });
}

/**
 * One pass of the scheduler. Each due task is marked completed before the renderer is told,
 * so a reload or a second tick can never open it twice. A window that is gone or still loading
 * has no listener, so due tasks wait for the next tick rather than being fired into nothing.
 */
export async function runScheduledTaskTick(now: Date = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const tasks = await store.getScheduledTasks();
    let changed = false;

    for (const task of missedTasks(tasks, now)) {
      await updateScheduledTask(task.id, { status: 'missed' });
      changed = true;
    }

    const due = dueTasks(tasks, now);
    const win = getMainWindow();
    if (due.length > 0 && win && !win.webContents.isLoading()) {
      for (const task of due) {
        const fired = await updateScheduledTask(task.id, {
          status: 'completed',
          ranAt: now.toISOString(),
        });
        if (fired) sendToWindow(win, IPC.scheduledTasks.onDue, fired);
        changed = true;
      }
    }

    if (changed) broadcastToWindows(IPC.scheduledTasks.onChanged);
  } finally {
    ticking = false;
  }
}

export function startScheduledTaskRunner(): void {
  if (timer) return;
  void runScheduledTaskTick();
  timer = setInterval(() => void runScheduledTaskTick(), POLL_MS);
}

export function stopScheduledTaskRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
