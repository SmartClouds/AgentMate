export type Theme = 'dark' | 'light';

/** The localStorage key that remembers the visitor's choice (design.md). */
export const THEME_STORAGE_KEY = 'runova-theme';

/** The stored choice wins; without one the site follows prefers-color-scheme, and Dark is the default. */
export function resolveTheme(stored: string | null, prefersLight: boolean): Theme {
  if (stored === 'dark' || stored === 'light') return stored;
  return prefersLight ? 'light' : 'dark';
}

export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/**
 * Runs inline in <head> before the first paint, so the page never flashes the wrong theme. It is a
 * plain string (no imports) because it ships as an inline script; the logic matches resolveTheme.
 */
export const themeInitScript = `(function () {
  var stored = null;
  try { stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}); } catch (e) {}
  var theme = stored === 'dark' || stored === 'light' ? stored
    : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  var root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
})();`;
