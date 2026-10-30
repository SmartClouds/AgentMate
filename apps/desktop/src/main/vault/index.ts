import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, clipboard, dialog, ipcMain, powerMonitor, shell } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { sendToWindow } from '../ipc/send';
import { registerVaultHandlers } from '../ipc/vault';
import { getMainWindow } from '../mainWindow';
import { fetchVaultIcon } from '../projectIcons';
import { guestLoginPage, isWebUrl, openLoginWindow } from './autofill/loginWindow';
import type { VaultFileV1 } from './format';
import type { PowerPort, VaultFilePort } from './ports';
import { VaultService } from './service';

const VAULT_FILE = 'vault.json';

function dataDir(): string {
  return join(app.getPath('userData'), 'data');
}

/** vault.json under userData/data, written atomically and readable only by the user on POSIX. */
export const electronVaultFiles: VaultFilePort = {
  async read() {
    let raw: string;
    try {
      raw = await readFile(join(dataDir(), VAULT_FILE), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      // Still a vault, just a damaged one. Unlocking reports it as corrupt.
      return {};
    }
  },
  async write(file: VaultFileV1) {
    await mkdir(dataDir(), { recursive: true });
    const target = join(dataDir(), VAULT_FILE);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, target);
  },
  async moveAside(suffix: string) {
    const name = `${VAULT_FILE}.${suffix}`;
    try {
      await rename(join(dataDir(), VAULT_FILE), join(dataDir(), name));
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
};

const electronPower: PowerPort = {
  onSystemLock(listener) {
    powerMonitor.on('lock-screen', listener);
    powerMonitor.on('suspend', listener);
    return () => {
      powerMonitor.off('lock-screen', listener);
      powerMonitor.off('suspend', listener);
    };
  },
};

function sendToMainWindow(channel: string, payload?: unknown): void {
  sendToWindow(getMainWindow(), channel, payload);
}

let service: VaultService | null = null;

export function getVaultService(): VaultService {
  service ??= new VaultService({
    files: electronVaultFiles,
    clipboard,
    events: {
      stateChanged: (event) => sendToMainWindow(IPC.vault.onStateChanged, event),
      entriesChanged: () => sendToMainWindow(IPC.vault.onEntriesChanged),
      clipboardSettled: (event) => sendToMainWindow(IPC.vault.onClipboardSettled, event),
      loginFilled: (event) => sendToMainWindow(IPC.vault.onLoginFilled, event),
    },
    env: process.env,
    isPackaged: app.isPackaged,
    login: {
      openWindow: openLoginWindow,
      openExternal: async (url) => {
        if (isWebUrl(url)) await shell.openExternal(url);
      },
    },
  });
  return service;
}

export function registerVaultIpc(): void {
  registerVaultHandlers({
    ipc: ipcMain,
    service: getVaultService(),
    fetchIcon: fetchVaultIcon,
    guestPage: (id) => guestLoginPage(id, getMainWindow()?.webContents ?? null),
    guard: (event) => {
      const win = getMainWindow();
      return (
        !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      );
    },
    dialogs: {
      async pickImportFile() {
        const result = await dialog.showOpenDialog({
          title: 'Import passwords',
          properties: ['openFile'],
          filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      async pickExportPath(format) {
        const stamp = new Date().toISOString().slice(0, 10);
        const result = await dialog.showSaveDialog({
          title: 'Export vault as plain text CSV',
          defaultPath: `runova-vault-${format}-${stamp}.csv`,
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        return result.canceled ? null : (result.filePath ?? null);
      },
    },
  });
}

/** Called once the app is ready: timers from settings, and locking with the OS. */
export function startVault(settings: Parameters<VaultService['applySettings']>[0]): void {
  const vault = getVaultService();
  vault.applySettings(settings);
  vault.attachPower(electronPower);
}
