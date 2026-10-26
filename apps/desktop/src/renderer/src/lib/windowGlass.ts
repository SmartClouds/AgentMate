export type WindowGlass = 'mica' | 'vibrancy';

/**
 * Reads the material main put under the window (see src/main/windowGlass.ts) from the page URL.
 * Only the main window gets the parameter. Widgets, the pet and session windows load without it
 * and stay opaque, and so does `none` (Windows 10, Linux).
 */
export function windowGlassFromSearch(search: string): WindowGlass | undefined {
  const glass = new URLSearchParams(search).get('glass');
  return glass === 'mica' || glass === 'vibrancy' ? glass : undefined;
}

/**
 * Marks <html> with data-glass before the first paint, so index.css can let the native material
 * show through the window chrome from the very first frame.
 */
export function applyWindowGlass(root: HTMLElement, search: string): void {
  const glass = windowGlassFromSearch(search);
  if (glass) root.dataset.glass = glass;
}

/** The part of the preload bridge (`window.runova.window`) that reports the window's focus. */
export interface WindowFocusSource {
  isFocused(): Promise<boolean>;
  onFocusChange(callback: (isFocused: boolean) => void): () => void;
}

/** Marks <html> with data-window-inactive while another window is in front. */
export function setWindowInactive(root: HTMLElement, inactive: boolean): void {
  if (inactive) root.dataset.windowInactive = '';
  else delete root.dataset.windowInactive;
}

/**
 * Windows swaps Mica for a flat neutral fill while the window is inactive, so index.css repaints
 * the see-through chrome in the theme's own colors until focus comes back. Only a Mica window
 * needs this: macOS vibrancy is kept active, and opaque windows never change. Returns the
 * unsubscribe.
 */
export function trackWindowFocus(
  root: HTMLElement,
  source: WindowFocusSource | undefined,
): () => void {
  if (root.dataset.glass !== 'mica' || !source) return () => undefined;

  // A focus change can land before the first answer does, and it is the newer of the two.
  let heard = false;
  const unsubscribe = source.onFocusChange((focused) => {
    heard = true;
    setWindowInactive(root, !focused);
  });
  source
    .isFocused()
    .then((focused) => {
      if (!heard && typeof focused === 'boolean') setWindowInactive(root, !focused);
    })
    .catch(() => undefined);
  return unsubscribe;
}
