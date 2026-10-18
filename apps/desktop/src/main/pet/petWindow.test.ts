import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBrowserWindow } from '../../test/main/electronMock';

vi.mock('../../../resources/icon.ico?asset', () => ({ default: 'icon.ico' }));
vi.mock('../store', () => ({
  store: { getSettings: async () => ({ desktopPetEnabled: true }) },
}));

const { petManager } = await import('./petWindow');

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value });
}

/** Opens the companion and marks it shown, the way `ready-to-show` would. */
function openPet(): FakeBrowserWindow {
  petManager.open();
  const win = FakeBrowserWindow.instances.at(-1);
  if (!win) throw new Error('no pet window');
  win.emit('ready-to-show');
  return win;
}

describe('desktop pet window and the taskbar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPlatform('win32');
  });

  afterEach(() => {
    petManager.setDragGuard(false);
    petManager.close();
    setPlatform(realPlatform);
  });

  // The pet used to land in the AgentMate taskbar group as a second window, and
  // people closed it from there thinking it was a stray copy of the app.
  it('is a tool window on Windows so it never gets a taskbar button', () => {
    const win = openPet();
    expect(win.options.skipTaskbar).toBe(true);
    expect(win.options.type).toBe('toolbar');
  });

  it('leaves the window type alone on Linux and macOS', () => {
    setPlatform('linux');
    const win = openPet();
    expect(win.options.skipTaskbar).toBe(true);
    expect(win.options).not.toHaveProperty('type');
  });

  it('drops the taskbar button again when it is first shown', () => {
    petManager.open();
    const win = FakeBrowserWindow.instances.at(-1);
    if (!win) throw new Error('no pet window');
    const skip = vi.spyOn(win, 'setSkipTaskbar');
    win.emit('ready-to-show');
    expect(win.isVisible()).toBe(true);
    expect(skip).toHaveBeenLastCalledWith(true);
  });

  it('drops the taskbar button again after a drag hides and shows it', () => {
    const win = openPet();
    const skip = vi.spyOn(win, 'setSkipTaskbar');

    petManager.setDragGuard(true);
    expect(win.isVisible()).toBe(false);
    petManager.setDragGuard(false);

    expect(win.isVisible()).toBe(true);
    expect(skip).toHaveBeenLastCalledWith(true);
  });

  it('drops the taskbar button again when it is opened while already there', () => {
    const win = openPet();
    win.hide();
    const skip = vi.spyOn(win, 'setSkipTaskbar');

    petManager.open();

    expect(FakeBrowserWindow.instances.at(-1)).toBe(win);
    expect(win.isVisible()).toBe(true);
    expect(skip).toHaveBeenLastCalledWith(true);
  });

  // Explorer restarting puts every button back without any event in the app,
  // so the slow topmost timer asks again too.
  it('keeps asking on the topmost timer', () => {
    const win = openPet();
    const skip = vi.spyOn(win, 'setSkipTaskbar');

    vi.advanceTimersByTime(4000);
    expect(skip).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(skip).toHaveBeenCalledTimes(2);
    expect(skip).toHaveBeenLastCalledWith(true);
  });
});
