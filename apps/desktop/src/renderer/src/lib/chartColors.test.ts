import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useThemeStore } from '@/stores/themeStore';
import { readableAccent, useChartColors, useIsDarkMode } from './chartColors';

/** The cards the accents sit on, straight out of chartColors.ts. */
const SURFACE_DARK = '#1c1c1c';
const SURFACE_LIGHT = '#e8e8e8';

/**
 * An independent WCAG contrast check, so the assertions measure the result rather than
 * repeating the module is own maths.
 */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => void;
}

const media = {
  matches: false,
  listeners: new Set<(event: MediaQueryListEvent) => void>(),
  emit(matches: boolean): void {
    media.matches = matches;
    for (const listener of [...media.listeners]) {
      listener({ matches } as MediaQueryListEvent);
    }
  },
};

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  media.matches = false;
  media.listeners.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): FakeMediaQueryList => ({
      get matches() {
        return media.matches;
      },
      media: query,
      addEventListener: (_type, listener) => media.listeners.add(listener),
      removeEventListener: (_type, listener) => media.listeners.delete(listener),
    }),
  });
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: realMatchMedia,
  });
});

describe('readableAccent', () => {
  it('leaves a brand colour that already reads on the card exactly as the vendor set it', () => {
    // The recognizable brand colors are the point, so anything with enough contrast is untouched.
    expect(readableAccent('#00ad57', true)).toBe('#00ad57');
    expect(readableAccent('#994b00', false)).toBe('#994b00');
  });

  it('lightens a near-black accent until it reads on the dark card', () => {
    // A third of the usage providers ship #000000 or #111111, which vanish on the dark surface.
    const accent = readableAccent('#000000', true);
    expect(accent).not.toBe('#000000');
    expect(contrast(accent, SURFACE_DARK)).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens a neon accent until it reads on the light card', () => {
    const accent = readableAccent('#00ff9c', false);
    expect(accent).not.toBe('#00ff9c');
    expect(contrast(accent, SURFACE_LIGHT)).toBeGreaterThanOrEqual(4.5);
  });

  it('fixes the same accent differently per theme', () => {
    expect(readableAccent('#111111', true)).not.toBe(readableAccent('#111111', false));
  });

  it('accepts a three digit hex and a missing hash', () => {
    expect(readableAccent('#fff', true)).toBe('#fff');
    expect(contrast(readableAccent('000', true), SURFACE_DARK)).toBeGreaterThanOrEqual(4.5);
  });

  it('hands back anything it cannot read as a colour, untouched', () => {
    expect(readableAccent('rebeccapurple', true)).toBe('rebeccapurple');
    expect(readableAccent('', false)).toBe('');
    expect(readableAccent('#12345', true)).toBe('#12345');
  });

  it('answers the same on every call, since the result is cached per theme', () => {
    expect(readableAccent('#0b0b0b', true)).toBe(readableAccent('#0b0b0b', true));
  });

  it('always answers with something a stylesheet can use', () => {
    for (const input of ['#000000', '#ffffff', '#ff0000', '#0000ff', '#808080']) {
      for (const isDark of [true, false]) {
        expect(readableAccent(input, isDark)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe('useIsDarkMode', () => {
  it('follows an explicitly chosen theme, whatever the system is set to', () => {
    useThemeStore.setState({ theme: 'light' });
    expect(renderHook(() => useIsDarkMode()).result.current).toBe(false);
    useThemeStore.setState({ theme: 'dark' });
    expect(renderHook(() => useIsDarkMode()).result.current).toBe(true);
  });

  it('counts the editor themes as dark, since they only vary the dark palette', () => {
    useThemeStore.setState({ theme: 'vscode-dark' });
    expect(renderHook(() => useIsDarkMode()).result.current).toBe(true);
    useThemeStore.setState({ theme: 'vs2026' });
    expect(renderHook(() => useIsDarkMode()).result.current).toBe(true);
  });

  it('reads the system preference when the theme is "system"', () => {
    useThemeStore.setState({ theme: 'system' });
    media.matches = true;
    expect(renderHook(() => useIsDarkMode()).result.current).toBe(true);
  });

  it('repaints when the system flips to dark while the app is open', () => {
    useThemeStore.setState({ theme: 'system' });
    const { result } = renderHook(() => useIsDarkMode());
    expect(result.current).toBe(false);
    act(() => media.emit(true));
    expect(result.current).toBe(true);
  });

  it('stops listening once the component is gone', () => {
    const { unmount } = renderHook(() => useIsDarkMode());
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });
});

describe('useChartColors', () => {
  it('hands out the light palette in light mode and the dark one in dark mode', () => {
    useThemeStore.setState({ theme: 'light' });
    const light = renderHook(() => useChartColors()).result.current;
    useThemeStore.setState({ theme: 'dark' });
    const dark = renderHook(() => useChartColors()).result.current;
    expect(light.categorical).not.toEqual(dark.categorical);
  });

  it('names the first two slots, which are the brand hues', () => {
    useThemeStore.setState({ theme: 'dark' });
    const { green, blue, categorical } = renderHook(() => useChartColors()).result.current;
    expect(green).toBe(categorical[0]);
    expect(blue).toBe(categorical[1]);
  });

  it('keeps the temperature accent out of the categorical set, per theme', () => {
    for (const theme of ['light', 'dark'] as const) {
      useThemeStore.setState({ theme });
      const { temperature, categorical } = renderHook(() => useChartColors()).result.current;
      expect(temperature).toMatch(/^#[0-9a-f]{6}$/);
      // Drawn over the per-core lines, so it must not match any of them.
      expect(categorical).not.toContain(temperature);
    }
    useThemeStore.setState({ theme: 'light' });
    const light = renderHook(() => useChartColors()).result.current.temperature;
    useThemeStore.setState({ theme: 'dark' });
    const dark = renderHook(() => useChartColors()).result.current.temperature;
    expect(light).not.toBe(dark);
  });

  it('gives a full eight distinct slots, so a chart never repeats a colour', () => {
    for (const theme of ['light', 'dark'] as const) {
      useThemeStore.setState({ theme });
      const { categorical } = renderHook(() => useChartColors()).result.current;
      expect(categorical).toHaveLength(8);
      expect(new Set(categorical).size).toBe(8);
      for (const color of categorical) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
