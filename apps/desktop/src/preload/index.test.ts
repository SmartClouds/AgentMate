import { beforeAll, describe, expect, it } from 'vitest';
import { IPC } from '../shared/ipcChannels';

/**
 * The preload bridge is the only door between the renderer and the main process, so what matters
 * here is the wiring rather than any logic: every method has to reach a channel that exists, and
 * every subscription has to hand back an unsubscribe that really removes its listener. A method
 * pointed at a channel nobody handles fails at runtime with a hanging promise, which is exactly
 * the kind of mistake a walk of the whole API catches cheaply.
 *
 * The module is aliased to the electron mock (see vitest.config.mts), so importing it runs the
 * real `contextBridge.exposeInMainWorld` call against a recorded fake.
 */

type Bridge = Record<string, unknown>;

const KNOWN_CHANNELS = new Set<string>();
function collectChannels(node: unknown): void {
  if (typeof node === 'string') {
    KNOWN_CHANNELS.add(node);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectChannels(value);
  }
}
collectChannels(IPC);

let bridge: Bridge;
let windowsBuildNumber: () => number | null;
let exposedName: unknown;
let ipcRenderer: {
  invoke: { mock: { calls: unknown[][] }; mockClear: () => void };
  send: { mock: { calls: unknown[][] }; mockClear: () => void };
  on: { mock: { calls: unknown[][] }; mockClear: () => void };
  removeListener: { mock: { calls: unknown[][] }; mockClear: () => void };
};

beforeAll(async () => {
  // Electron adds this to `process`, and the preload reads it at import time to decide which
  // window controls the platform supports. Plain Node has no such function.
  (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion = () =>
    '10.0.26200';

  const electron = (await import('electron')) as unknown as {
    contextBridge: { exposeInMainWorld: { mock: { calls: unknown[][] } } };
    ipcRenderer: typeof ipcRenderer;
  };
  windowsBuildNumber = (await import('./index')).windowsBuildNumber;
  const exposed = electron.contextBridge.exposeInMainWorld.mock.calls.at(-1);
  exposedName = exposed?.[0];
  bridge = exposed?.[1] as Bridge;
  ipcRenderer = electron.ipcRenderer;
});

/** Every function on the bridge, as `namespace.method` paths. */
function walk(node: Bridge, prefix = ''): { path: string; fn: (...args: unknown[]) => unknown }[] {
  const found: { path: string; fn: (...args: unknown[]) => unknown }[] = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'function') {
      found.push({ path, fn: value as (...args: unknown[]) => unknown });
    } else if (value && typeof value === 'object') {
      found.push(...walk(value as Bridge, path));
    }
  }
  return found;
}

describe('the exposed bridge', () => {
  it('is published under the name the renderer reads', () => {
    // Captured at import time: the per-test reset clears the recorded calls afterwards.
    expect(exposedName).toBe('runova');
  });

  it('exposes the namespaces the renderer depends on', () => {
    // A missing namespace is a blank page rather than an error, so these are worth pinning.
    for (const namespace of [
      'settings',
      'projects',
      'terminal',
      'git',
      'usage',
      'skills',
      'remote',
      'backup',
      'browser',
    ]) {
      expect(Object.keys(bridge)).toContain(namespace);
    }
  });

  it('reports the platform as a value, not a call', () => {
    // Renderer code branches on this synchronously while rendering.
    expect(typeof bridge.platform).toBe('string');
  });
});

describe('every method reaches a real channel', () => {
  it('invokes or sends only channels declared in ipcChannels', () => {
    const methods = walk(bridge);
    // A floor, so a walk that silently found nothing cannot pass.
    expect(methods.length).toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const { path, fn } of methods) {
      ipcRenderer.invoke.mockClear();
      ipcRenderer.send.mockClear();
      ipcRenderer.on.mockClear();

      try {
        // Placeholder arguments: the fake ipcRenderer records the channel and never answers, so
        // what the method does with a reply does not matter here.
        fn('placeholder', 'placeholder', 'placeholder');
      } catch {
        // A method that validates its arguments is free to refuse these.
        continue;
      }

      const used = [
        ...ipcRenderer.invoke.mock.calls,
        ...ipcRenderer.send.mock.calls,
        ...ipcRenderer.on.mock.calls,
      ].map((call) => call[0]);

      for (const channel of used) {
        if (typeof channel !== 'string' || !KNOWN_CHANNELS.has(channel)) {
          offenders.push(`${path} -> ${String(channel)}`);
        }
      }
    }

    expect(offenders, `methods pointing at unknown channels: ${offenders.join(', ')}`).toEqual([]);
  });

  it('routes each namespace to its own channels', () => {
    // Copy and paste between namespaces is the usual way a method ends up on the wrong channel.
    ipcRenderer.invoke.mockClear();
    const settings = bridge.settings as { get: () => unknown };
    settings.get();
    expect(ipcRenderer.invoke.mock.calls.at(-1)?.[0]).toBe(IPC.settings.get);

    ipcRenderer.invoke.mockClear();
    const projects = bridge.projects as { list: () => unknown };
    projects.list();
    expect(ipcRenderer.invoke.mock.calls.at(-1)?.[0]).toBe(IPC.projects.list);
  });
});

