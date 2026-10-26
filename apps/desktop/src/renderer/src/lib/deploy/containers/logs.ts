import type { ContainerLogLine } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * A container's log on screen (E06 T8): the lines kept (the newest few thousand), a search that
 * finds and marks every match, and the terminal colour codes some programs print, taken out
 * since the log is shown as plain text.
 */

export const MAX_LOG_LINES = 5_000;

/** How many lines a log starts with, as the viewers offer them. */
export const TAIL_CHOICES = [100, 500, 1_000, 2_000, 5_000] as const;
export const DEFAULT_TAIL = 500;
/** A unit's journal and a site's log read at most this many lines at the start. */
export const MAX_TEXT_LOG_TAIL = 2_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function plain(text: string): string {
  return text.replace(ANSI, '');
}

/** Adds new lines after the last one kept, dropping any it already has (a resumed stream). */
export function appendLines(
  current: readonly ContainerLogLine[],
  incoming: readonly ContainerLogLine[],
  max = MAX_LOG_LINES,
): ContainerLogLine[] {
  const last = current.at(-1)?.timestamp;
  const fresh = last ? incoming.filter((line) => line.timestamp > last) : [...incoming];
  if (fresh.length === 0) return current as ContainerLogLine[];
  return [...current, ...fresh].slice(-max);
}

/** The indexes of the lines that contain the search, ignoring case. */
export function findMatches(lines: readonly ContainerLogLine[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (plain(line.text).toLowerCase().includes(needle)) found.push(index);
  });
  return found;
}

/** The text cut into plain and matching pieces, for marking the matches. */
export function highlight(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const pieces: Array<{ text: string; match: boolean }> = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) pieces.push({ text: text.slice(from, at), match: false });
    pieces.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from), match: false });
  return pieces;
}

/** "14:02:07", from the line's time in this computer's zone. */
export function clockTime(atUnixMs: number): string {
  return new Date(atUnixMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
