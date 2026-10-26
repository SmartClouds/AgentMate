import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyWindowGlass,
  setWindowInactive,
  trackWindowFocus,
  windowGlassFromSearch,
} from './windowGlass';

describe('windowGlassFromSearch', () => {
  it('reads the materials main can put under the window', () => {
    expect(windowGlassFromSearch('?glass=mica')).toBe('mica');
    expect(windowGlassFromSearch('?glass=vibrancy')).toBe('vibrancy');
  });

  it('ignores none, a missing parameter and anything unexpected', () => {
    expect(windowGlassFromSearch('?glass=none')).toBeUndefined();
    expect(windowGlassFromSearch('')).toBeUndefined();
    expect(windowGlassFromSearch('?theme=dark')).toBeUndefined();
    expect(windowGlassFromSearch('?glass=acrylic')).toBeUndefined();
  });
});

describe('applyWindowGlass', () => {
  const root = document.documentElement;

  afterEach(() => {
    delete root.dataset.glass;
  });

  it('marks <html> when the window sits on mica', () => {
    applyWindowGlass(root, '?glass=mica');
    expect(root.dataset.glass).toBe('mica');
    expect(root.getAttribute('data-glass')).toBe('mica');
  });

  it('leaves <html> unmarked for none', () => {
    applyWindowGlass(root, '?glass=none');
    expect(root.hasAttribute('data-glass')).toBe(false);
  });

  it('leaves <html> unmarked when the window loads without the parameter', () => {
    applyWindowGlass(root, '');
    expect(root.hasAttribute('data-glass')).toBe(false);
  });
});

/** A stand-in for `window.runova.window` whose focus answer and change events the test drives. */
function fakeFocusSource(answer: Promise<boolean>) {
  const listeners: ((focused: boolean) => void)[] = [];
  return {
    isFocused: vi.fn(() => answer),
    onFocusChange: vi.fn((callback: (focused: boolean) => void) => {
      listeners.push(callback);
      return () => {
        listeners.splice(listeners.indexOf(callback), 1);
      };
    }),
    emit: (focused: boolean) => {
      for (const listener of [...listeners]) listener(focused);
    },
    listenerCount: () => listeners.length,
  };
}

describe('setWindowInactive', () => {
  const root = document.documentElement;

  afterEach(() => {
    delete root.dataset.windowInactive;
  });

  it('adds and removes the marker index.css keys the inactive look on', () => {
    setWindowInactive(root, true);
    expect(root.hasAttribute('data-window-inactive')).toBe(true);

    setWindowInactive(root, false);
    expect(root.hasAttribute('data-window-inactive')).toBe(false);
  });
});

describe('trackWindowFocus', () => {
  const root = document.documentElement;

  afterEach(() => {
    delete root.dataset.glass;
    delete root.dataset.windowInactive;
  });

  it('follows focus changes on a mica window', async () => {
    root.dataset.glass = 'mica';
    const source = fakeFocusSource(Promise.resolve(true));

    trackWindowFocus(root, source);
    await Promise.resolve();
    expect(root.hasAttribute('data-window-inactive')).toBe(false);

    source.emit(false);
    expect(root.hasAttribute('data-window-inactive')).toBe(true);

    source.emit(true);
    expect(root.hasAttribute('data-window-inactive')).toBe(false);
  });

  it('starts inactive when the page loads behind another window', async () => {
    root.dataset.glass = 'mica';

    trackWindowFocus(root, fakeFocusSource(Promise.resolve(false)));

    await vi.waitFor(() => expect(root.hasAttribute('data-window-inactive')).toBe(true));
  });

  it('lets a focus change that beats the first answer win', async () => {
    root.dataset.glass = 'mica';
    let answer: (focused: boolean) => void = () => undefined;
    const source = fakeFocusSource(new Promise<boolean>((resolve) => (answer = resolve)));

    trackWindowFocus(root, source);
    source.emit(true);
    // The stale answer was asked for before the window came to the front.
    answer(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(root.hasAttribute('data-window-inactive')).toBe(false);
  });

  it('stops listening when unsubscribed', () => {
    root.dataset.glass = 'mica';
    const source = fakeFocusSource(Promise.resolve(true));

    const stop = trackWindowFocus(root, source);
    expect(source.listenerCount()).toBe(1);
    stop();

    expect(source.listenerCount()).toBe(0);
  });

  it('leaves vibrancy, opaque windows and a missing bridge alone', () => {
    const source = fakeFocusSource(Promise.resolve(false));

    // macOS keeps its vibrancy active, and an opaque window looks the same either way.
    root.dataset.glass = 'vibrancy';
    trackWindowFocus(root, source);
    delete root.dataset.glass;
    trackWindowFocus(root, source);
    root.dataset.glass = 'mica';
    trackWindowFocus(root, undefined);

    expect(source.onFocusChange).not.toHaveBeenCalled();
    expect(source.isFocused).not.toHaveBeenCalled();
    expect(root.hasAttribute('data-window-inactive')).toBe(false);
  });
});
