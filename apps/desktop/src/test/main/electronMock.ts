import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Mock, vi } from 'vitest';

/**
 * Stands in for the `electron` module in main-process tests. The vitest "main" project aliases
 * `electron` to this file, so importing a handler module under test pulls this in instead of the
 * real runtime (which only exists inside an Electron process).
 *
 * Everything a test needs to look at afterwards lands on `electronState`: registered IPC
 * handlers, queued dialog answers, windows that were created, messages sent to a renderer.
 * Paths point at a throwaway folder per test, so nothing reads or writes the real profile.
 */

export type IpcHandler = (event: FakeIpcEvent, ...args: unknown[]) => unknown;
export type IpcListener = (event: FakeIpcEvent, ...args: unknown[]) => void;

export interface FakeWebContents {
  id: number;
  send: (channel: string, ...args: unknown[]) => void;
  isDestroyed: () => boolean;
  setWindowOpenHandler: (handler: unknown) => void;
  on: (event: string, listener: unknown) => void;
  once: (event: string, listener: unknown) => void;
  session: { setProxy: (config: unknown) => Promise<void> };
  /** Everything `send` was called with for one channel. */
  sentOn: (channel: string) => unknown[][];
}

export interface FakeIpcEvent {
  sender: FakeWebContents;
  senderFrame: { url: string } | null;
  preventDefault: () => void;
  returnValue?: unknown;
}

interface DialogQueue {
  showOpenDialog: unknown[];
  showSaveDialog: unknown[];
  showMessageBox: unknown[];
  showErrorBox: unknown[];
}

export interface ElectronState {
  /** Overrides for `app.getPath`. Anything not set here resolves under the temp root. */
  paths: Map<string, string>;
  isPackaged: boolean;
  version: string;
  name: string;
  locale: string;
  handlers: Map<string, IpcHandler>;
  listeners: Map<string, IpcListener[]>;
  appEvents: Map<string, ((...args: unknown[]) => void)[]>;
  windows: FakeBrowserWindow[];
  dialogs: DialogQueue;
  dialogCalls: { method: keyof DialogQueue; args: unknown[] }[];
  openedExternal: string[];
  openedPaths: string[];
  notifications: { title?: string; body?: string }[];
  proxyConfigs: unknown[];
  registeredSchemes: unknown[];
  quitCalls: number;
  relaunchCalls: number;
  encryptionAvailable: boolean;
  clipboardText: string;
  powerBlockers: { id: number; type: string; stopped: boolean }[];
  tempRoot: string | null;
}

function freshDialogQueue(): DialogQueue {
  return { showOpenDialog: [], showSaveDialog: [], showMessageBox: [], showErrorBox: [] };
}

function freshState(): ElectronState {
  return {
    paths: new Map(),
    isPackaged: false,
    version: '0.0.0-test',
    name: 'AgentMate Test',
    locale: 'en-US',
    handlers: new Map(),
    listeners: new Map(),
    appEvents: new Map(),
    windows: [],
    dialogs: freshDialogQueue(),
    dialogCalls: [],
    openedExternal: [],
    openedPaths: [],
    notifications: [],
    proxyConfigs: [],
    registeredSchemes: [],
    quitCalls: 0,
    relaunchCalls: 0,
    encryptionAvailable: true,
    clipboardText: '',
    powerBlockers: [],
    tempRoot: null,
  };
}

/**
 * The state lives on globalThis, not in this module.
 *
 * A test that calls `vi.resetModules()` and then imports the handler module under test gets a
 * second copy of this file: the module under test would talk to that copy while the test file
 * still holds the first one, so registered handlers and `app.getPath` overrides would land out of
 * each other's reach. Sharing one object through the global keeps every copy looking at the same
 * handlers, dialog answers and paths.
 */
const STATE_KEY = '__agentmateElectronMockState';
const globalWithState = globalThis as typeof globalThis & { [STATE_KEY]?: ElectronState };

export const electronState: ElectronState = (globalWithState[STATE_KEY] ??= freshState());

/** The throwaway folder every unset `app.getPath` name resolves under. Created on first use. */
export function electronTempRoot(): string {
  if (!electronState.tempRoot) {
    electronState.tempRoot = mkdtempSync(join(tmpdir(), 'agentmate-electron-'));
  }
  return electronState.tempRoot;
}

/** Points one `app.getPath` name at a folder of your choosing. */
export function setElectronPath(name: string, value: string): void {
  electronState.paths.set(name, value);
}

/** The next call to this dialog answers with `result`. Queue several to answer in order. */
export function queueDialog(method: keyof DialogQueue, result: unknown): void {
  electronState.dialogs[method].push(result);
}

let webContentsId = 0;

