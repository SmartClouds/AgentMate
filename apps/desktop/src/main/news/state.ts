import type { NewsLocalState } from '@runova/core';

/**
 * Which news items were read, dismissed or notified about (E42), kept in settings.json under
 * `newsState` so they survive restarts and travel with backup and restore. Pure functions; the
 * runtime reads and writes them through the settings queue.
 */

export type NewsMark = keyof NewsLocalState;

const KEEP_MS = 180 * 24 * 60 * 60 * 1000;

function cleanMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean: Record<string, string> = {};
  for (const [id, at] of Object.entries(value)) {
    if (/^\d{1,16}$/.test(id) && typeof at === 'string') clean[id] = at;
  }
  return clean;
}

export function normalizeNewsState(value: unknown): NewsLocalState {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    read: cleanMap(raw.read),
    dismissed: cleanMap(raw.dismissed),
    notified: cleanMap(raw.notified),
  };
}

/** Drops ids older than 180 days, and any whose time cannot be read. */
export function pruneNewsState(state: NewsLocalState, now: Date): NewsLocalState {
  const cutoff = now.getTime() - KEEP_MS;
  const keep = (map: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(map).filter(([, at]) => {
        const time = Date.parse(at);
        return !Number.isNaN(time) && time >= cutoff;
      }),
    );
  return {
    read: keep(state.read),
    dismissed: keep(state.dismissed),
    notified: keep(state.notified),
  };
}

/** Marks the ids, keeping the time of an earlier mark. */
export function markNews(
  state: NewsLocalState,
  mark: NewsMark,
  ids: readonly number[],
  now: Date,
): NewsLocalState {
  const next = { ...state[mark] };
  for (const id of ids) next[String(id)] ??= now.toISOString();
  return { ...state, [mark]: next };
}
