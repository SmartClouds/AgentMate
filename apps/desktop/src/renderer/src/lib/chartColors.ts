import { useEffect, useState } from 'react';
import { resolveIsDark, useThemeStore } from '@/stores/themeStore';

// Fixed hex steps (not the `--primary`/`--card` CSS vars) because these
// colors must hold a validated CVD-safe categorical order when several show
// up together on one chart. The live `--primary` dark value is a hue step
// brighter than the chart lightness band allows. Slots 1-2 (green/blue) match
// the app's brand hue; slots 3-8 are the dataviz skill's reference
// categorical order. Re-validated as a full 8-slot set via validate_palette.js.
const CATEGORICAL_LIGHT = [
  '#00994d', // green (brand)
  '#2a78d6', // blue
  '#e87ba4', // magenta
  '#eda100', // yellow
  '#1baf7a', // aqua
  '#eb6834', // orange
  '#4a3aa7', // violet
  '#e34948', // red
];

const CATEGORICAL_DARK = [
  '#00ad57', // green (brand)
  '#3987e5', // blue
  '#d55181', // magenta
  '#c98500', // yellow
  '#199e70', // aqua
  '#d95926', // orange
  '#9085e9', // violet
  '#e66767', // red
];

// A single accent for the temperature line drawn over the CPU chart, outside the categorical set
// above (the per-core view already uses every slot of it). A hot red-orange, dashed where it is
// drawn, so it still reads apart from the orange and red cores.
const TEMPERATURE_LIGHT = '#c4320a';
const TEMPERATURE_DARK = '#ff7f50';

export function useIsDarkMode(): boolean {
  const theme = useThemeStore((s) => s.theme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return resolveIsDark(theme, systemDark);
}

export function useChartColors(): {
  green: string;
  blue: string;
  temperature: string;
  categorical: string[];
} {
  const isDark = useIsDarkMode();
  const categorical = isDark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
  return {
    green: categorical[0],
    blue: categorical[1],
    temperature: isDark ? TEMPERATURE_DARK : TEMPERATURE_LIGHT,
    categorical,
  };
}

/* ------------------------------------------------------------------------ */
/* Brand accents made readable per theme                                     */
/* ------------------------------------------------------------------------ */

/* Provider accents come from the usage registry as the vendor's own brand hex,
   so a chunk of them (#000000 OpenAI/Copilot/Grok, #111111 Kimi/Ollama/…) are
   near-black and disappear on the dark surface, and a few neons wash out on the
   light one. Rather than hand-pick 63 dark steps, the brand hue is kept and only
   its OKLCH lightness is moved until it clears text contrast against the mode's
   card. Accents that already clear it are returned untouched, so the recognizable
   brand colors stay exactly as the vendor specifies them. */

/** The card the accents sit on, per mode: hsl(var(--card)) from index.css. */
const SURFACE_DARK = '#1c1c1c';
const SURFACE_LIGHT = '#e8e8e8';
/* Accents paint small text (cost, percent) as well as bars and the sparkline,
   so this is the WCAG normal-text ratio, not the 3:1 for marks alone. */
const MIN_CONTRAST = 4.5;

interface Rgb {
  /** 0-1, gamma-encoded sRGB. */
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match) return null;
  const digits =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : match[1];
  const value = Number.parseInt(digits, 16);
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const channel = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** sRGB → OKLCH (lightness 0-1, chroma, hue in radians). */
function toOklch({ r, g, b }: Rgb): { l: number; c: number; h: number } {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: okL, c: Math.hypot(okA, okB), h: Math.atan2(okB, okA) };
}

function fromOklch(l: number, c: number, h: number): { rgb: Rgb; inGamut: boolean } {
  const a = Math.cos(h) * c;
  const b = Math.sin(h) * c;
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lr = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  const lg = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  const lb = -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc;
  const inGamut = [lr, lg, lb].every((v) => v >= -0.001 && v <= 1.001);
  return { rgb: { r: toGamma(lr), g: toGamma(lg), b: toGamma(lb) }, inGamut };
}

/** Same hue at a new lightness, desaturating only as far as the gamut forces. */
function atLightness(l: number, c: number, h: number): Rgb {
  let chroma = c;
  for (let i = 0; i < 24; i++) {
    const { rgb, inGamut } = fromOklch(l, chroma, h);
    if (inGamut || chroma <= 0.001) return rgb;
    chroma *= 0.9;
  }
  return fromOklch(l, 0, h).rgb;
}

const accentCache = new Map<string, string>();

/**
 * A provider's brand accent, adjusted to stay legible in the given theme:
 * lightened in dark mode, darkened in light mode, and left alone whenever the
 * brand color already reads against that mode's card.
 */
export function readableAccent(hex: string, isDark: boolean): string {
  const cacheKey = `${hex}|${isDark ? 'd' : 'l'}`;
  const cached = accentCache.get(cacheKey);
  if (cached) return cached;

  const rgb = parseHex(hex);
  const surface = parseHex(isDark ? SURFACE_DARK : SURFACE_LIGHT);
  if (!rgb || !surface) return hex;

  let result = hex;
  if (contrastRatio(rgb, surface) < MIN_CONTRAST) {
    const { l, c, h } = toOklch(rgb);
    const step = isDark ? 0.02 : -0.02;
    for (let i = 1; i <= 50; i++) {
      const nextL = Math.min(1, Math.max(0, l + step * i));
      const candidate = atLightness(nextL, c, h);
      result = toHex(candidate);
      if (contrastRatio(candidate, surface) >= MIN_CONTRAST) break;
      if (nextL <= 0 || nextL >= 1) break;
    }
  }

  accentCache.set(cacheKey, result);
  return result;
}

/** `readableAccent` for the theme currently on screen. */
export function useReadableAccent(hex: string): string {
  return readableAccent(hex, useIsDarkMode());
}