export function fakeWebContents(): FakeWebContents {
  webContentsId += 1;
  const sent: { channel: string; args: unknown[] }[] = [];
  return {
    id: webContentsId,
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, args });
    },
    isDestroyed: () => false,
    setWindowOpenHandler: () => undefined,
    on: () => undefined,
    once: () => undefined,
    session: { setProxy: async () => undefined },
    sentOn: (channel: string) =>
      sent.filter((one) => one.channel === channel).map((one) => one.args),
  };
}

export class FakeBrowserWindow {
  /** Shared through the state, so a second copy of this module sees the same windows. */
  static get instances(): FakeBrowserWindow[] {
    return electronState.windows;
  }

  static set instances(next: FakeBrowserWindow[]) {
    electronState.windows = next;
  }

  readonly id: number;
  readonly webContents = fakeWebContents();
  readonly options: Record<string, unknown>;
  readonly events = new Map<string, ((...args: unknown[]) => void)[]>();
  destroyed = false;
  visible = false;
  bounds = { x: 0, y: 0, width: 1440, height: 860 };

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    this.id = this.webContents.id;
    electronState.windows.push(this);
  }

  static getAllWindows(): FakeBrowserWindow[] {
    return FakeBrowserWindow.instances.filter((one) => !one.destroyed);
  }

  static fromWebContents(contents: FakeWebContents): FakeBrowserWindow | null {
    return FakeBrowserWindow.instances.find((one) => one.webContents.id === contents.id) ?? null;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.events.get(event) ?? [];
    existing.push(listener);
    this.events.set(event, existing);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener);
  }

  /** Fires the handlers a window event would fire, for example `close` or `ready-to-show`. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.events.get(event) ?? []) listener(...args);
  }

  removeAllListeners(): this {
    this.events.clear();
    return this;
  }

  show(): void {
    this.visible = true;
  }
  showInactive(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  focus(): void {
    this.visible = true;
  }
  close(): void {
    this.emit('close', { preventDefault: () => undefined });
    this.destroyed = true;
    this.emit('closed');
  }
  destroy(): void {
    this.destroyed = true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isMinimized(): boolean {
    return false;
  }
  isMaximized(): boolean {
    return false;
  }
  isFocused(): boolean {
    return false;
  }
  isFullScreen(): boolean {
    return false;
  }
  restore(): void {
    this.visible = true;
  }
  minimize(): void {
    this.visible = false;
  }
  maximize(): void {
    this.visible = true;
  }
  unmaximize(): void {
    this.visible = true;
  }
  setFullScreen(): void {
    return undefined;
  }
  setBounds(next: Partial<typeof this.bounds>): void {
    this.bounds = { ...this.bounds, ...next };
  }
  getBounds(): typeof this.bounds {
    return this.bounds;
  }
  getNormalBounds(): typeof this.bounds {
    return this.bounds;
  }
  setAlwaysOnTop(): void {
    return undefined;
  }
  setIgnoreMouseEvents(): void {
    return undefined;
  }
  setSkipTaskbar(): void {
    return undefined;
  }
  setVisibleOnAllWorkspaces(): void {
    return undefined;
  }
  moveTop(): void {
    return undefined;
  }
  setMenu(): void {
    return undefined;
  }
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  loadFile(): Promise<void> {
    return Promise.resolve();
  }
}

function answerDialog(method: keyof DialogQueue, fallback: unknown, args: unknown[]): unknown {
  electronState.dialogCalls.push({ method, args });
  const queued = electronState.dialogs[method];
  return queued.length > 0 ? queued.shift() : fallback;
}

export const app = {
  getPath: (name: string): string => {
    const override = electronState.paths.get(name);
    if (override) return override;
    return join(electronTempRoot(), name);
  },
  setPath: (name: string, value: string): void => {
    electronState.paths.set(name, value);
  },
  getAppPath: (): string => electronTempRoot(),
  getVersion: (): string => electronState.version,
  getName: (): string => electronState.name,
  setName: (value: string): void => {
    electronState.name = value;
  },
  getLocale: (): string => electronState.locale,
  getSystemLocale: (): string => electronState.locale,
  get isPackaged(): boolean {
    return electronState.isPackaged;
  },
  isReady: (): boolean => true,
  whenReady: (): Promise<void> => Promise.resolve(),
  on: (event: string, listener: (...args: unknown[]) => void) => {
    const existing = electronState.appEvents.get(event) ?? [];
    existing.push(listener);
    electronState.appEvents.set(event, existing);
    return app;
  },
  once: (event: string, listener: (...args: unknown[]) => void) => app.on(event, listener),
  off: () => app,
  removeAllListeners: () => app,
  emit: (event: string, ...args: unknown[]): void => {
    for (const listener of electronState.appEvents.get(event) ?? []) listener(...args);
  },
  quit: (): void => {
    electronState.quitCalls += 1;
  },
  exit: (): void => {
    electronState.quitCalls += 1;
  },
  relaunch: (): void => {
    electronState.relaunchCalls += 1;
  },
  requestSingleInstanceLock: (): boolean => true,
  setAppUserModelId: (): void => undefined,
  setLoginItemSettings: (): void => undefined,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setAsDefaultProtocolClient: (): boolean => true,
  commandLine: { appendSwitch: (): void => undefined, hasSwitch: (): boolean => false },
  dock: { show: (): void => undefined, hide: (): void => undefined },
  focus: (): void => undefined,
};

export const ipcMain = {
  handle: (channel: string, handler: IpcHandler): void => {
    electronState.handlers.set(channel, handler);
  },
  handleOnce: (channel: string, handler: IpcHandler): void => {
    electronState.handlers.set(channel, handler);
  },
  removeHandler: (channel: string): void => {
    electronState.handlers.delete(channel);
  },
  on: (channel: string, listener: IpcListener) => {
    const existing = electronState.listeners.get(channel) ?? [];
    existing.push(listener);
    electronState.listeners.set(channel, existing);
    return ipcMain;
  },
  once: (channel: string, listener: IpcListener) => ipcMain.on(channel, listener),
  removeListener: (channel: string, listener: IpcListener) => {
    const remaining = (electronState.listeners.get(channel) ?? []).filter(
      (one) => one !== listener,
    );
    electronState.listeners.set(channel, remaining);
    return ipcMain;
  },
  removeAllListeners: (channel?: string) => {
    if (channel) electronState.listeners.delete(channel);
    else electronState.listeners.clear();
    return ipcMain;
  },
};

export const ipcRenderer: Record<
  'invoke' | 'send' | 'sendSync' | 'on' | 'once' | 'removeListener' | 'removeAllListeners',
  Mock
> = {
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
  sendSync: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
};

export const contextBridge: { exposeInMainWorld: Mock } = {
  exposeInMainWorld: vi.fn(),
};

export const dialog = {
  showOpenDialog: async (...args: unknown[]) =>
    answerDialog('showOpenDialog', { canceled: true, filePaths: [] }, args),
  showSaveDialog: async (...args: unknown[]) =>
    answerDialog('showSaveDialog', { canceled: true, filePath: undefined }, args),
  showMessageBox: async (...args: unknown[]) =>
    answerDialog('showMessageBox', { response: 0 }, args),
  showErrorBox: (...args: unknown[]) => {
    answerDialog('showErrorBox', undefined, args);
  },
};

export const shell = {
  openExternal: async (url: string): Promise<void> => {
    electronState.openedExternal.push(url);
  },
  openPath: async (target: string): Promise<string> => {
    electronState.openedPaths.push(target);
    return '';
  },
  showItemInFolder: (target: string): void => {
    electronState.openedPaths.push(target);
  },
  trashItem: async (): Promise<void> => undefined,
  beep: (): void => undefined,
};

/**
 * A reversible stand-in for the OS keychain. Real safeStorage needs a desktop session, so tests
 * get a marker prefix instead: still asymmetric enough to catch code that forgets to decrypt.
 */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => electronState.encryptionAvailable,
  encryptString: (plain: string): Buffer => Buffer.from(`enc:${plain}`, 'utf-8'),
  decryptString: (encrypted: Buffer): string => {
    const text = encrypted.toString('utf-8');
    if (!text.startsWith('enc:')) throw new Error('not encrypted by safeStorage');
    return text.slice(4);
  },
};

