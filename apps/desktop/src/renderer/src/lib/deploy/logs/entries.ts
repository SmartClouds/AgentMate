import type {
  AuditEventInfo,
  ContainerLogLine,
  JournalLine,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { plain } from '@/lib/deploy/containers/logs';

/**
 * The logs center's one line shape (E09 T1): container logs, a whole app's services, a unit's
 * journal, a site's nginx log and the core's audit trail all become entries with a time (when the
 * source has one), where they came from, a level and their text. The text is untrusted: it is
 * shown as text only, with terminal colour codes taken out.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  key: string;
  atUnixMs: number | null;
  /** The service, unit or container the line came from. */
  origin: string;
  stream: 'out' | 'err' | null;
  level: LogLevel;
  text: string;
}

export type TimeRange = 'all' | '15m' | '1h' | '6h' | '24h';

export const TIME_RANGES: ReadonlyArray<{ value: TimeRange; label: string }> = [
  { value: 'all', label: 'Everything kept' },
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
];

const RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
export const MAX_ENTRIES = 5_000;

const ERROR_WORDS =
  /\b(?:error|err|fatal|panic|crit(?:ical)?|emerg(?:ency)?|exception|failed|failure|refused|denied)\b|\[error\]|\blevel=(?:error|fatal)\b/i;
const WARN_WORDS =
  /\b(?:warn(?:ing)?|deprecated|retry(?:ing)?|timeout|timed out|slow)\b|\[warn\]|\blevel=warn/i;
const DEBUG_WORDS = /\b(?:debug|trace)\b|\blevel=(?:debug|trace)\b/i;
/** An nginx access line: the status code after the quoted request. */
const ACCESS_STATUS = /" (\d{3}) /;

/** A line's level from its words, or from what the source says (journald's priority). */
export function detectLevel(text: string, priority?: number): LogLevel {
  if (priority !== undefined) {
    if (priority <= 3) return 'error';
    if (priority === 4) return 'warn';
    if (priority === 7) return 'debug';
  }
  const status = text.match(ACCESS_STATUS)?.[1];
  if (status) return status.startsWith('5') ? 'error' : status.startsWith('4') ? 'warn' : 'info';
  if (ERROR_WORDS.test(text)) return 'error';
  if (WARN_WORDS.test(text)) return 'warn';
  if (DEBUG_WORDS.test(text)) return 'debug';
  return 'info';
}

export function containerEntries(lines: readonly ContainerLogLine[], origin: string): LogEntry[] {
  return lines.map((line, index) => {
    const text = plain(line.text);
    return {
      key: `${origin}:${line.timestamp}:${index}`,
      atUnixMs: line.atUnixMs,
      origin,
      stream: line.stream === 'stderr' ? 'err' : 'out',
      level: detectLevel(text),
      text,
    };
  });
}

export function journalEntries(lines: readonly JournalLine[], origin: string): LogEntry[] {
  return lines.map((line, index) => {
    const text = plain(line.text);
    return {
      key: `${origin}:${line.atUnixMs}:${index}`,
      atUnixMs: line.atUnixMs,
      origin,
      stream: null,
      level: detectLevel(text, line.priority),
      text,
    };
  });
}

export function siteEntries(lines: readonly string[], origin: string): LogEntry[] {
  return lines.map((line, index) => {
    const text = plain(line);
    return {
      key: `${origin}:${index}`,
      atUnixMs: null,
      origin,
      stream: null,
      level: detectLevel(text),
      text,
    };
  });
}

export function auditEntries(events: readonly AuditEventInfo[]): LogEntry[] {
  return [...events]
    .sort((a, b) => a.id - b.id)
    .map((event) => {
      const who = event.actorUserName ?? event.actorUserId ?? 'the core';
      const target = event.target ? ` ${event.target}` : '';
      const parameters = event.parameters ? ` ${event.parameters}` : '';
      return {
        key: `audit:${event.id}`,
        atUnixMs: event.atUnixMs,
        origin: who,
        stream: null,
        level:
          event.result === 'denied' || event.result === 'failed' ? 'warn' : ('info' as LogLevel),
        text: `${event.action} ${event.result}${target}${parameters}`,
      };
    });
}

/** Several sources in time order; lines without a time keep their place after the timed ones. */
export function mergeEntries(groups: ReadonlyArray<readonly LogEntry[]>): LogEntry[] {
  const all = groups.flat();
  const timed = all.filter((entry) => entry.atUnixMs !== null);
  const untimed = all.filter((entry) => entry.atUnixMs === null);
  timed.sort((a, b) => (a.atUnixMs ?? 0) - (b.atUnixMs ?? 0));
  return [...timed, ...untimed].slice(-MAX_ENTRIES);
}

export function rangeStart(range: TimeRange, now: number): number | null {
  return range === 'all' ? null : now - RANGE_MS[range];
}

export interface EntryFilter {
  /** Lines at this level or above. */
  minLevel: LogLevel;
  /** Lines from this time on; lines without a time always stay. */
  since: number | null;
}

export function filterEntries(entries: readonly LogEntry[], filter: EntryFilter): LogEntry[] {
  return entries.filter(
    (entry) =>
      LEVEL_RANK[entry.level] >= LEVEL_RANK[filter.minLevel] &&
      (filter.since === null || entry.atUnixMs === null || entry.atUnixMs >= filter.since),
  );
}

/** The indexes of the entries whose text contains the search, ignoring case. */
export function matchingEntries(entries: readonly LogEntry[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const found: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.text.toLowerCase().includes(needle) || entry.origin.toLowerCase().includes(needle)) {
      found.push(index);
    }
  });
  return found;
}

/** What "Download" saves: one line each, with the time in UTC when there is one. */
export function entriesAsText(entries: readonly LogEntry[]): string {
  return entries
    .map((entry) => {
      const at = entry.atUnixMs === null ? '-' : new Date(entry.atUnixMs).toISOString();
      return `${at} ${entry.origin} ${entry.level.toUpperCase()}${entry.stream === 'err' ? ' err' : ''} ${entry.text}`;
    })
    .join('\n');
}
