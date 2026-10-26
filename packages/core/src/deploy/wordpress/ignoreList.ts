import { wpItemKey } from './pathPolicy.js';
import type { WpItemRef } from './protocol.js';

/**
 * The files and folders a user chose to leave out of a WordPress project's pulls and deploys
 * (E21), kept with the project's link. Each entry is a gitignore-like line, as in an
 * `.runovaignore`, relative to an item's root. They leave a path out both ways, whatever the
 * site has, so the site's copy is neither deleted nor pulled. The key `*` holds lines for every
 * item of the project; any other key is one item (`wpItemKey`).
 */

export const WP_IGNORE_ALL = '*';
export const WP_IGNORE_MAX_LINES = 500;
export const WP_IGNORE_MAX_LINE = 300;

/** Lines by key: `*` for every item, or `theme:slug` for one. */
export type WpIgnoreList = Record<string, string[]>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;

function cleanLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const line = entry.trim();
    if (line === '' || line.length > WP_IGNORE_MAX_LINE || CONTROL.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length === WP_IGNORE_MAX_LINES) break;
  }
  return lines;
}

/**
 * The list as read from disk or a renderer call: lines for `*` and for the project's own items,
 * trimmed, without repeats, within the caps. Undefined when nothing is left.
 */
export function normalizeWpIgnore(
  value: unknown,
  items: readonly WpItemRef[],
): WpIgnoreList | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const allowed = new Set([WP_IGNORE_ALL, ...items.map(wpItemKey)]);
  const out: WpIgnoreList = {};
  for (const [key, lines] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    const cleaned = cleanLines(lines);
    if (cleaned.length > 0) out[key] = cleaned;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The lines that apply to one item: those for every item first, then its own. */
export function wpIgnoreLinesFor(list: WpIgnoreList | undefined, item: WpItemRef): string[] {
  return [...(list?.[WP_IGNORE_ALL] ?? []), ...(list?.[wpItemKey(item)] ?? [])];
}

/** A new list with the lines added under the key; a line already there is not added again. */
export function withWpIgnore(
  list: WpIgnoreList | undefined,
  key: string,
  patterns: readonly string[],
): WpIgnoreList {
  return { ...list, [key]: cleanLines([...(list?.[key] ?? []), ...patterns]) };
}

/** A new list without the line; undefined when that leaves the whole list empty. */
export function withoutWpIgnore(
  list: WpIgnoreList | undefined,
  key: string,
  pattern: string,
): WpIgnoreList | undefined {
  if (!list?.[key]) return list;
  const { [key]: current, ...rest } = list;
  const left = current.filter((line) => line !== pattern);
  const next = left.length > 0 ? { ...rest, [key]: left } : rest;
  return Object.keys(next).length > 0 ? next : undefined;
}

const GLOB_CHARS = /[*?[\]\\]/g;

/**
 * The line that leaves out one path of an item, anchored to the item's root so a file of the same
 * name deeper down is kept. A folder ends in a slash and takes everything inside it. Characters
 * that mean something in a pattern are escaped, so the line names exactly that path. Null for a
 * path that cannot be said safely: empty or odd segments, control characters, a backslash, or a
 * name that starts with a space (a pattern is trimmed).
 */
export function ignorePatternForPath(path: string, kind: 'file' | 'folder'): string | null {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '' || CONTROL.test(trimmed) || trimmed.includes('\\')) return null;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment !== segment.trimStart()) return null;
  }
  const escaped = segments.map((segment) => segment.replace(GLOB_CHARS, '\\$&')).join('/');
  return `/${escaped}${kind === 'folder' ? '/' : ''}`;
}

const PLAIN_EXTENSION = /^[A-Za-z0-9_-]+$/;

/** `*.map` for `assets/app.js.map`: every file with that ending, at any depth. Null when it has none. */
export function ignorePatternForExtension(path: string): string | null {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1);
  return PLAIN_EXTENSION.test(extension) ? `*.${extension}` : null;
}
