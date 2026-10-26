import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { installRunovaBridge } from './runovaBridge';
import { resetAllStoresAsync } from './stores';

/**
 * Runs before every renderer test file: jsdom has no layout engine and none of the browser APIs
 * Radix, xterm and the charts reach for, so they get stubs here rather than in each test.
 *
 * A file can opt out of the DOM with `// @vitest-environment node` (some of the lib tests do,
 * since they replace `window` wholesale), which is why everything below is guarded.
 */

const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';

class ResizeObserverStub {
  observe(): void {
    return undefined;
  }
  unobserve(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
}

class IntersectionObserverStub {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: number[] = [];
  observe(): void {
    return undefined;
  }
  unobserve(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
  takeRecords(): [] {
    return [];
  }
}

if (hasDom) {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);

  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }

  // Radix menus, selects and dialogs call these on the elements they open.
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  if (!Element.prototype.animate) {
    Object.defineProperty(Element.prototype, 'animate', {
      writable: true,
      value: () => ({
        finished: Promise.resolve(),
        cancel: () => undefined,
        play: () => undefined,
      }),
    });
  }

  // jsdom prints a "not implemented" error for canvas unless the optional native package is
  // installed. Charts and the terminal only need it to not throw.
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;

  if (!URL.createObjectURL) {
    URL.createObjectURL = () => 'blob:runova-test';
    URL.revokeObjectURL = () => undefined;
  }

  // Always a spy, even where jsdom provides its own clipboard: tests assert on what was copied,
  // and jsdom's implementation needs a user gesture and a secure context.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => ''),
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => []),
    },
  });
}

beforeEach(async () => {
  if (!hasDom) return;
  installRunovaBridge();
  // Awaited rather than fired off: the store modules load on first use, and a test that runs
  // before that finished would inherit the previous test's state.
  await resetAllStoresAsync();
});

afterEach(async () => {
  if (hasDom) {
    cleanup();
    await resetAllStoresAsync();
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // A storage-less environment is fine; nothing to clear.
    }
  }
  vi.useRealTimers();
  vi.clearAllMocks();
});
