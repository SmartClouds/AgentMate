import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';
import {
  electronState,
  type FakeIpcEvent,
  fakeWebContents,
  resetElectronMock,
  setElectronPath,
} from './electronMock';

/**
 * Drives IPC handler modules the way the renderer does: register the module against the fake
 * `ipcMain`, then call a channel by name and look at what came back and what landed on disk.
 *
 * Generalizes the pattern in src/main/ipc/settings.test.ts so every handler module can use it.
 */

export interface UserDataContext {
  /** The temp folder standing in for the app's userData directory. */
  readonly dir: string;
  /** `<userData>/data/<name>`, where the app keeps its JSON stores. */
  dataFile(name: string): string;
  /** Writes one of those JSON stores before the module under test reads it. */
  writeData(name: string, value: unknown): void;
}

/**
 * Gives each test a fresh userData folder, a clean module registry and an empty handler map.
 * Call it once at the top of a test file and keep the returned object for paths.
 */
export function useTempUserData(options: { home?: boolean } = {}): UserDataContext {
  const state = { dir: '' };

  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'runova-userdata-'));
    mkdirSync(join(state.dir, 'data'), { recursive: true });
    setElectronPath('userData', state.dir);
    if (options.home !== false) {
      const home = join(state.dir, 'home');
      mkdirSync(home, { recursive: true });
      setElectronPath('home', home);
      setElectronPath('documents', join(home, 'Documents'));
      setElectronPath('downloads', join(home, 'Downloads'));
    }
    // Handlers are registered at import time, so each test needs the module graph rebuilt.
    vi.resetModules();
    electronState.handlers.clear();
    electronState.listeners.clear();
  });

  afterEach(() => {
    try {
      rmSync(state.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A file still held open by a process that is on its way out must not fail the test.
    }
  });

  return {
    get dir() {
      return state.dir;
    },
    dataFile: (name: string) => join(state.dir, 'data', name),
    writeData: (name: string, value: unknown) => {
      mkdirSync(join(state.dir, 'data'), { recursive: true });
      writeFileSync(join(state.dir, 'data', name), JSON.stringify(value), 'utf-8');
    },
  };
}

/**
 * Imports a handler module after the per-test reset and runs its register function, which is what
 * puts its channels in the handler map.
 */
export async function loadIpc<Module extends Record<string, unknown>>(
  importer: () => Promise<Module>,
  register: (module: Module) => void | Promise<void>,
): Promise<Module> {
  const module = await importer();
  await register(module);
  return module;
}

function makeEvent(sender = fakeWebContents()): FakeIpcEvent {
  return { sender, senderFrame: { url: 'app://renderer' }, preventDefault: () => undefined };
}

const invokedChannels = new Set<string>();

/** Calls an `ipcMain.handle` channel and returns its result, like `ipcRenderer.invoke` does. */
export async function invoke<Result>(channel: string, ...args: unknown[]): Promise<Result> {
  const handler = electronState.handlers.get(channel);
  if (!handler) {
    throw new Error(
      `no handler registered for "${channel}". Registered: ${[...electronState.handlers.keys()].join(', ')}`,
    );
  }
  invokedChannels.add(channel);
  return (await handler(makeEvent(), ...args)) as Result;
}

/** Same, but with a specific sender, for handlers that reply to the calling window. */
export async function invokeFrom<Result>(
  sender: ReturnType<typeof fakeWebContents>,
  channel: string,
  ...args: unknown[]
): Promise<Result> {
  const handler = electronState.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for "${channel}"`);
  invokedChannels.add(channel);
  return (await handler(makeEvent(sender), ...args)) as Result;
}

/** Fires an `ipcMain.on` channel, the fire-and-forget counterpart of invoke. */
export function emit(channel: string, ...args: unknown[]): void {
  const listeners = electronState.listeners.get(channel);
  if (!listeners || listeners.length === 0) {
    throw new Error(`no listener registered for "${channel}"`);
  }
  invokedChannels.add(channel);
  for (const listener of listeners) listener(makeEvent(), ...args);
}

/** Every channel the module under test registered, in registration order. */
export function registeredChannels(): string[] {
  return [...electronState.handlers.keys(), ...electronState.listeners.keys()];
}

/**
 * Fails the file when a channel in `namespace` was registered but never called by any test in it.
 * Keeps a handler module from growing a new channel with no test. Put it at the top level of the
 * file, alongside the describes.
 */
export function expectChannelsCovered(
  namespace: Record<string, unknown>,
  skip: string[] = [],
): void {
  const expected = Object.values(namespace).filter(
    (value): value is string => typeof value === 'string' && !skip.includes(value),
  );

  afterAll(() => {
    const missed = expected.filter((channel) => !invokedChannels.has(channel));
    expect(missed, `channels with no test: ${missed.join(', ')}`).toEqual([]);
  });
}

/** Drops the record of which channels were called. The setup file calls this between files. */
export function resetInvokedChannels(): void {
  invokedChannels.clear();
}

export { electronState, fakeWebContents, resetElectronMock };
