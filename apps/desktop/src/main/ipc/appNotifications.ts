import type { AppNotification } from '@runova/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { store } from '../store';

/**
 * The in-app notification inbox. The pipeline watcher is what fills it today,
 * but nothing here is pipeline-specific, so it lives on its own rather than
 * inside the pipelines module where nobody would think to look for it.
 */
export function registerAppNotificationHandlers(): void {
  ipcMain.handle(IPC.appNotifications.list, (): Promise<AppNotification[]> => {
    return store.getAppNotifications();
  });

  ipcMain.handle(IPC.appNotifications.unreadCount, async (): Promise<number> => {
    const items = await store.getAppNotifications();
    return items.filter((item) => !item.read).length;
  });

  ipcMain.handle(
    IPC.appNotifications.markRead,
    async (_event, notificationId: string): Promise<AppNotification[]> => {
      const items = await store.getAppNotifications();
      const next = items.map((item) =>
        item.id === notificationId ? { ...item, read: true } : item,
      );
      await store.setAppNotifications(next);
      return next;
    },
  );

  ipcMain.handle(IPC.appNotifications.markAllRead, async (): Promise<AppNotification[]> => {
    const items = await store.getAppNotifications();
    const next = items.map((item) => (item.read ? item : { ...item, read: true }));
    await store.setAppNotifications(next);
    return next;
  });

  ipcMain.handle(
    IPC.appNotifications.remove,
    async (_event, notificationId: string): Promise<AppNotification[]> => {
      const items = await store.getAppNotifications();
      const next = items.filter((item) => item.id !== notificationId);
      await store.setAppNotifications(next);
      return next;
    },
  );
}
