import type { SftpLocalEntry, SftpRemoteEntry } from '@shared/sftpTypes';
import { formatBytes } from '@/lib/format';
import type { ModeKind } from './mode';

/**
 * Listing helpers for the SFTP file manager's panes (E25): sorting, the hidden and text filters,
 * the footer summary and the date columns. One pane shows either side, so everything here takes
 * an entry of either kind.
 */

export type PaneEntry = SftpLocalEntry | SftpRemoteEntry;

export type SortKey = 'name' | 'size' | 'mtime' | 'mode' | 'owner';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDirection;
}

export const DEFAULT_SORT: SortState = { key: 'name', dir: 'asc' };

/** Natural order: `file2` before `file10`, case ignored, accents kept apart. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function isRemoteEntry(entry: PaneEntry): entry is SftpRemoteEntry {
  return 'kind' in entry;
}

function compareNames(a: PaneEntry, b: PaneEntry): number {
  return COLLATOR.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function compareBy(key: SortKey, a: PaneEntry, b: PaneEntry): number {
  switch (key) {
    case 'size':
      return a.size - b.size;
    case 'mtime':
      return a.mtimeMs - b.mtimeMs;
    case 'mode':
      return (a.mode ?? -1) - (b.mode ?? -1);
    case 'owner': {
      const left = isRemoteEntry(a) ? (a.owner ?? '') : '';
      const right = isRemoteEntry(b) ? (b.owner ?? '') : '';
      return COLLATOR.compare(left, right);
    }
    default:
      return 0;
  }
}

/**
 * A sorted copy. Folders always come first, whichever way the sort runs, and rows that tie on
 * the sort key fall back to the name so the order never jumps between refreshes.
 */
export function sortEntries<E extends PaneEntry>(entries: readonly E[], sort: SortState): E[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    const primary = sort.key === 'name' ? 0 : compareBy(sort.key, a, b);
    return sign * (primary || compareNames(a, b));
  });
}

/**
 * Hidden on the server means a dot file. Here it is what main flagged: dot files on macOS and
 * Linux, the hidden attribute and `desktop.ini` on Windows.
 */
export function isHiddenEntry(entry: PaneEntry): boolean {
  return isRemoteEntry(entry) ? entry.name.startsWith('.') : entry.hidden;
}

export interface ViewOptions {
  sort: SortState;
  /** Matched against the name, case ignored. Blank shows everything. */
  filter: string;
  showHidden: boolean;
}

/** What the pane draws: hidden entries and filter misses taken out, the rest sorted. */
export function visibleEntries<E extends PaneEntry>(entries: readonly E[], view: ViewOptions): E[] {
  const needle = view.filter.trim().toLocaleLowerCase();
  const kept = entries.filter(
    (entry) =>
      (view.showHidden || !isHiddenEntry(entry)) &&
      (needle === '' || entry.name.toLocaleLowerCase().includes(needle)),
  );
  return sortEntries(kept, view.sort);
}

/** The first letter `formatMode` shows: `l` for any link, working or broken. */
export function entryModeKind(entry: PaneEntry): ModeKind {
  if (entry.isSymlink) return 'link';
  if (isRemoteEntry(entry)) return entry.kind;
  return entry.isDirectory ? 'dir' : 'file';
}

/** The pane footer: `3 of 42 selected, 12.4 MB`, or `42 items` with nothing selected. */
export function selectionSummary(
  entries: readonly PaneEntry[],
  selected: ReadonlySet<string>,
): string {
  const total = entries.length;
  const picked = entries.filter((entry) => selected.has(entry.name));
  if (picked.length === 0) return `${total} ${total === 1 ? 'item' : 'items'}`;
  const bytes = picked.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size), 0);
  const base = `${picked.length} of ${total} selected`;
  return bytes > 0 ? `${base}, ${formatBytes(bytes)}` : base;
}

const SHORT_SAME_YEAR = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const SHORT_OTHER_YEAR = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

/** The Modified column: `Oct 19, 14:02` this year, `Mar 3, 2024` before. Blank for no date. */
export function formatShortDate(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  return date.getFullYear() === new Date(now).getFullYear()
    ? SHORT_SAME_YEAR.format(date)
    : SHORT_OTHER_YEAR.format(date);
}

/** The Modified column's tooltip. */
export function formatFullDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return FULL.format(new Date(ms));
}
