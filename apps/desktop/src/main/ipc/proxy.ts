import type { ProxySettings } from '@runova/core';
import { ipcMain } from 'electron';
import type { ProxyStatus, ProxyTestResult } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { getProxyStatus, testProxy } from '../network/proxy';

export function registerProxyHandlers(): void {
  ipcMain.handle(IPC.proxy.status, (): Promise<ProxyStatus> => getProxyStatus());

  ipcMain.handle(
    IPC.proxy.test,
    (_event, candidate: ProxySettings): Promise<ProxyTestResult> => testProxy(candidate),
  );
}
