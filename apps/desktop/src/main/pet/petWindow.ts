import { join } from 'node:path';
import { BrowserWindow, powerMonitor, screen } from 'electron';
import icon from '../../../resources/icon.ico?asset';
import { IPC } from '../../shared/ipcChannels';
import {
  PET_SNOOZE_MAX_MINUTES,
  type PetPipelineMessage,
  type PetSnoozeState,
  type PetWorkArea,
} from '../../shared/pet';
import { broadcastToWindows, sendToWindow } from '../ipc/send';
import { store } from '../store';

// Windows does not keep a topmost window on top forever. Another app going
// full screen, a UAC prompt, explorer restarting or waking from sleep can all
// drop the pet behind whatever is open, and nothing tells us it happened. So we
// stamp the flag again on a slow timer instead of making the user switch the
// companion off and on.
const TOPMOST_REFRESH_MS = 4000;

let win: BrowserWindow | null = null;
let displayListenersBound = false;
let powerListenersBound = false;
let topmostTimer: ReturnType<typeof setInterval> | null = null;
let snoozeUntil: number | null = null;
let snoozeTimer: ReturnType<typeof setTimeout> | null = null;
// What the pet renderer last asked for. While the overlay is parked for a drag
// the request is only remembered, then applied again once the drag is over.
let clickThroughWanted = true;
let dragParked = false;

function primaryWorkArea(): PetWorkArea {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x, y: area.y, width: area.width, height: area.height };
}

