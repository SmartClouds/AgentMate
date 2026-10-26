import type { AppNotification } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The in-app notification inbox behind the bell in the title bar. The unread count is what the
 * badge draws, so it and the read flags are what these check, along with each handler returning
 * the new list so the renderer does not have to ask again.
 */

const userData = useTempUserData();
expectChannelsCovered(IPC.appNotifications, [
  // Pushed from main when the watcher adds one, rather than invoked from the renderer.
  IPC.appNotifications.onChanged,
]);

async function register(): Promise<void> {
  await loadIpc(
    () => import('./appNotifications'),
    (module) => module.registerAppNotificationHandlers(),
  );
}

function notification(id: string, read = false): AppNotification {
  return {
    id,
    title: `Run ${id}`,
    body: 'A workflow finished.',
    createdAt: '2026-09-18T10:00:00.000Z',
    read,
  } as AppNotification;
}

async function seed(...items: AppNotification[]): Promise<void> {
  userData.writeData('app-notifications.json', items);
  await register();
}

beforeEach(async () => {
  await register();
});

describe('the notification inbox', () => {
  it('is empty on a fresh profile', async () => {
    await expect(invoke(IPC.appNotifications.list)).resolves.toEqual([]);
    await expect(invoke(IPC.appNotifications.unreadCount)).resolves.toBe(0);
  });

  it('counts only the unread ones for the badge', async () => {
    await seed(notification('a'), notification('b', true), notification('c'));

    await expect(invoke(IPC.appNotifications.unreadCount)).resolves.toBe(2);
  });

  it('marks one as read and hands back the whole list', async () => {
    await seed(notification('a'), notification('b'));

    const next = await invoke<AppNotification[]>(IPC.appNotifications.markRead, 'a');

    expect(next.find((one) => one.id === 'a')?.read).toBe(true);
    expect(next.find((one) => one.id === 'b')?.read).toBe(false);
    await expect(invoke(IPC.appNotifications.unreadCount)).resolves.toBe(1);
  });

  it('leaves the list alone when the id is not there', async () => {
    await seed(notification('a'));

    const next = await invoke<AppNotification[]>(IPC.appNotifications.markRead, 'gone');

    expect(next).toHaveLength(1);
    expect(next[0]?.read).toBe(false);
  });

  it('marks everything read at once', async () => {
    await seed(notification('a'), notification('b', true), notification('c'));

    const next = await invoke<AppNotification[]>(IPC.appNotifications.markAllRead);

    expect(next.every((one) => one.read)).toBe(true);
    await expect(invoke(IPC.appNotifications.unreadCount)).resolves.toBe(0);
  });

  it('removes one and keeps the rest', async () => {
    await seed(notification('a'), notification('b'));

    const next = await invoke<AppNotification[]>(IPC.appNotifications.remove, 'a');

    expect(next.map((one) => one.id)).toEqual(['b']);
  });

  it('keeps what was read across a restart', async () => {
    await seed(notification('a'), notification('b'));
    await invoke(IPC.appNotifications.markRead, 'a');

    await register();

    const listed = await invoke<AppNotification[]>(IPC.appNotifications.list);
    expect(listed.find((one) => one.id === 'a')?.read).toBe(true);
  });
});
