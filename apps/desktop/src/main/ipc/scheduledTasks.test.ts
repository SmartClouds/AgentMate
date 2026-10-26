import type { ScheduledTask } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Tasks carry how and where they run (manual or automatic, CLI, model, effort). Tasks saved
 * before those fields existed have none of them and must keep reading as manual.
 */

useTempUserData();
expectChannelsCovered(IPC.scheduledTasks, [IPC.scheduledTasks.onDue, IPC.scheduledTasks.onChanged]);

async function register(): Promise<void> {
  await loadIpc(
    () => import('./scheduledTasks'),
    (module) => module.registerScheduledTaskHandlers(),
  );
}

function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    rawInput: 'add login',
    promptType: 'Feature',
    targetAI: 'Claude Code',
    content: 'plan for add login',
    runAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

async function createOne(overrides: Record<string, unknown> = {}): Promise<ScheduledTask> {
  const [task] = await invoke<ScheduledTask[]>(IPC.scheduledTasks.createMany, {
    projectId: 'p1',
    tasks: [taskInput(overrides)],
  });
  return task;
}

beforeEach(async () => {
  await register();
});

describe('scheduled tasks', () => {
  it('saves run settings and defaults the run mode to manual', async () => {
    const auto = await createOne({
      runMode: 'auto',
      cliId: 'codex',
      model: 'gpt-5',
      effort: 'low',
    });
    const plain = await createOne();

    expect(auto).toMatchObject({
      status: 'pending',
      runMode: 'auto',
      cliId: 'codex',
      effort: 'low',
    });
    expect(plain.runMode).toBe('manual');
    expect(plain.cliId).toBeUndefined();

    const all = await invoke<ScheduledTask[]>(IPC.scheduledTasks.list);
    const mine = await invoke<ScheduledTask[]>(IPC.scheduledTasks.listByProject, 'p1');
    expect(all).toHaveLength(2);
    expect(mine).toHaveLength(2);
  });

  it('edits a task and clears a CLI choice set back to default', async () => {
    const task = await createOne({ cliId: 'codex', model: 'gpt-5' });

    const updated = await invoke<ScheduledTask>(IPC.scheduledTasks.update, task.id, {
      content: 'better plan',
      runMode: 'auto',
      cliId: '',
      model: '',
    });

    expect(updated).toMatchObject({ content: 'better plan', runMode: 'auto' });
    expect(updated.cliId).toBeUndefined();
    expect(updated.model).toBeUndefined();
  });

  it('puts a missed task back in the queue when it gets a new time', async () => {
    const task = await createOne({ runMode: 'auto' });
    await invoke(IPC.scheduledTasks.updateStatus, task.id, 'missed');

    const updated = await invoke<ScheduledTask>(IPC.scheduledTasks.update, task.id, {
      runAt: '2026-10-02T09:00:00.000Z',
    });

    expect(updated.status).toBe('pending');
  });

  it('records when a task was run by hand', async () => {
    const task = await createOne();

    await invoke(IPC.scheduledTasks.markRan, task.id);

    const [stored] = await invoke<ScheduledTask[]>(IPC.scheduledTasks.listByProject, 'p1');
    expect(stored.status).toBe('completed');
    expect(stored.ranAt).toEqual(expect.any(String));
  });

  it('removes a task', async () => {
    const task = await createOne();
    await invoke(IPC.scheduledTasks.remove, task.id);
    await expect(invoke(IPC.scheduledTasks.listByProject, 'p1')).resolves.toEqual([]);
  });
});