function loadPetRoute(target: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void target.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/desktop-pet`);
  } else {
    void target.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/desktop-pet' });
  }
}

function fitToWorkArea(target: BrowserWindow): PetWorkArea {
  const area = primaryWorkArea();
  target.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height }, false);
  return area;
}

function broadcastWorkArea(): void {
  if (!win || win.isDestroyed()) return;
  sendToWindow(win, IPC.pet.onDisplayChanged, fitToWorkArea(win));
  // Resolution and monitor changes are one of the moments the pet slips behind
  // other windows, so re-stamp right away rather than waiting for the timer.
  reassertTopmost();
}

function reassertTopmost(): void {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  // Turning it off first matters: asking for a level the window already claims
  // to have can be a no-op, even when the OS has quietly moved it down.
  win.setAlwaysOnTop(false);
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.moveTop();
  // On Windows `skipTaskbar` only asks Explorer once to drop the button
  // (ITaskbarList::DeleteTab). Explorer adds it back when the window is shown
  // again, which the drag guard does on every in-app drag, and after Explorer
  // restarts. The pet then sat in the taskbar as a second AgentMate and people
  // closed it from there. The tool window style set at creation is the real
  // fix, asking again here covers anything that still slips past.
  win.setSkipTaskbar(true);
}

function startTopmostKeeper(): void {
  if (topmostTimer) return;
  topmostTimer = setInterval(reassertTopmost, TOPMOST_REFRESH_MS);
}

function stopTopmostKeeper(): void {
  if (!topmostTimer) return;
  clearInterval(topmostTimer);
  topmostTimer = null;
}

function bindPowerListeners(): void {
  if (powerListenersBound) return;
  powerListenersBound = true;
  powerMonitor.on('resume', reassertTopmost);
  powerMonitor.on('unlock-screen', reassertTopmost);
}

function bindDisplayListeners(): void {
  if (displayListenersBound) return;
  displayListenersBound = true;
  screen.on('display-metrics-changed', broadcastWorkArea);
  screen.on('display-added', broadcastWorkArea);
  screen.on('display-removed', broadcastWorkArea);
}

function applyClickThrough(target: BrowserWindow, ignore: boolean): void {
  // Forwarding hands the overlay the mouse moves it needs to know when the
  // cursor is over the character. It costs a global mouse hook, so it goes off
  // while the overlay is parked and the app is in the middle of a drag.
  if (ignore) target.setIgnoreMouseEvents(true, { forward: !dragParked });
  else target.setIgnoreMouseEvents(false);
}

function broadcastSnooze(): void {
  const state: PetSnoozeState = { until: snoozeUntil };
  broadcastToWindows(IPC.pet.onSnoozeChanged, state);
}

function stopSnoozeTimer(): void {
  if (!snoozeTimer) return;
  clearTimeout(snoozeTimer);
  snoozeTimer = null;
}

function clearSnooze(): boolean {
  if (snoozeUntil === null) return false;
  stopSnoozeTimer();
  snoozeUntil = null;
  broadcastSnooze();
  return true;
}

function createPetWindow(): BrowserWindow {
  const area = primaryWorkArea();
  const created = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // WS_EX_TOOLWINDOW: Windows never gives a tool window a taskbar button or an
    // Alt+Tab entry. Only on Windows, Linux reads `toolbar` as a window manager
    // hint that changes stacking.
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  created.setAlwaysOnTop(true, 'floating');
  created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  created.setMenu(null);
  applyClickThrough(created, true);
  created.once('ready-to-show', () => {
    created.showInactive();
    reassertTopmost();
    startTopmostKeeper();
  });
  created.on('closed', () => {
    if (win === created) {
      win = null;
      stopTopmostKeeper();
    }
  });

  loadPetRoute(created);
  bindDisplayListeners();
  bindPowerListeners();
  return created;
}

export const petManager = {
  isOpen(): boolean {
    return win !== null && !win.isDestroyed();
  },

  open(): void {
    if (this.isOpen()) {
      if (win) fitToWorkArea(win);
      // Parked for a drag: leave it off screen until the drag hands it back.
      if (dragParked) return;
      win?.showInactive();
      reassertTopmost();
      startTopmostKeeper();
      return;
    }
    win = createPetWindow();
  },

  close(): void {
    if (!win) return;
    stopTopmostKeeper();
    dragParked = false;
    const closing = win;
    win = null;
    if (!closing.isDestroyed()) closing.close();
  },

  async syncFromSettings(): Promise<void> {
    const settings = await store.getSettings();
    if (!settings.desktopPetEnabled) {
      // Switching the pet off and back on is a deliberate "show it now", so a
      // pending hide should not survive that round trip.
      clearSnooze();
      this.close();
      return;
    }
    if (snoozeUntil !== null && snoozeUntil > Date.now()) {
      this.close();
      return;
    }
    this.open();
    this.notifySettings();
  },

  snoozeState(): PetSnoozeState {
    return { until: snoozeUntil };
  },

  /** Hides the companion for a while. It comes back by itself when time is up. */
  snooze(minutes: number): PetSnoozeState {
    const requested = Number(minutes);
    const safe = Math.min(
      PET_SNOOZE_MAX_MINUTES,
      Math.max(1, Math.round(Number.isFinite(requested) ? requested : 0)),
    );
    const ms = safe * 60_000;
    stopSnoozeTimer();
    snoozeUntil = Date.now() + ms;
    this.close();
    snoozeTimer = setTimeout(() => {
      snoozeTimer = null;
      snoozeUntil = null;
      broadcastSnooze();
      void this.syncFromSettings();
    }, ms);
    broadcastSnooze();
    return this.snoozeState();
  },

  /** Ends a hide early, bringing the companion straight back if it is turned on. */
  cancelSnooze(): PetSnoozeState {
    if (clearSnooze()) void this.syncFromSettings();
    return this.snoozeState();
  },

  notifySettings(): void {
    sendToWindow(win, IPC.pet.onSettingsChanged);
  },

  sendPipelineMessage(payload: PetPipelineMessage): void {
    if (!this.isOpen()) return;
    sendToWindow(win, IPC.pet.onPipelineMessage, payload);
  },

  setClickThrough(ignore: boolean): void {
    clickThroughWanted = ignore;
    if (!win || win.isDestroyed() || dragParked) return;
    applyClickThrough(win, ignore);
  },

  /**
   * Parks the overlay while the app window runs a native drag.
   *
   * Windows picks the drop target by asking which window sits under the cursor,
   * and it does not care that this one is click-through: plain clicks fall
   * straight through the companion, drops land on it. With the pet on, every
   * drag in the app (reordering projects, dashboard edit mode) was handed to an
   * overlay that wants nothing to do with it, so nothing ever moved. Taking the
   * window off screen for the second or two a drag lasts is the only thing that
   * keeps it out of the drag entirely.
   */
  setDragGuard(active: boolean): void {
    if (dragParked === active) return;
    dragParked = active;
    if (!win || win.isDestroyed()) return;
    if (active) {
      stopTopmostKeeper();
      applyClickThrough(win, true);
      win.hide();
      return;
    }
    applyClickThrough(win, clickThroughWanted);
    if (!win.isVisible()) win.showInactive();
    reassertTopmost();
    startTopmostKeeper();
  },

  workArea(): PetWorkArea {
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
    return primaryWorkArea();
  },
};
