import type { ActivityEvent } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The activity feed on the dashboard. One handler, but it is the only reader of the file every
 * other module appends to through `logActivity`, so this checks the two together.
 */

const userData = useTempUserData();
expectChannelsCovered(IPC.activity);

async function register(): Promise<void> {
  await loadIpc(
    () => import('./activity'),
    (module) => module.registerActivityHandlers(),
  );
}

beforeEach(async () => {
  await register();
});

describe('activity', () => {
  it('is empty on a fresh profile', async () => {
    await expect(invoke(IPC.activity.list)).resolves.toEqual([]);
  });

  it('reads what other modules logged', async () => {
    const { logActivity } = await import('../store');

    await logActivity('prompt-generated', 'Generated a Full Stack prompt for Claude Code');

    const events = await invoke<ActivityEvent[]>(IPC.activity.list);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'prompt-generated',
      message: 'Generated a Full Stack prompt for Claude Code',
    });
  });

  it('keeps the metadata an event was logged with', async () => {
    const { logActivity } = await import('../store');

    // The project id rides along as metadata, which is what the feed filters a project's
    // events by.
    await logActivity('prompt-generated', 'Generated a prompt', { projectId: 'p1' });

    const [event] = await invoke<ActivityEvent[]>(IPC.activity.list);
    expect(event.metadata).toEqual({ projectId: 'p1' });
  });

  it('caps the feed so the file cannot grow without end', async () => {
    const { logActivity, store } = await import('../store');

    // Fill the feed to the cap in one write rather than 200 logActivity calls. Each call is a
    // read, write and rename on disk, and on a loaded Windows machine that many ran past the
    // test timeout, then kept renaming in the background and broke the next test with EPERM.
    await store.setActivity(
      Array.from({ length: 200 }, (_, index) => ({
        id: `seed-${index}`,
        type: 'prompt-generated' as const,
        message: `event ${199 - index}`,
        createdAt: new Date(199 - index).toISOString(),
      })),
    );
    for (let index = 200; index < 205; index += 1) {
      await logActivity('prompt-generated', `event ${index}`);
    }

    const events = await invoke<ActivityEvent[]>(IPC.activity.list);
    expect(events).toHaveLength(200);
    expect(events[0]?.message).toBe('event 204');
    expect(events.at(-1)?.message).toBe('event 5');
  });

  it('shows the newest event first, which is the order the feed is drawn in', async () => {
    const { logActivity } = await import('../store');

    await logActivity('prompt-generated', 'older');
    await logActivity('prompt-generated', 'newer');

    const events = await invoke<ActivityEvent[]>(IPC.activity.list);
    expect(events.map((one) => one.message)).toEqual(['newer', 'older']);
  });

  it('survives a restart, since the feed is meant to be a history', async () => {
    const { logActivity } = await import('../store');
    await logActivity('prompt-generated', 'from an earlier run');

    await register();

    const events = await invoke<ActivityEvent[]>(IPC.activity.list);
    expect(events.map((one) => one.message)).toEqual(['from an earlier run']);
    expect(userData.dir).toBeTruthy();
  });
});
