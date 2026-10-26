import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  clampWidgetBlurPercent,
  type DesktopWidgetInstance,
  type OpenWidgetOptions,
  type WidgetMode,
  type WidgetSize,
  widgetAlwaysOnTop,
  widgetBackgroundColor,
  widgetPeriod,
} from '@runova/core';
import { BrowserWindow } from 'electron';
import icon from '../../../resources/icon.ico?asset';
import { sendToWindow } from '../ipc/send';
import { store } from '../store';
import { keepWindowsHidden } from '../testMode';

// One frameless, transparent BrowserWindow per pinned widget. Each loads the
// existing renderer bundle at the `#/widget/<id>` hash route, so no extra Vite
// entry is needed. Window position (and a user resize) is persisted back to
// settings whenever the user moves or stretches a widget.

const WIDGET_DIMENSIONS: Record<WidgetSize, { width: number; height: number }> = {
  small: { width: 300, height: 228 },
  medium: { width: 360, height: 332 },
  large: { width: 420, height: 428 },
};

const MIN_WIDGET_SIZE = { width: 260, height: 180 };

const windows = new Map<string, BrowserWindow>();

function normalizeWidget(widget: DesktopWidgetInstance): DesktopWidgetInstance {
  return {
    ...widget,
    mode: widget.mode === 'subscription' ? 'subscription' : 'tokens',
    blurPercent: clampWidgetBlurPercent(widget.blurPercent),
    backgroundColor: widgetBackgroundColor(widget.backgroundColor),
    alwaysOnTop: widgetAlwaysOnTop(widget),
    period: widgetPeriod(widget),
  };
}

async function readWidgets(): Promise<DesktopWidgetInstance[]> {
  const settings = await store.getSettings();
  // Anything that isn't the subscription widget is a token widget. This also
  // folds in widgets persisted before modes existed, and the short-lived 'auto'
  // value an earlier build wrote.
  return (settings.usageWidgets ?? []).map(normalizeWidget);
}

async function writeWidgets(widgets: DesktopWidgetInstance[]): Promise<void> {
  await store.updateSettings((settings) => ({ ...settings, usageWidgets: widgets }));
}

async function upsertWidget(instance: DesktopWidgetInstance): Promise<void> {
  const widgets = await readWidgets();
  const idx = widgets.findIndex((w) => w.id === instance.id);
  if (idx >= 0) widgets[idx] = instance;
  else widgets.push(instance);
  await writeWidgets(widgets);
}

function loadWidgetRoute(win: BrowserWindow, id: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/widget/${id}`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/widget/${id}` });
  }
}

function applyAlwaysOnTop(win: BrowserWindow, alwaysOnTop: boolean): void {
  if (alwaysOnTop) {
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    return;
  }
  // Sit with the desktop: other windows cover it, and it comes back when those
  // windows are minimized or the user shows the desktop.
  win.setAlwaysOnTop(false);
  win.setVisibleOnAllWorkspaces(false);
}

function widgetBounds(instance: DesktopWidgetInstance): { width: number; height: number } {
  const preset = WIDGET_DIMENSIONS[instance.size];
  return {
    width: instance.width ?? preset.width,
    height: instance.height ?? preset.height,
  };
}

function createWidgetWindow(instance: DesktopWidgetInstance): BrowserWindow {
  const dims = widgetBounds(instance);
  const alwaysOnTop = widgetAlwaysOnTop(instance);
  const win = new BrowserWindow({
    width: dims.width,
    height: dims.height,
    minWidth: MIN_WIDGET_SIZE.width,
    minHeight: MIN_WIDGET_SIZE.height,
    x: instance.x,
    y: instance.y,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop,
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

  applyAlwaysOnTop(win, alwaysOnTop);
  win.once('ready-to-show', () => {
    if (!keepWindowsHidden) win.show();
  });

  // Persist position after the user drags the widget (debounced).
  let moveTimer: NodeJS.Timeout | null = null;
  const persistBounds = (): void => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      void readWidgets().then((widgets) => {
        const existing = widgets.find((w) => w.id === instance.id);
        if (existing) void upsertWidget({ ...existing, x, y, width, height });
      });
    }, 400);
  };
  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  win.on('closed', () => {
    if (moveTimer) clearTimeout(moveTimer);
    windows.delete(instance.id);
  });

  loadWidgetRoute(win, instance.id);
  windows.set(instance.id, win);
  return win;
}

function notifyUpdated(id: string): void {
  sendToWindow(windows.get(id), 'usage:widgetUpdated', { id });
}

export const widgetManager = {
  async list(): Promise<DesktopWidgetInstance[]> {
    return readWidgets();
  },

  async get(id: string): Promise<DesktopWidgetInstance | null> {
    const widgets = await readWidgets();
    return widgets.find((w) => w.id === id) ?? null;
  },

  async open(providerId: string, options: OpenWidgetOptions = {}): Promise<DesktopWidgetInstance> {
    const size = options.size ?? 'medium';
    const dims = WIDGET_DIMENSIONS[size];
    const instance = normalizeWidget({
      id: randomUUID(),
      providerId,
      // Cascade new widgets slightly so they don't stack exactly. A provider can
      // have several widgets pinned at once (tokens and subscription side by
      // side), so this keeps the newest from landing on top of the last.
      x: 80 + windows.size * 24,
      y: 80 + windows.size * 24,
      size,
      style: options.style ?? 'colorful',
      mode: options.mode ?? 'tokens',
      blurPercent: clampWidgetBlurPercent(options.blurPercent),
      backgroundColor: widgetBackgroundColor(options.backgroundColor),
      alwaysOnTop: options.alwaysOnTop ?? true,
      period: options.period ?? 'day',
      width: dims.width,
      height: dims.height,
    });
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

  async configure(id: string, patch: OpenWidgetOptions): Promise<void> {
    const current = await this.get(id);
    if (!current) return;
    const next = normalizeWidget({
      ...current,
      ...patch,
      blurPercent:
        patch.blurPercent !== undefined
          ? clampWidgetBlurPercent(patch.blurPercent)
          : current.blurPercent,
      backgroundColor:
        patch.backgroundColor !== undefined
          ? widgetBackgroundColor(patch.backgroundColor)
          : current.backgroundColor,
    });
    if (patch.size && patch.size !== current.size) {
      const dims = WIDGET_DIMENSIONS[patch.size];
      next.width = dims.width;
      next.height = dims.height;
    }
    await upsertWidget(next);
    const win = windows.get(id);
    if (win) {
      if (patch.size && next.width && next.height) {
        win.setSize(next.width, next.height);
      }
      if (patch.alwaysOnTop !== undefined) {
        applyAlwaysOnTop(win, widgetAlwaysOnTop(next));
      }
      notifyUpdated(id);
    }
  },

  async setStyle(id: string, style: NonNullable<OpenWidgetOptions['style']>): Promise<void> {
    await this.configure(id, { style });
  },

  async setMode(id: string, mode: WidgetMode): Promise<void> {
    await this.configure(id, { mode });
  },

  async setSize(id: string, size: WidgetSize): Promise<void> {
    await this.configure(id, { size });
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
