import type { ActivityEvent } from '@runova/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { store } from '../store';

export function registerActivityHandlers(): void {
  ipcMain.handle(IPC.activity.list, (): Promise<ActivityEvent[]> => store.getActivity());
}
