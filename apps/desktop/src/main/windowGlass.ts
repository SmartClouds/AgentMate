import { release } from 'node:os';
import type { ThemeMode } from '@runova/core';
import { type BrowserWindowConstructorOptions, nativeTheme } from 'electron';

/** How the main window's frame is drawn: a native material, or the theme's solid color. */
export type WindowGlass = 'mica' | 'vibrancy' | 'none';

type GlassOptions = Pick<
  BrowserWindowConstructorOptions,
  'backgroundColor' | 'backgroundMaterial' | 'vibrancy' | 'visualEffectState'
>;

/**
 * Windows 11 22H2 (build 22621) is the first release where Electron's
 * `backgroundMaterial` paints a real material. Older Windows gets a CSS tint instead.
 */
export function supportsBackgroundMaterial(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(release().split('.')[2] ?? 0);
  return build >= 22621;
}

/** Mica on Windows 11, vibrancy on macOS, and the plain theme color everywhere else. */
export function mainWindowGlass(): WindowGlass {
  if (supportsBackgroundMaterial()) return 'mica';
  if (process.platform === 'darwin') return 'vibrancy';
  return 'none';
}

/**
 * The BrowserWindow options that put `glass` behind the page. Mica is never paired with
 * `transparent`: the material draws nothing on a transparent window, and a transparent
 * window can't be resized or maximized.
 */
export function glassWindowOptions(glass: WindowGlass, fallbackBackground: string): GlassOptions {
  switch (glass) {
    case 'mica':
      return { backgroundColor: '#00000000', backgroundMaterial: 'mica' };
    case 'vibrancy':
      return {
        backgroundColor: '#00000000',
        vibrancy: 'under-window',
        visualEffectState: 'active',
      };
    default:
      return { backgroundColor: fallbackBackground };
  }
}

/** The app theme last handed to applyWindowTheme, kept current by startup and the settings IPC. */
let windowTheme: ThemeMode = 'system';

function nativeThemeSource(theme: ThemeMode): 'system' | 'light' | 'dark' {
  if (theme === 'system' || theme === 'light') return theme;
  return 'dark';
}

/**
 * Mica's tint follows the window's native theme, not the CSS class on the page, so a light
 * app theme would otherwise sit on a dark tint (or the other way round).
 */
export function applyWindowTheme(theme: ThemeMode): void {
  windowTheme = theme;
  nativeTheme.themeSource = nativeThemeSource(theme);
}

export function currentWindowTheme(): ThemeMode {
  return windowTheme;
}

/**
 * The query the main window's page is loaded with. The page reads both before its first paint:
 * `glass` to let the material show through, and `theme` to put the right theme class on <html>.
 * Without `theme` the page painted light until its settings call came back, which on a busy
 * startup took seconds, all on top of an already dark Mica tint.
 */
export function mainWindowQuery(glass: WindowGlass, theme: ThemeMode): Record<string, string> {
  return { glass, theme };
}
