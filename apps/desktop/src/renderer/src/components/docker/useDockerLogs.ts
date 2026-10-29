import type { DockerLogLine } from '@shared/apiTypes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { appendLines } from '@/lib/deploy/containers/logs';

/** How often a followed log asks docker for what came since its last line. */
export const LOG_POLL_MS = 2_000;

export interface DockerLogs {
  lines: DockerLogLine[];
  /** 'error' only when the first read failed; a later failure keeps the lines and sets `error`. */
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  reload: () => void;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not read the log.';
}

/**
 * A local container's log: its last `tail` lines, then, while following, whatever came since
 * the newest one, read every couple of seconds. `docker logs --since` repeats the line at that
 * exact time, so appendLines drops anything not newer than what is already kept. Pausing and
 * resuming keeps the lines, a read never overlaps the one before it, and a failed read leaves
 * what is on screen as it was.
 */
export function useDockerLogs(
  containerId: string | null,
  { tail, follow }: { tail: number; follow: boolean },
): DockerLogs {
  const [lines, setLines] = useState<DockerLogLine[]>([]);
  const [status, setStatus] = useState<DockerLogs['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const newest = useRef<string | null>(null);

  // The first read, again for another container, another tail or a reload (`run`).
  useEffect(() => {
    setLines([]);
    setError(null);
    setStatus('loading');
    newest.current = null;
    if (!containerId) return;

    let cancelled = false;
    window.runova.docker.logs(containerId, { tail }).then(
      (incoming) => {
        if (cancelled) return;
        newest.current = incoming.at(-1)?.timestamp ?? null;
        setLines(incoming);
        setStatus('ready');
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(reason(failure));
        setStatus('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [containerId, tail, run]);

  // Then, while following, only what is new. Each read waits for the one before it.
  useEffect(() => {
    if (!containerId || !follow || status !== 'ready') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async (): Promise<void> => {
      const since = newest.current;
      try {
        const incoming = await window.runova.docker.logs(
          containerId,
          since ? { tail, since } : { tail },
        );
        if (cancelled) return;
        newest.current = incoming.at(-1)?.timestamp ?? since;
        if (incoming.length > 0) {
          setLines((current) => appendLines(current, incoming) as DockerLogLine[]);
        }
        setError(null);
      } catch (failure) {
        if (cancelled) return;
        setError(reason(failure));
      }
      if (!cancelled) timer = setTimeout(() => void read(), LOG_POLL_MS);
    };
    timer = setTimeout(() => void read(), LOG_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [containerId, tail, follow, status]);

  const reload = useCallback(() => setRun((n) => n + 1), []);
  return { lines, status, error, reload };
}
