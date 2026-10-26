import { coreErrorMessage } from '@shared/coreErrors';
import type {
  AlertInfo,
  JobInfo,
  JobLogLine,
  MetricsSample,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployConnection } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LIVE_WINDOW_MS, mergeSamples } from '@/lib/deploy/overview/metrics';
import { ownedSubscription } from '@/lib/deploy/overview/subscription';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The Overview's live data: the server's connection, its metrics stream, its alerts and a job's
 * log. Each subscription belongs to the component that made it and stops when it unmounts.
 */

/**
 * Keeps every server's connection state current while the Deploy page is open, and fetches a
 * server's Overview again when its connection comes back (after a reboot, say). Mount it once.
 */
export function useConnectionUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.runova.deploy.onConnection((connection) => {
        const key = queryKeys.deployConnection(connection.serverId);
        const before = queryClient.getQueryData<DeployConnection>(key);
        queryClient.setQueryData(key, connection);
        if (connection.state === 'online' && before && before.state !== 'online') {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.deployOverview(connection.serverId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.deployHealth(connection.serverId),
          });
        }
      }),
    [queryClient],
  );
}

/** A server's connection as last heard; undefined until the first answer. */
export function useDeployConnection(
  serverId: string,
  enabled = true,
): DeployConnection | undefined {
  const query = useQuery({
    queryKey: queryKeys.deployConnection(serverId),
    queryFn: async () => (await window.runova.deploy.connection(serverId)) ?? null,
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return query.data ?? undefined;
}

export interface LiveSamples {
  samples: MetricsSample[];
  /** True once the stored live history (or the first sample) is in. */
  ready: boolean;
  error: string | null;
}

/**
 * The last 15 minutes of samples, every 2 seconds: what the core kept in memory first, then the
 * stream from just after it. The main process carries the stream across reconnects; when it
 * could not start at all, it is tried again once the connection is back.
 */
export function useLiveSamples(serverId: string, enabled: boolean): LiveSamples {
  const [samples, setSamples] = useState<MetricsSample[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = useDeployConnection(serverId, enabled);
  // A stream that could not start is tried again each time the connection comes back up.
  const [attempt, setAttempt] = useState(0);
  const failed = useRef(false);
  failed.current = error !== null;
  const wasOnline = useRef(connection?.state === 'online');
  useEffect(() => {
    const online = connection?.state === 'online';
    if (online && !wasOnline.current && failed.current) setAttempt((count) => count + 1);
    wasOnline.current = online;
  }, [connection?.state]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let stopStream: (() => void) | null = null;
    const append = (incoming: readonly MetricsSample[]) =>
      setSamples((current) => mergeSamples(current, incoming, LIVE_WINDOW_MS));

    const startStream = (sinceUnixMs?: number) => {
      stopStream = ownedSubscription({
        listen: window.runova.deploySystem.onMetrics,
        start: () =>
          window.runova.deploySystem.watchMetrics({
            serverId,
            intervalMs: 2_000,
            ...(sinceUnixMs ? { sinceUnixMs } : {}),
          }),
        stop: window.runova.deploySystem.unwatchMetrics,
        onEvent: (event) => {
          append(event.samples);
          setReady(true);
        },
        onStarted: () => setError(null),
        onError: (failure) => {
          setError(coreErrorMessage(failure));
          setReady(true);
        },
      });
    };

    window.runova.deploySystem.metricsHistory({ serverId, resolution: 'live' }).then(
      (history) => {
        if (disposed) return;
        const stored = history?.samples ?? [];
        append(stored);
        setReady(true);
        startStream(stored.at(-1)?.atUnixMs);
      },
      () => {
        if (!disposed) startStream();
      },
    );

    return () => {
      disposed = true;
      stopStream?.();
    };
  }, [serverId, enabled, attempt]);

  return { samples, ready, error };
}

export interface LiveAlerts {
  /** Open alerts, the most severe and then the newest first. */
  open: AlertInfo[];
  ready: boolean;
  error: string | null;
  /** Folds in an alert the app changed itself, such as one just acknowledged. */
  merge: (alert: AlertInfo) => void;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

/** Open alerts: the list first, then every change the core streams, by highest revision. */
export function useLiveAlerts(serverId: string, enabled: boolean): LiveAlerts {
  const [byId, setById] = useState<ReadonlyMap<number, AlertInfo>>(new Map());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mergeAll = useCallback((alerts: readonly AlertInfo[]) => {
    setById((current) => {
      const next = new Map(current);
      for (const alert of alerts) {
        const known = next.get(alert.id);
        if (!known || known.revision <= alert.revision) next.set(alert.id, alert);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    window.runova.deployAlerts.list({ serverId }).then(
      (alerts) => {
        if (disposed) return;
        mergeAll(alerts ?? []);
        setReady(true);
      },
      (failure: unknown) => {
        if (disposed) return;
        setError(coreErrorMessage(failure));
        setReady(true);
      },
    );
    const stop = ownedSubscription({
      listen: window.runova.deployAlerts.onChanged,
      start: () => window.runova.deployAlerts.watch(serverId),
      stop: window.runova.deployAlerts.unwatch,
      onEvent: (event) => {
        mergeAll(event.alerts);
        setError(null);
      },
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [serverId, enabled, mergeAll]);

  const open = [...byId.values()]
    .filter((alert) => alert.resolvedAtUnixMs === undefined)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        b.lastSeenAtUnixMs - a.lastSeenAtUnixMs,
    );
  return { open, ready, error, merge: (alert) => mergeAll([alert]) };
}

export interface JobLog {
  job: JobInfo | null;
  lines: JobLogLine[];
  /** Set once the job reached its final state, or the log could not be shown. */
  ended: boolean;
  error: string | null;
}

/** The most lines a log keeps on screen; the core keeps the whole file. */
const MAX_LINES = 2_000;

/** One job's log as it is written, and the job itself whenever it changes. */
export function useJobLog(serverId: string, initial: JobInfo | null): JobLog {
  const jobId = initial?.id ?? null;
  const [log, setLog] = useState<JobLog>({ job: initial, lines: [], ended: false, error: null });

  useEffect(() => {
    setLog({ job: initial, lines: [], ended: false, error: null });
    if (!jobId) return;
    return ownedSubscription({
      listen: window.runova.deployJobs.onLog,
      start: () => window.runova.deployJobs.watch({ serverId, jobId }),
      stop: window.runova.deployJobs.unwatch,
      onEvent: (event) =>
        setLog((current) => {
          const last = current.lines.at(-1)?.seq ?? 0;
          const fresh = event.lines.filter((line) => line.seq > last);
          return {
            job: event.job ?? current.job,
            lines: [...current.lines, ...fresh].slice(-MAX_LINES),
            ended: current.ended || event.ended !== undefined,
            error: event.ended?.error ?? current.error,
          };
        }),
      onError: (failure) =>
        setLog((current) => ({ ...current, ended: true, error: coreErrorMessage(failure) })),
    });
  }, [serverId, jobId]);

  return log;
}
