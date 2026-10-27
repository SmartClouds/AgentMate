import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app, type BrowserWindow, type ShortcutDetails, shell } from 'electron';
import windowsIcon from '../../resources/icon.ico?asset';
import pngIcon from '../../resources/icon.png?asset';
import macIcon from '../../resources/icon-mac.png?asset';

const execFileAsync = promisify(execFile);

/** electron-builder.yml's `appId`. Windows groups taskbar buttons and toasts by it. */
export const APP_ID = 'com.runova.app';

/**
 * The icon windows and notifications carry: the multi-size .ico on Windows, a PNG elsewhere
 * (Electron reads no .ico on Linux). macOS windows have no icon of their own.
 */
export const appIcon = process.platform === 'win32' ? windowsIcon : pngIcon;

/**
 * A dev run is the stock Electron binary, so wherever the OS shows the program's icon rather
 * than the window's, it shows Electron's: the macOS Dock and the Windows taskbar. A packaged
 * build has the icon built in and needs none of this.
 */
export function showAppIconInDev(): void {
  if (app.isPackaged) return;
  if (process.platform === 'darwin') {
    app.dock?.setIcon(macIcon);
  } else if (process.platform === 'win32') {
    app.on('browser-window-created', (_event, window) => setRelaunchIcon(window));
    void app.whenReady().then(brandToastShortcut);
  }
}

/** Without a Start menu shortcut for the app id, the taskbar takes the window's relaunch icon. */
function setRelaunchIcon(window: BrowserWindow): void {
  // Windows ignores the icon unless the relaunch command and name are set too.
  window.setAppDetails({
    appId: APP_ID,
    appIconPath: windowsIcon,
    appIconIndex: 0,
    relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
    relaunchDisplayName: app.getName(),
  });
}

/**
 * Electron puts a shortcut for the app id in the Start menu the first time it sets up toasts,
 * pointing at electron.exe with no icon of its own, and from then on the taskbar and every toast
 * show that shortcut's icon. Electron only rewrites it when the target or ids change, so the
 * icon set here stays. Explorer notices the change a while later, not at once, so the run that
 * fixes the shortcut still shows Electron's icon and the runs after it show Runova's.
 * shell.writeShortcutLink drops the icon (Electron 43), hence PowerShell.
 */
export async function brandToastShortcut(): Promise<void> {
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  let names: string[];
  try {
    names = await readdir(programs);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.lnk')) continue;
    const path = join(programs, name);
    let link: ShortcutDetails;
    try {
      link = shell.readShortcutLink(path);
    } catch {
      continue;
    }
    if (link.appUserModelId !== APP_ID || !samePath(link.target, process.execPath)) continue;
    if (link.icon && samePath(link.icon, windowsIcon)) continue;
    try {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$link = (New-Object -ComObject WScript.Shell).CreateShortcut($env:RUNOVA_SHORTCUT); $link.IconLocation = "$env:RUNOVA_ICON,0"; $link.Save()',
        ],
        {
          windowsHide: true,
          timeout: 5_000,
          env: { ...process.env, RUNOVA_SHORTCUT: path, RUNOVA_ICON: windowsIcon },
        },
      );
    } catch {
      // The taskbar keeps Electron's icon this run; the next start tries again.
    }
  }
}

function samePath(a: string, b: string): boolean {
  return a.replaceAll('/', '\\').toLowerCase() === b.replaceAll('/', '\\').toLowerCase();
}
