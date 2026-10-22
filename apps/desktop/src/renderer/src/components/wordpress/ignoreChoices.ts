import type { WpIgnoreList, WpItemRef } from '@agentmat/core';
import {
  ignorePatternForExtension,
  ignorePatternForPath,
  WP_IGNORE_ALL,
  withWpIgnore,
  wpItemKey,
} from '@agentmat/core';

/**
 * What a user can leave out of a WordPress deploy by picking things in the review (E21), and how
 * the saved lines read back. The lines themselves are built in core (`ignorePatternForPath`), so
 * a name with a `[` or a `*` in it is still matched as exactly that name.
 */

export interface IgnoreChoice {
  id: string;
  label: string;
  /** Where the line is kept: `*` for every item, or the item's key. */
  key: string;
  pattern: string;
}

export interface IgnoreAddition {
  key: string;
  patterns: string[];
}

const KIND_NOUN: Record<WpItemRef['kind'], string> = {
  theme: 'theme',
  plugin: 'plugin',
  'mu-plugin': 'must-use plugin',
};

/** A single-file plugin has one path, its own name, and ignoring it would leave nothing. */
function isOnlyFile(item: WpItemRef, path: string): boolean {
  return item.kind !== 'theme' && path === item.slug && /\.php$/i.test(item.slug);
}

/** The folders above a path, top down. A deep path keeps the top folder and the two nearest. */
function folderChoices(path: string): string[] {
  const segments = path.split('/').slice(0, -1);
  const folders = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
  return folders.length <= 3 ? folders : [folders[0], ...folders.slice(-2)];
}

/**
 * The ways to leave out a changed file: the file, a folder above it, every file with its ending
 * (in this item or in all of them). Empty when the path cannot be said safely, or when it is the
 * only file of its item.
 */
export function ignoreChoicesFor(item: WpItemRef, path: string): IgnoreChoice[] {
  if (isOnlyFile(item, path)) return [];
  const file = ignorePatternForPath(path, 'file');
  if (file === null) return [];
  const key = wpItemKey(item);
  const choices: IgnoreChoice[] = [{ id: 'file', label: 'Ignore this file', key, pattern: file }];
  for (const folder of folderChoices(path)) {
    const pattern = ignorePatternForPath(folder, 'folder');
    if (pattern) {
      choices.push({
        id: `folder:${folder}`,
        label: `Ignore the folder ${folder}/`,
        key,
        pattern,
      });
    }
  }
  const extension = ignorePatternForExtension(path);
  if (extension) {
    const ending = extension.slice(1);
    choices.push(
      {
        id: 'extension',
        label: `Ignore every ${ending} file in this ${KIND_NOUN[item.kind]}`,
        key,
        pattern: extension,
      },
      {
        id: 'extension:all',
        label: `Ignore every ${ending} file in every theme and plugin`,
        key: WP_IGNORE_ALL,
        pattern: extension,
      },
    );
  }
  return choices;
}

/** One anchored line per picked file, grouped by item in the order they were first picked. */
export function linesForFiles(
  files: readonly { item: WpItemRef; path: string }[],
): IgnoreAddition[] {
  const byKey = new Map<string, string[]>();
  for (const { item, path } of files) {
    if (isOnlyFile(item, path)) continue;
    const pattern = ignorePatternForPath(path, 'file');
    if (pattern === null) continue;
    const key = wpItemKey(item);
    const patterns = byKey.get(key) ?? [];
    if (!patterns.includes(pattern)) patterns.push(pattern);
    byKey.set(key, patterns);
  }
  return [...byKey].map(([key, patterns]) => ({ key, patterns }));
}

/** The saved list with the new lines added. */
export function addIgnoreLines(
  list: WpIgnoreList | undefined,
  additions: readonly IgnoreAddition[],
): WpIgnoreList {
  let next = list;
  for (const { key, patterns } of additions) next = withWpIgnore(next, key, patterns);
  return next ?? {};
}

export interface IgnoreRow {
  /** `all`, or the item's key. */
  scope: string;
  /** Where the line is kept in the saved list: `*` or the item's key. */
  key: string;
  item: WpItemRef | null;
  pattern: string;
  kind: 'folder' | 'file' | 'pattern';
  /** The line as a person reads it: no leading slash, no escapes. */
  label: string;
}

const unescapeLine = (text: string): string => text.replace(/\\(.)/g, '$1');
const hasGlob = (text: string): boolean => /[*?[]/.test(text.replace(/\\./g, ''));

function describeLine(pattern: string): Pick<IgnoreRow, 'kind' | 'label'> {
  if (!pattern.startsWith('!') && pattern.startsWith('/') && !hasGlob(pattern)) {
    if (pattern.length > 1 && pattern.endsWith('/') && !pattern.endsWith('\\/')) {
      return { kind: 'folder', label: `${unescapeLine(pattern.slice(1, -1))}/` };
    }
    if (pattern.length > 1) return { kind: 'file', label: unescapeLine(pattern.slice(1)) };
  }
  return { kind: 'pattern', label: pattern };
}

/** The saved list as rows: lines for every item first, then each of the project's items in order. */
export function ignoreRows(
  list: WpIgnoreList | undefined,
  items: readonly WpItemRef[],
): IgnoreRow[] {
  if (!list) return [];
  const rows: IgnoreRow[] = [];
  for (const pattern of list[WP_IGNORE_ALL] ?? []) {
    rows.push({ scope: 'all', key: WP_IGNORE_ALL, item: null, pattern, ...describeLine(pattern) });
  }
  for (const item of items) {
    const key = wpItemKey(item);
    for (const pattern of list[key] ?? []) {
      rows.push({ scope: key, key, item, pattern, ...describeLine(pattern) });
    }
  }
  return rows;
}

/** One sentence for a toast: what was ignored, and where. */
export function ignoreSummary(additions: readonly IgnoreAddition[]): string {
  const lines = additions.flatMap(({ key, patterns }) =>
    patterns.map((pattern) => ({ key, ...describeLine(pattern) })),
  );
  const keys = new Set(additions.filter((entry) => entry.patterns.length > 0).map((e) => e.key));
  const where =
    keys.size > 1
      ? `${keys.size} themes and plugins`
      : (() => {
          const [key] = [...keys];
          return key === WP_IGNORE_ALL
            ? 'every theme and plugin'
            : (key ?? '').split(':').slice(1).join(':');
        })();
  if (lines.length === 1 && lines[0].kind !== 'file')
    return `Ignored ${lines[0].label} in ${where}.`;
  const files = lines.every((line) => line.kind === 'file');
  const noun = files
    ? lines.length === 1
      ? 'file'
      : 'files'
    : lines.length === 1
      ? 'entry'
      : 'entries';
  return `Ignored ${lines.length} ${noun} in ${where}.`;
}
