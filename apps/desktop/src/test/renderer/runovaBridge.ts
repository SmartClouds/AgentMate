import { vi } from 'vitest';
import { bridgeDefaults } from './bridgeDefaults';

/** The preload bridge's own type, taken from the global declaration rather than the module, so
 * this file stays inside the renderer's TypeScript program. */
type RunovaApi = Window['runova'];

/**
 * A stand-in for `window.runova`, the preload bridge. Renderer code calls it for everything,
 * so component and store tests need one that answers without a main process.
 *
 * Every path is created on first access and is both callable and further navigable, so
 * `runova.projects.list()` works with nothing configured. The background calls in
 * bridgeDefaults.ts answer with an empty install; any other unmentioned call resolves to
 * undefined rather than throwing.
 * Subscriptions (`onSomething`) record their callback and hand back an unsubscribe.
 */

type Listener = (...args: unknown[]) => void;
type Mock = ReturnType<typeof vi.fn>;

export interface BridgeHandle {
  /** Fires the callbacks registered through a subscription, for example `terminal.onData`. */
  $emit(path: string, ...args: unknown[]): void;
  /** The mock behind a dotted path, for `expect(...).toHaveBeenCalledWith(...)`. */
  $fn(path: string): Mock;
  /** How many callbacks are currently registered on a subscription path. */
  $listenerCount(path: string): number;
  /** Replaces what one path answers with, after the bridge was created. */
  $set(path: string, value: unknown): void;
}

export type FakeBridge = RunovaApi & BridgeHandle;

/**
 * Keys are dotted paths. A function value becomes the implementation, anything else is the
 * resolved answer, so `{ 'projects.list': [project], platform: 'darwin' }` reads naturally.
 */
export type BridgeOverrides = Record<string, unknown>;

const PASS_THROUGH = new Set([
  'then',
  'catch',
  'finally',
  'constructor',
  'prototype',
  'valueOf',
  'toJSON',
  '$$typeof',
  'nodeType',
]);

function isSubscription(key: string): boolean {
  return /^on[A-Z]/.test(key);
}

export function createRunovaBridge(overrides: BridgeOverrides = {}): FakeBridge {
  const answers = new Map<string, unknown>(
    Object.entries({ ...bridgeDefaults(), ...overrides }),
  );
  const nodes = new Map<string, unknown>();
  const mocks = new Map<string, Mock>();
  const listeners = new Map<string, Listener[]>();

  const handle: BridgeHandle = {
    $emit(path, ...args) {
      for (const listener of [...(listeners.get(path) ?? [])]) listener(...args);
    },
    $fn(path) {
      const existing = mocks.get(path);
      if (existing) return existing;
      throw new Error(`"${path}" has not been touched by the code under test`);
    },
    $listenerCount(path) {
      return (listeners.get(path) ?? []).length;
    },
    $set(path, value) {
      answers.set(path, value);
      nodes.delete(path);
      mocks.delete(path);
    },
  };

  function implementation(path: string, key: string): Mock {
    const existing = mocks.get(path);
    if (existing) return existing;

    const answer = answers.get(path);
    let fn: Mock;

    if (typeof answer === 'function') {
      fn = vi.fn(answer as (...args: unknown[]) => unknown);
    } else if (isSubscription(key)) {
      fn = vi.fn((callback: Listener) => {
        listeners.set(path, [...(listeners.get(path) ?? []), callback]);
        return () => {
          listeners.set(
            path,
            (listeners.get(path) ?? []).filter((one) => one !== callback),
          );
        };
      });
    } else if (answers.has(path)) {
      fn = vi.fn(async () => answers.get(path));
    } else {
      fn = vi.fn(async () => undefined);
    }

    mocks.set(path, fn);
    return fn;
  }

  /**
   * One path on the bridge. The target is a mock so the path can be called and asserted on, and
   * the proxy keeps unknown properties navigable so deeper paths work without configuration.
   */
  function node(path: string, key: string): unknown {
    const cached = nodes.get(path);
    if (cached) return cached;

    const target = implementation(path, key);
    const proxy = new Proxy(target, {
      get(fn, property, receiver) {
        if (typeof property !== 'string') return Reflect.get(fn, property, receiver);
        if (property in handle) return handle[property as keyof BridgeHandle];
        // Mock inspection and the promise protocol have to reach the function itself.
        if (property in fn || PASS_THROUGH.has(property)) {
          return Reflect.get(fn, property, receiver);
        }
        const childPath = `${path}.${property}`;
        const answer = answers.get(childPath);
        if (answers.has(childPath) && (answer === null || typeof answer !== 'object')) {
          return typeof answer === 'function' ? node(childPath, property) : answer;
        }
        return node(childPath, property);
      },
      has: () => true,
    });

    nodes.set(path, proxy);
    return proxy;
  }

  const root = new Proxy(
    {},
    {
      get(_target, property): unknown {
        if (typeof property !== 'string') return undefined;
        if (property in handle) return handle[property as keyof BridgeHandle];
        if (PASS_THROUGH.has(property)) return undefined;

        // Values the renderer reads rather than calls, `platform` above all.
        if (answers.has(property)) {
          const answer = answers.get(property);
          if (answer === null || typeof answer !== 'object') {
            return typeof answer === 'function' ? node(property, property) : answer;
          }
        }
        if (property === 'platform') return 'win32';
        return node(property, property);
      },
      has: () => true,
    },
  );

  return root as FakeBridge;
}

/**
 * Puts a fresh bridge on `window.runova` and returns it. The renderer setup file calls this
 * before each test, and a test can call it again with its own answers.
 */
export function installRunovaBridge(overrides: BridgeOverrides = {}): FakeBridge {
  const bridge = createRunovaBridge(overrides);
  Object.defineProperty(window, 'runova', { value: bridge, configurable: true, writable: true });
  return bridge;
}

/** The bridge currently installed on the window. */
export function currentBridge(): FakeBridge {
  return window.runova as FakeBridge;
}
