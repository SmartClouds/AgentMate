import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DesktopPromptBuildWidgetInstance } from '@runova/core';
import { BrowserWindow } from 'electron';
import icon from '../../../resources/icon.ico?asset';
import { store } from '../store';
import { keepWindowsHidden } from '../testMode';

// One frameless, transparent, always-on-top BrowserWindow per pinned Build
// Prompt widget. Each loads the existing renderer bundle at the
// `#/widget/prompt-build/<id>` hash route, so no extra Vite entry is needed.
// Unlike Token Usage widgets there is no size/style/mode to vary. The widget
// mirrors the dialog's small (non-maximized) layout and can only be closed,
// not enlarged, so a single fixed size is enough.

const WIDGET_WIDTH = 380;
const WIDGET_HEIGHT = 660;

const windows = new Map<string, BrowserWindow>();

async function readWidgets(): Promise<DesktopPromptBuildWidgetInstance[]> {
  const settings = await store.getSettings();
  return settings.promptBuildWidgets ?? [];
}

async function writeWidgets(widgets: DesktopPromptBuildWidgetInstance[]): Promise<void> {
  await store.updateSettings((settings) => ({ ...settings, promptBuildWidgets: widgets }));
}

async function upsertWidget(instance: DesktopPromptBuildWidgetInstance): Promise<void> {
  const widgets = await readWidgets();
  const idx = widgets.findIndex((w) => w.id === instance.id);
  if (idx >= 0) widgets[idx] = instance;
  else widgets.push(instance);
  await writeWidgets(widgets);
}

function loadWidgetRoute(win: BrowserWindow, id: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/widget/prompt-build/${id}`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: `/widget/prompt-build/${id}`,
    });
  }
}

function createWidgetWindow(instance: DesktopPromptBuildWidgetInstance): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x: instance.x,
    y: instance.y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.once('ready-to-show', () => {
    if (!keepWindowsHidden) win.show();
  });

  // Persist position after the user drags the widget (debounced).
  let moveTimer: NodeJS.Timeout | null = null;
  const persistBounds = (): void => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [x, y] = win.getPosition();
      void readWidgets().then((widgets) => {
        const existing = widgets.find((w) => w.id === instance.id);
        if (existing) void upsertWidget({ ...existing, x, y });
      });
    }, 400);
  };
  win.on('moved', persistBounds);

  win.on('closed', () => {
    if (moveTimer) clearTimeout(moveTimer);
    windows.delete(instance.id);
  });

  loadWidgetRoute(win, instance.id);
  windows.set(instance.id, win);
  return win;
}

export const promptBuildWidgetManager = {
  async list(): Promise<DesktopPromptBuildWidgetInstance[]> {
    return readWidgets();
  },

  async get(id: string): Promise<DesktopPromptBuildWidgetInstance | null> {
    const widgets = await readWidgets();
    return widgets.find((w) => w.id === id) ?? null;
  },

  async open(projectId: string, projectName: string): Promise<DesktopPromptBuildWidgetInstance> {
    const instance: DesktopPromptBuildWidgetInstance = {
      id: randomUUID(),
      projectId,
      projectName,
      // Cascade new widgets slightly so they don't stack exactly.
      x: 80 + windows.size * 24,
      y: 80 + windows.size * 24,
    };
    await upsertWidget(instance);
    createWidgetWindow(instance);
    return instance;
  },

  async close(id: string): Promise<void> {
    windows.get(id)?.close();
    windows.delete(id);
    const widgets = await readWidgets();
    await writeWidgets(widgets.filter((w) => w.id !== id));
  },

  /** Re-open every saved widget on app launch. */
  async restoreAll(): Promise<void> {
    const widgets = await readWidgets();
    for (const instance of widgets) {
      if (!windows.has(instance.id)) createWidgetWindow(instance);
    }
  },

  closeAll(): void {
    for (const win of windows.values()) win.close();
    windows.clear();
  },
};
