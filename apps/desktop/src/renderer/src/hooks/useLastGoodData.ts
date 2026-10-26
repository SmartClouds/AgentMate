import type { UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const STORAGE_PREFIX = 'runova:last-good:';

interface Snapshot<T> {
  data: T;
  savedAt: number;
}

export interface RefreshFailure {
  message: string;
  at: number;
  /** Failed refreshes in a row, so the bell can swing again for each new one. */
  count: number;
}

/**
 * Module level so the state outlives the page: leaving Pipelines and coming back
 * should neither lose the saved list nor toast the same failure a second time.
 */
const snapshots = new Map<string, Snapshot<unknown>>();
const failures = new Map<string, RefreshFailure>();
const handledAt = new Map<string, number>();

function readSnapshot<T>(key: string): Snapshot<T> | null {
  const cached = snapshots.get(key);
  if (cached) return cached as Snapshot<T>;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Snapshot<T>;
    if (typeof parsed?.savedAt !== 'number' || parsed.data === undefined) return null;
    snapshots.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function writeSnapshot<T>(key: string, snapshot: Snapshot<T>): void {
  snapshots.set(key, snapshot);
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(snapshot));
  } catch {
    // Storage full or blocked. The in-memory copy still covers this session.
  }
}

/** Electron prefixes rejected IPC calls with "Error invoking remote method '...': Error: ". */
function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return (
    raw
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '')
      .trim() || 'Something went wrong.'
  );
}

/**
 * Keeps the last response that actually had data on screen when a later refresh
 * fails, instead of swapping the page for an error state.
 *
 * Every good response is saved (in memory and in localStorage, so it also shows
 * right away on the next launch while the first fetch runs). When a refresh throws
 * or comes back as a failure, the saved copy stays in place, `failure` says what
 * went wrong and a toast carries the error. With nothing saved yet the raw
 * response passes straight through, so the page's own error state still shows.
 */
export function useLastGoodData<T>({
  storageKey,
  query,
  failureOf,
  title,
}: {
  storageKey: string;
  query: UseQueryResult<T>;
  /** The error message when a response that did arrive still carries no usable data. */
  failureOf: (data: T) => string | null | undefined;
  /** Toast heading, e.g. "Could not refresh runs". */
  title: string;
}): {
  data: T | undefined;
  failure: RefreshFailure | null;
  /** When the data on screen was fetched. */
  savedAt: number | null;
  /** A refetch the user asked for, which always reports its own failure. */
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState(() => readSnapshot<T>(storageKey));
  const [failure, setFailure] = useState(() => failures.get(storageKey) ?? null);
  const manualRef = useRef(false);
  const failureOfRef = useRef(failureOf);
  failureOfRef.current = failureOf;

  // A different project on the same component means a different saved copy.
  useEffect(() => {
    setSnapshot(readSnapshot<T>(storageKey));
    setFailure(failures.get(storageKey) ?? null);
  }, [storageKey]);

  const { data, error, dataUpdatedAt, errorUpdatedAt, isFetching, refetch } = query;

  useEffect(() => {
    if (isFetching) return;
    const threw = error != null && errorUpdatedAt > dataUpdatedAt;
    const settledAt = threw ? errorUpdatedAt : dataUpdatedAt;
    if (!settledAt) return;
    const manual = manualRef.current;
    manualRef.current = false;
    if (!manual && handledAt.get(storageKey) === settledAt) return;
    handledAt.set(storageKey, settledAt);

    const message = threw
      ? errorText(error)
      : data === undefined
        ? null
        : (failureOfRef.current(data) ?? null);

    if (!message) {
      if (data === undefined) return;
      const next = { data, savedAt: dataUpdatedAt };
      writeSnapshot(storageKey, next);
      setSnapshot(next);
      failures.delete(storageKey);
      setFailure(null);
      toast.dismiss(`refresh-failed:${storageKey}`);
      return;
    }

    // Nothing to fall back on, so the page shows the failure the normal way.
    if (!readSnapshot<T>(storageKey)) return;

    const previous = failures.get(storageKey);
    const next = { message, at: settledAt, count: (previous?.count ?? 0) + 1 };
    failures.set(storageKey, next);
    setFailure(next);
    // A background poll that keeps failing would toast every minute, so after the
    // first one only a refresh the user asked for speaks up again.
    if (!previous || manual) {
      toast.error(title, {
        id: `refresh-failed:${storageKey}`,
        description: `${message} Showing the last data that loaded.`,
      });
    }
  }, [data, dataUpdatedAt, error, errorUpdatedAt, isFetching, storageKey, title]);

  const refresh = useCallback(() => {
    manualRef.current = true;
    void refetch();
  }, [refetch]);

  // Checked at render too, so a failed response never flashes up before the effect runs.
  const usable = data !== undefined && !failureOf(data);
  const showSaved = snapshot !== null && (failure !== null || !usable);

  return {
    data: showSaved ? snapshot.data : data,
    failure: snapshot ? failure : null,
    savedAt: showSaved ? snapshot.savedAt : dataUpdatedAt || null,
    refresh,
  };
}
