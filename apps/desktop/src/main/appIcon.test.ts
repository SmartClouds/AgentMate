import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { electronState, electronTempRoot, resetElectronMock } from '../test/main/electronMock';

const powershell = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[]; env: Record<string, string> }[],
}));
vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(() => undefined, {
    [custom]: async (file: string, args: string[], options: { env: Record<string, string> }) => {
      powershell.calls.push({ file, args, env: options.env });
      return { stdout: '', stderr: '' };
    },
  });
  return { execFile };
});

const realPlatform = process.platform;

/** appIcon picks its file when it loads, so each platform gets a fresh copy of the module. */
async function load(platform: NodeJS.Platform): Promise<typeof import('./appIcon')> {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.resetModules();
  return import('./appIcon');
}

/** Opens a window the way BrowserWindow does, and returns what it was told about the taskbar. */
function openWindow(): ReturnType<typeof vi.fn> {
  const setAppDetails = vi.fn();
  app.emit('browser-window-created', {}, { setAppDetails });
  return setAppDetails;
}

beforeEach(() => {
  resetElectronMock();
  powershell.calls = [];
});
afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

describe('appIcon', () => {
  it('is the .ico on Windows and a PNG on Linux and macOS', async () => {
    expect((await load('win32')).appIcon).toMatch(/icon\.ico/);
    expect((await load('linux')).appIcon).toMatch(/icon\.png/);
    expect((await load('darwin')).appIcon).toMatch(/icon\.png/);
  });
});

describe('showAppIconInDev', () => {
  it('gives every Windows window the Runova icon on the taskbar in place of the Electron one', async () => {
    const { APP_ID, showAppIconInDev } = await load('win32');
    showAppIconInDev();

    const setAppDetails = openWindow();

    expect(setAppDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: APP_ID,
        appIconPath: expect.stringMatching(/icon\.ico/),
        appIconIndex: 0,
        relaunchCommand: expect.stringContaining(process.execPath),
        relaunchDisplayName: electronState.name,
      }),
    );
    expect(openWindow()).toHaveBeenCalledOnce();
  });

  it('puts the macOS icon in the Dock', async () => {
    const { showAppIconInDev } = await load('darwin');
    showAppIconInDev();

    expect(electronState.dockIcons).toEqual([expect.stringMatching(/icon-mac\.png/)]);
    expect(electronState.appEvents.get('browser-window-created')).toBeUndefined();
  });

  it('leaves Linux to the window icon', async () => {
    const { showAppIconInDev } = await load('linux');
    showAppIconInDev();

    expect(electronState.dockIcons).toEqual([]);
    expect(electronState.appEvents.get('browser-window-created')).toBeUndefined();
  });

  it('does nothing in a packaged build, which has the icon built in', async () => {
    electronState.isPackaged = true;
    for (const platform of ['win32', 'darwin'] as const) {
      const { showAppIconInDev } = await load(platform);
      showAppIconInDev();
    }

    expect(electronState.dockIcons).toEqual([]);
    expect(openWindow()).not.toHaveBeenCalled();
  });
});

describe('brandToastShortcut', () => {
  /** The Start menu folder under the mock's appData, with these shortcut files in it. */
  function startMenu(links: Record<string, Partial<Electron.ShortcutDetails> | null>): string {
    const programs = join(
      electronTempRoot(),
      'appData',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
    );
    mkdirSync(programs, { recursive: true });
    for (const [name, details] of Object.entries(links)) {
      const path = join(programs, name);
      writeFileSync(path, '');
      if (details) electronState.shortcuts.set(path, { target: '', ...details });
    }
    return programs;
  }

  it('puts the Runova icon on the shortcut Electron made for the app id, and only on that one', async () => {
    const { APP_ID, appIcon, brandToastShortcut } = await load('win32');
    const programs = startMenu({
      'Electron.lnk': { target: process.execPath.toUpperCase(), appUserModelId: APP_ID, icon: '' },
      'Runova.lnk': { target: 'C:\\Program Files\\Runova\\Runova.exe', appUserModelId: APP_ID },
      'Other.lnk': { target: process.execPath, appUserModelId: 'com.other.app' },
      'Done.lnk': { target: process.execPath, appUserModelId: APP_ID, icon: appIcon },
      'Unreadable.lnk': null,
      'notes.txt': null,
    });

    await brandToastShortcut();

    expect(powershell.calls).toHaveLength(1);
    expect(powershell.calls[0]).toMatchObject({
      file: 'powershell.exe',
      env: { RUNOVA_SHORTCUT: join(programs, 'Electron.lnk'), RUNOVA_ICON: appIcon },
    });
    // The paths travel in the environment, never inside the script.
    expect(powershell.calls[0]?.args.join(' ')).not.toContain('Electron.lnk');
  });

  it('does nothing without a Start menu folder', async () => {
    const { brandToastShortcut } = await load('win32');

    await expect(brandToastShortcut()).resolves.toBeUndefined();
    expect(powershell.calls).toEqual([]);
  });
});
