import { ipcRenderer } from 'electron';
import type {
  DeployTelegramDetectResult,
  DeployTelegramRemoveInput,
  DeployTelegramSaveInput,
  DeployTelegramSaveResult,
  DeployTelegramStatus,
  DeployTelegramTestResult,
} from '../shared/deployTelegramTypes';
import { IPC } from '../shared/ipcChannels';

/**
 * Telegram notifications (E30), for the server's Notifications section. The token only goes in;
 * nothing here returns one. Changing or removing them needs an Owner and may need a step-up
 * (`[core:stepUpRequired]`): pass the password or a code, as error reporting does.
 */
export function createDeployTelegram() {
  return {
    status: (serverId: string): Promise<DeployTelegramStatus> =>
      ipcRenderer.invoke(IPC.deployTelegram.status, serverId),
    save: (input: DeployTelegramSaveInput): Promise<DeployTelegramSaveResult> =>
      ipcRenderer.invoke(IPC.deployTelegram.save, input),
    remove: (input: DeployTelegramRemoveInput): Promise<DeployTelegramStatus> =>
      ipcRenderer.invoke(IPC.deployTelegram.remove, input),
    test: (serverId: string): Promise<DeployTelegramTestResult> =>
      ipcRenderer.invoke(IPC.deployTelegram.test, serverId),
    detectChat: (botToken: string): Promise<DeployTelegramDetectResult> =>
      ipcRenderer.invoke(IPC.deployTelegram.detectChat, botToken),
  };
}