export const clipboard = {
  readText: (): string => electronState.clipboardText,
  writeText: (value: string): void => {
    electronState.clipboardText = value;
  },
  readImage: () => nativeImage.createEmpty(),
  writeImage: (): void => undefined,
  clear: (): void => {
    electronState.clipboardText = '';
  },
};

export const nativeImage = {
  createEmpty: () => ({
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
    toDataURL: () => '',
    resize: () => nativeImage.createEmpty(),
    getSize: () => ({ width: 0, height: 0 }),
  }),
  createFromPath: () => nativeImage.createEmpty(),
  createFromBuffer: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty(),
};

export class Notification {
  static isSupported(): boolean {
    return true;
  }
  constructor(readonly options: { title?: string; body?: string } = {}) {
    electronState.notifications.push(options);
  }
  on(): this {
    return this;
  }
  show(): void {
    return undefined;
  }
  close(): void {
    return undefined;
  }
}

export const session = {
  defaultSession: {
    setProxy: async (config: unknown): Promise<void> => {
      electronState.proxyConfigs.push(config);
    },
    resolveProxy: async (): Promise<string> => 'DIRECT',
    clearCache: async (): Promise<void> => undefined,
    clearStorageData: async (): Promise<void> => undefined,
    webRequest: { onBeforeSendHeaders: (): void => undefined },
    cookies: { get: async () => [] },
  },
  fromPartition: () => session.defaultSession,
};

