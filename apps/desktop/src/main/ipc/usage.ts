import {
  type DesktopWidgetInstance,
  getUsageProvider,
  type OpenWidgetOptions,
  type ProviderUsage,
  type UsageResetAlertSettings,
  type UsageThresholdAlertSettings,
  type WidgetMode,
  type WidgetSize,
  type WidgetStyle,
} from '@runova/core';
import { ipcMain } from 'electron';
import type { SetUsageProviderConfigInput } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { store } from '../store';
import { clearUsageCache, getAllUsage, getProviderUsage, refreshProviderUsage } from '../usage';
import { refreshResetAlerts, sendResetAlertTest } from '../usage/resetAlerts';
import { sendThresholdAlertTest } from '../usage/thresholdAlerts';
import { widgetManager } from '../usage/widgetWindows';

export function registerUsageHandlers(): void {
  ipcMain.handle(IPC.usage.list, async (): Promise<ProviderUsage[]> => {
    const settings = await store.getSettings();
    return getAllUsage(settings.usageProviderConfigs ?? {});
  });

  ipcMain.handle(IPC.usage.get, async (_e, providerId: string): Promise<ProviderUsage> => {
    const settings = await store.getSettings();
    return getProviderUsage(providerId, settings.usageProviderConfigs?.[providerId]);
  });

  ipcMain.handle(IPC.usage.refresh, async (): Promise<ProviderUsage[]> => {
    clearUsageCache();
    const settings = await store.getSettings();
    return getAllUsage(settings.usageProviderConfigs ?? {}, true);
  });

  // One provider, re-read from scratch. The renderer swaps the result into the list it already has.
  ipcMain.handle(
    IPC.usage.refreshProvider,
    async (_e, providerId: string): Promise<ProviderUsage> => {
      if (typeof providerId !== 'string' || !getUsageProvider(providerId)) {
        throw new Error(`Unknown usage provider: ${String(providerId)}`);
      }
      const settings = await store.getSettings();
      return refreshProviderUsage(providerId, settings.usageProviderConfigs?.[providerId]);
    },
  );

  ipcMain.handle(
    IPC.usage.setProviderConfig,
    async (_e, input: SetUsageProviderConfigInput): Promise<void> => {
      await store.updateSettings((settings) => ({
        ...settings,
        usageProviderConfigs: {
          ...(settings.usageProviderConfigs ?? {}),
          [input.providerId]: input.config,
        },
      }));
      clearUsageCache();
    },
  );

  // --- Rate-limit reset alerts ---
  // Saved through here rather than settings.update so the watcher picks up the
  // new schedule immediately instead of on its next slow refresh.
  ipcMain.handle(
    IPC.usage.setResetAlerts,
    async (_e, alerts: UsageResetAlertSettings): Promise<void> => {
      await store.updateSettings((settings) => ({ ...settings, usageResetAlerts: alerts }));
      await refreshResetAlerts();
    },
  );

  ipcMain.handle(
    IPC.usage.testResetAlert,
    (): Promise<{ ok: boolean; error?: string }> => sendResetAlertTest(),
  );

  // --- Threshold alerts (OS notification, in-app toast fallback) ---
  ipcMain.handle(
    IPC.usage.setThresholdAlerts,
    async (_e, alerts: UsageThresholdAlertSettings): Promise<void> => {
      await store.updateSettings((settings) => ({ ...settings, usageThresholdAlerts: alerts }));
    },
  );

  ipcMain.handle(
    IPC.usage.testThresholdAlert,
    (): Promise<{ ok: boolean; error?: string }> => sendThresholdAlertTest(),
  );

  // --- Desktop widget windows ---
  ipcMain.handle(
    IPC.usage.listWidgets,
    (): Promise<DesktopWidgetInstance[]> => widgetManager.list(),
  );
  ipcMain.handle(
    IPC.usage.getWidget,
    (_e, id: string): Promise<DesktopWidgetInstance | null> => widgetManager.get(id),
  );
  ipcMain.handle(
    IPC.usage.openWidget,
    (_e, providerId: string, options?: OpenWidgetOptions): Promise<DesktopWidgetInstance> =>
      widgetManager.open(providerId, options),
  );
  ipcMain.handle(IPC.usage.closeWidget, (_e, id: string): Promise<void> => widgetManager.close(id));
  ipcMain.handle(
    IPC.usage.setWidgetStyle,
    (_e, id: string, style: WidgetStyle): Promise<void> => widgetManager.setStyle(id, style),
  );
  ipcMain.handle(
    IPC.usage.setWidgetSize,
    (_e, id: string, size: WidgetSize): Promise<void> => widgetManager.setSize(id, size),
  );
  ipcMain.handle(
    IPC.usage.setWidgetMode,
    (_e, id: string, mode: WidgetMode): Promise<void> => widgetManager.setMode(id, mode),
  );
  ipcMain.handle(
    IPC.usage.configureWidget,
    (_e, id: string, patch: OpenWidgetOptions): Promise<void> => widgetManager.configure(id, patch),
  );
}
