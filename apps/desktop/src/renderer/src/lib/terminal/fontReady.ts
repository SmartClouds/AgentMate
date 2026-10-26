import vazirmatnArabicUrl from '@fontsource-variable/vazirmatn/files/vazirmatn-arabic-wght-normal.woff2?url';

/**
 * xterm measures its character cell once, when it opens. If the terminal font is still
 * loading at that moment it measures a narrower fallback, the fit sizes the grid for those
 * cells, and once the real font lands every row runs past the right edge (a TUI's right-aligned
 * text and borders get cut off). Waiting for the font first, and refitting whenever fonts
 * finish loading later, keeps the grid matched to what is actually drawn.
 */

/** The face terminals ask for first; the fallbacks need no waiting. */
const TERMINAL_FONT = "13px 'Cascadia Code'";

let ready: Promise<void> | null = null;

export function whenTerminalFontReady(): Promise<void> {
  ready ??= (async () => {
    try {
      await document.fonts?.load(TERMINAL_FONT);
      await document.fonts?.ready;
    } catch {
      // A font that fails to load leaves the fallback, which measures correctly anyway.
    }
  })();
  return ready;
}

/**
 * The face terminals use for Persian and Arabic letters. It covers those letters only, so it can
 * sit first in the terminal's font list without touching how Latin text, borders or symbols look.
 */
export const TERMINAL_RTL_FONT = 'Runova Terminal RTL';

// The Arabic block and its supplements and presentation forms, plus the zero-width non-joiner
// and joiner, which have to come from the same face as the letters around them.
const TERMINAL_RTL_RANGE =
  'U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, ' +
  'U+200C-200E, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC';

let rtlFontAdded = false;

/**
 * Registers Vazirmatn (the face the rest of the app already uses for Persian) under
 * TERMINAL_RTL_FONT. Monospace fonts either lack these letters or draw them cramped into one
 * cell each; the terminal lays Persian out as joined runs, so a proper text face reads best.
 */
export function addTerminalRtlFont(): void {
  if (rtlFontAdded || typeof FontFace === 'undefined' || !document.fonts?.add) return;
  rtlFontAdded = true;
  document.fonts.add(
    new FontFace(TERMINAL_RTL_FONT, `url(${vazirmatnArabicUrl}) format('woff2')`, {
      weight: '100 900',
      display: 'swap',
      unicodeRange: TERMINAL_RTL_RANGE,
    }),
  );
}

/** Runs `refit` whenever the page finishes loading fonts. Returns a cleanup. */
export function onFontsLoaded(refit: () => void): () => void {
  const fonts = document.fonts;
  if (!fonts) return () => undefined;
  const handler = (): void => refit();
  fonts.addEventListener('loadingdone', handler);
  return () => fonts.removeEventListener('loadingdone', handler);
}
