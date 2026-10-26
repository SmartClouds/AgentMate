import type { KeepAwakeMode } from '@runova/core';
import { ipcMain } from 'electron';
import type { KeepAwakeStatus } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { keepAwake } from '../power/keepAwake';
import { store } from '../store';

function isMode(value: unknown): value is KeepAwakeMode {
  return value === 'on' || value === 'agent' || value === 'off';
}

export function registerPowerHandlers(): void {
  // The stored choice applies from startup, before anything asks for it.
  void store
    .getSettings()
    .then((settings) => keepAwake.setMode(settings.keepAwake))
    .catch(() => undefined);

  ipcMain.handle(IPC.power.keepAwakeStatus, (): KeepAwakeStatus => keepAwake.status());

  ipcMain.handle(
    IPC.power.setKeepAwake,
    async (_event, value: unknown): Promise<KeepAwakeStatus> => {
      if (isMode(value)) {
        keepAwake.setMode(value);
        await store.updateSettings((settings) => ({ ...settings, keepAwake: value }));
      }
      return keepAwake.status();
    },
  );
}