export const protocol: {
  registerSchemesAsPrivileged: (schemes: unknown) => void;
  handle: Mock;
  unhandle: Mock;
  registerFileProtocol: Mock;
} = {
  registerSchemesAsPrivileged: (schemes: unknown): void => {
    electronState.registeredSchemes.push(schemes);
  },
  handle: vi.fn(),
  unhandle: vi.fn(),
  registerFileProtocol: vi.fn(),
};

export const powerSaveBlocker = {
  start: (type: string): number => {
    const id = electronState.powerBlockers.length + 1;
    electronState.powerBlockers.push({ id, type, stopped: false });
    return id;
  },
  stop: (id: number): void => {
    const found = electronState.powerBlockers.find((one) => one.id === id);
    if (found) found.stopped = true;
  },
  isStarted: (id: number): boolean =>
    electronState.powerBlockers.some((one) => one.id === id && !one.stopped),
};

export const powerMonitor = {
  on: (): void => undefined,
  once: (): void => undefined,
  removeAllListeners: (): void => undefined,
  getSystemIdleTime: (): number => 0,
};

export const screen = {
  getPrimaryDisplay: () => ({
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    workAreaSize: { width: 1920, height: 1040 },
    scaleFactor: 1,
  }),
  getAllDisplays: () => [screen.getPrimaryDisplay()],
  getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on: (): void => undefined,
};

export const desktopCapturer = {
  getSources: async () => [],
};

export const nativeTheme = {
  shouldUseDarkColors: true,
  themeSource: 'system' as string,
  on: (): void => undefined,
  removeAllListeners: (): void => undefined,
};

export const Menu: {
  buildFromTemplate: (template: unknown) => { template: unknown; popup: Mock; closePopup: Mock };
  setApplicationMenu: Mock;
  getApplicationMenu: () => null;
} = {
  buildFromTemplate: (template: unknown) => ({ template, popup: vi.fn(), closePopup: vi.fn() }),
  setApplicationMenu: vi.fn(),
  getApplicationMenu: () => null,
};

export class Tray {
  setToolTip(): void {
    return undefined;
  }
  setContextMenu(): void {
    return undefined;
  }
  on(): this {
    return this;
  }
  destroy(): void {
    return undefined;
  }
}

export const globalShortcut = {
  register: (): boolean => true,
  unregister: (): void => undefined,
  unregisterAll: (): void => undefined,
  isRegistered: (): boolean => false,
};

export const utilityProcess: { fork: Mock } = {
  fork: vi.fn(() => ({
    pid: 1234,
    on: vi.fn(),
    once: vi.fn(),
    postMessage: vi.fn(),
    kill: vi.fn(() => true),
  })),
};

export const net: { isOnline: () => boolean; fetch: Mock } = {
  isOnline: (): boolean => true,
  fetch: vi.fn(),
};

export const BrowserWindow = FakeBrowserWindow;
export const webContents = {
  getAllWebContents: () => FakeBrowserWindow.getAllWindows().map((one) => one.webContents),
  fromId: (id: number) =>
    FakeBrowserWindow.getAllWindows().find((one) => one.webContents.id === id)?.webContents ?? null,
};

/** Clears every recorded call and removes the temp folder. The main setup file calls this. */
export function resetElectronMock(): void {
  const root = electronState.tempRoot;
  electronState.paths.clear();
  electronState.handlers.clear();
  electronState.listeners.clear();
  electronState.appEvents.clear();
  electronState.windows = [];
  electronState.dialogs = freshDialogQueue();
  electronState.dialogCalls = [];
  electronState.openedExternal = [];
  electronState.openedPaths = [];
  electronState.notifications = [];
  electronState.proxyConfigs = [];
  electronState.registeredSchemes = [];
  electronState.quitCalls = 0;
  electronState.relaunchCalls = 0;
  electronState.encryptionAvailable = true;
  electronState.clipboardText = '';
  electronState.powerBlockers = [];
  electronState.isPackaged = false;
  electronState.tempRoot = null;
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.themeSource = 'system';
  FakeBrowserWindow.instances = [];
  ipcRenderer.invoke.mockClear();
  ipcRenderer.send.mockClear();
  contextBridge.exposeInMainWorld.mockClear();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

const electronMock = {
  app,
  ipcMain,
  ipcRenderer,
  contextBridge,
  dialog,
  shell,
  safeStorage,
  clipboard,
  nativeImage,
  Notification,
  session,
  protocol,
  powerSaveBlocker,
  powerMonitor,
  screen,
  desktopCapturer,
  nativeTheme,
  Menu,
  Tray,
  globalShortcut,
  utilityProcess,
  net,
  BrowserWindow,
  webContents,
};

// The runtime alias only replaces the module's implementation; type checking still uses the
// real electron typings, so the default export does not need to mirror them.
export default electronMock as unknown as Record<string, unknown>;
