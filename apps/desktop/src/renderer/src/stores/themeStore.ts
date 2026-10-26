import { isThemeMode, type ThemeMode } from '@runova/core';
import { create } from 'zustand';

interface ThemeState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

export type ResolvedTheme = Exclude<ThemeMode, 'system'>;

export function resolveTheme(theme: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light';
  return theme;
}

/** The `<html>` classes a resolved theme applies. `.dark` alone drives Tailwind's `dark:`
 * variant and every existing boolean ("is this dark?") consumer; the second class only
 * scopes the CSS variable overrides specific to that theme (see index.css). */
export function themeClassName(resolved: ResolvedTheme): string {
  switch (resolved) {
    case 'light':
      return '';
    case 'dark':
      return 'dark';
    case 'vscode-dark':
      return 'dark theme-vscode-dark';
    case 'vs2026':
      return 'dark theme-vs2026';
  }
}

export function resolveIsDark(theme: ThemeMode, systemPrefersDark: boolean): boolean {
  return resolveTheme(theme, systemPrefersDark) !== 'light';
}

function applyThemeClass(theme: ThemeMode): void {
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = resolveTheme(theme, systemPrefersDark);
  const root = document.documentElement;
  root.classList.remove('dark', 'theme-vscode-dark', 'theme-vs2026');
  const next = themeClassName(resolved);
  if (next) root.classList.add(...next.split(' '));
}

function themeIn(query: string): ThemeMode | undefined {
  const theme = new URLSearchParams(query).get('theme');
  return isThemeMode(theme) ? theme : undefined;
}

/**
 * The theme main put on the window's URL. The main window has it in the real query (see
 * mainWindowQuery in src/main/windowGlass.ts); a window that opens on a route, like the SFTP
 * pop-out (`#/sftp-window?...&theme=`), has it in the query inside the hash. Other windows load
 * without one.
 */
export function themeFromSearch(search: string, hash = ''): ThemeMode | undefined {
  const inHash = hash.indexOf('?');
  return themeIn(search) ?? (inHash >= 0 ? themeIn(hash.slice(inHash)) : undefined);
}

/**
 * Puts the theme class on <html> before React renders, so the first frame already matches the
 * window's native tint. initTheme still runs afterwards and re-applies the same classes from
 * settings, which changes nothing on screen.
 */
export function applyInitialTheme(search: string, hash = ''): void {
  const theme = themeFromSearch(search, hash);
  if (!theme) return;
  applyThemeClass(theme);
  useThemeStore.setState({ theme });
}

/**
 * Keeps the URL's theme in step with a change made here, so reloading the page (the error
 * screen's Reload button) starts on the theme in use rather than the one the window opened with.
 */
function syncThemeInUrl(theme: ThemeMode): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('theme')) return;
  url.searchParams.set('theme', theme);
  window.history.replaceState(window.history.state, '', url);
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: 'system',
  setTheme: (theme) => {
    applyThemeClass(theme);
    syncThemeInUrl(theme);
    set({ theme });
    void window.runova.settings.update({ theme });
  },
}));

export async function initTheme(): Promise<void> {
  const settings = await window.runova.settings.get();
  applyThemeClass(settings.theme);
  useThemeStore.setState({ theme: settings.theme });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useThemeStore.getState().theme === 'system') applyThemeClass('system');
  });
}
