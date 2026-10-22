import { hostname } from 'node:os';
import { join } from 'node:path';
import { app, dialog, type IpcMainInvokeEvent, ipcMain, net } from 'electron';
import { IPC } from '../../../shared/ipcChannels';
import { registerDeployWordPressHandlers } from '../../ipc/deployWordPress';
import { createProjectRecord, setProjectWordPressLink } from '../../ipc/projects';
import { sendToWindow } from '../../ipc/send';
import { getMainWindow } from '../../mainWindow';
import {
  decryptSecret,
  encryptSecret,
  isLockedEnvelope,
  registerSealedSecretStore,
} from '../../ssh/vault';
import { store } from '../../store';
import { readShippedConnector } from './connectorBundle';
import { saveConnectorZip } from './connectorZip';
import { WordPressProjectService } from './projectService';
import { WordPressBases, WordPressState, wordPressStateFilePort } from './state';
import { createFetchTransport } from './transport';

/**
 * Wires WordPress sites (E19 to E21) into Electron: the sealed state beside the other Deploy
 * stores (its secrets move with a Servers passkey change), the signed client over Electron's
 * network stack, progress to the main window, and the IPC handlers.
 */

/** The store the WordPress section runs on, once it is up; a restore moves its addresses (E28). */
let liveState: WordPressState | null = null;
export function wordPressState(): WordPressState | null {
  return liveState;
}

export function registerDeployWordPressIpc(deps: {
  guard: (event: IpcMainInvokeEvent) => boolean;
}): void {
  const data = join(app.getPath('userData'), 'data');
  const state = new WordPressState(wordPressStateFilePort(join(data, 'deploy-wordpress.json')));
  liveState = state;
  registerSealedSecretStore(state.sealedKeys);
  const service = new WordPressProjectService({
    state,
    bases: new WordPressBases(join(data, 'wordpress', 'bases')),
    transport: createFetchTransport((url, init) => net.fetch(url, init)),
    seal: encryptSecret,
    unseal: decryptSecret,
    isLocked: isLockedEnvelope,
    progress: (event) => sendToWindow(getMainWindow(), IPC.deployWordPress.onProgress, event),
    hostname,
    projects: {
      get: async (projectId) =>
        (await store.getProjects()).find((project) => project.id === projectId) ?? null,
      create: createProjectRecord,
      setLink: setProjectWordPressLink,
    },
    readConnectorBundle: () =>
      readShippedConnector({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      }),
    saveConnectorZip: () =>
      saveConnectorZip({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        pickSavePath: async (suggestedName) => {
          const options = {
            title: 'Save the AgentMate Connector plugin',
            defaultPath: suggestedName,
            filters: [{ name: 'WordPress plugin', extensions: ['zip'] }],
          };
          const win = getMainWindow();
          const result = win
            ? await dialog.showSaveDialog(win, options)
            : await dialog.showSaveDialog(options);
          return result.canceled ? null : (result.filePath ?? null);
        },
      }),
  });
  registerDeployWordPressHandlers({ ipc: ipcMain, service, guard: deps.guard });
}