describe('subscriptions', () => {
  it('hand back an unsubscribe that removes the very listener they added', () => {
    // A component that unmounts has to stop receiving, or its state updates fire after teardown.
    const methods = walk(bridge).filter(({ path }) => /\.on[A-Z]/.test(`.${path}`));
    expect(methods.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const { path, fn } of methods) {
      ipcRenderer.on.mockClear();
      ipcRenderer.removeListener.mockClear();

      const unsubscribe = fn(() => undefined);
      const added = ipcRenderer.on.mock.calls.at(-1);
      if (typeof unsubscribe !== 'function' || !added) {
        offenders.push(`${path} did not register a listener or return an unsubscribe`);
        continue;
      }

      (unsubscribe as () => void)();
      const removed = ipcRenderer.removeListener.mock.calls.at(-1);
      if (!removed || removed[0] !== added[0] || removed[1] !== added[1]) {
        offenders.push(`${path} removed a different listener than it added`);
      }
    }

    expect(offenders, offenders.join('; ')).toEqual([]);
  });
});

describe('arguments reach the main process unchanged', () => {
  it('forwards what security sensitive methods were given', () => {
    const cases: { call: () => void; channel: string; args: unknown[] }[] = [
      {
        call: () => (bridge.fs as { readFile: (p: string) => unknown }).readFile('C:/tmp/a.txt'),
        channel: IPC.fs.readFile,
        args: ['C:/tmp/a.txt'],
      },
      {
        call: () =>
          (bridge.terminal as { write: (id: string, data: string) => unknown }).write('s1', 'ls\r'),
        channel: IPC.terminal.write,
        args: ['s1', 'ls\r'],
      },
      {
        call: () =>
          (bridge.shell as { openExternal: (u: string) => unknown }).openExternal(
            'https://example.com',
          ),
        channel: IPC.shell.openExternal,
        args: ['https://example.com'],
      },
    ];

    for (const { call, channel, args } of cases) {
      ipcRenderer.invoke.mockClear();
      call();
      expect(ipcRenderer.invoke.mock.calls.at(-1)).toEqual([channel, ...args]);
    }
  });
});

describe('the Windows build number', () => {
  // xterm renders differently depending on how this build of ConPTY redraws, so the renderer
  // reads it while deciding what to do. Faking the platform around a synchronous call keeps the
  // module graph alone: swapping process.platform across an import breaks path resolution.
  function on(platform: string, systemVersion: string): number | null {
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion = () =>
      systemVersion;
    try {
      return windowsBuildNumber();
    } finally {
      if (real) Object.defineProperty(process, 'platform', real);
    }
  }

  it('is the third part of the system version on Windows', () => {
    expect(on('win32', '10.0.26200')).toBe(26200);
  });

  it('is null when the system version carries no build part', () => {
    expect(on('win32', '10.0')).toBeNull();
  });

  it('is null rather than zero when the build part is not a real build', () => {
    expect(on('win32', '10.0.0')).toBeNull();
  });

  it('is null off Windows, where the number would mean nothing', () => {
    expect(on('linux', '6.8.0')).toBeNull();
  });
});

describe('optional arguments', () => {
  it('reach the main process as the value the handler expects, not as undefined', () => {
    // These two default on the preload side, so a renderer that calls them bare still sends
    // something the handler can read.
    ipcRenderer.invoke.mockClear();
    (bridge.skills as { pickLocalRepository: () => unknown }).pickLocalRepository();
    expect(ipcRenderer.invoke.mock.calls.at(-1)).toEqual([IPC.skills.pickLocalRepository, null]);

    ipcRenderer.invoke.mockClear();
    (bridge.skills as { listAudits: () => unknown }).listAudits();
    expect(ipcRenderer.invoke.mock.calls.at(-1)).toEqual([IPC.skills.listAudits, {}]);
  });
});
