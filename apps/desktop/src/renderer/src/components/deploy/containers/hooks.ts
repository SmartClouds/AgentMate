import { coreErrorMessage } from '@shared/coreErrors';
import type { ContainerLogLine } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { appendLines } from '@/lib/deploy/containers/logs';
import { mergeStats, type StatsHistory } from '@/lib/deploy/containers/stats';
import { ownedSubscription } from '@/lib/deploy/overview/subscription';
import { queryKeys } from '@/lib/queryKeys';
import { useDeployConnection } from '../overview/hooks';

/**
 * The Containers screen's live data (E06): every running container's figures, engine events that
 * keep the lists current, and one container's log. Each subscription belongs to the component
 * that made it and stops when it unmounts; the main process carries them across reconnects.
 */

/** Counts the times the connection came back after it was lost. */
function useBackOnline(serverId: string, enabled: boolean): number {
  const connection = useDeployConnection(serverId, enabled);
  const [attempt, setAttempt] = useState(0);
  const previous = useRef(connection?.state);
  useEffect(() => {
    const state = connection?.state;
    // Only a connection that was known and not up counts; the first answer is not a return.
    if (state === 'online' && previous.current !== undefined && previous.current !== 'online') {
      setAttempt((count) => count + 1);
    }
    previous.current = state;
  }, [connection?.state]);
  return attempt;
}

export interface LiveStats {
  history: StatsHistory;
  /** True once the first batch is in. */
  ready: boolean;
  error: string | null;
}

export function useContainerStats(serverId: string, enabled: boolean): LiveStats {
  const [history, setHistory] = useState<StatsHistory>(new Map());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    return ownedSubscription({
      listen: window.runova.deployDocker.onStats,
      start: () => window.runova.deployDocker.watchStats(serverId),
      stop: window.runova.deployDocker.unwatchStats,
      onEvent: (event) => {
        if (event.error) {
          setError(event.error);
          return;
        }
        setHistory((current) => mergeStats(current, event.batches));
        setReady(true);
        setError(null);
      },
      onError: (failure) => setError(coreErrorMessage(failure)),
    });
  }, [serverId, enabled]);

  return { history, ready, error };
}

/** How long a burst of engine events waits before the lists are read again. */
const EVENT_SETTLE_MS = 300;

/**
 * Reads the server's Docker lists again a moment after the engine reports a change (a container
 * started, an image pulled), and everything once the connection comes back.
 */
export function useDockerEvents(serverId: string, enabled: boolean): void {
  const queryClient = useQueryClient();
  const back = useBackOnline(serverId, enabled);

  useEffect(() => {
    if (back > 0)
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployDocker(serverId) });
  }, [back, serverId, queryClient]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const touched = new Set<string>();
    const flush = () => {
      timer = null;
      const containers = [...touched];
      touched.clear();
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployContainers(serverId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployDiskUsage(serverId) });
      for (const id of containers) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.deployContainer(serverId, id) });
      }
    };
    const stop = ownedSubscription({
      listen: window.runova.deployDocker.onEvents,
      start: () => window.runova.deployDocker.watchEvents(serverId),
      stop: window.runova.deployDocker.unwatchEvents,
      onEvent: (event) => {
        for (const item of event.events) {
          if (item.type === 'container') touched.add(item.actorId);
          if (item.type === 'image') {
            void queryClient.invalidateQueries({ queryKey: queryKeys.deployImages(serverId) });
          }
          if (item.type === 'volume') {
            void queryClient.invalidateQueries({ queryKey: queryKeys.deployVolumes(serverId) });
          }
          if (item.type === 'network') {
            void queryClient.invalidateQueries({ queryKey: queryKeys.deployNetworks(serverId) });
          }
        }
        timer ??= setTimeout(flush, EVENT_SETTLE_MS);
      },
    });
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [serverId, enabled, queryClient]);
}

export interface LiveLog {
  lines: ContainerLogLine[];
  /** The log is over: not followed, the container stopped, or the core refused. */
  ended: boolean;
  error: string | null;
  ready: boolean;
}

/** One container's log: the last `tail` lines, then (when following) each new one. */
export function useContainerLog(
  serverId: string,
  containerId: string,
  options: { follow: boolean; tail?: number; run?: number },
): LiveLog {
  const [log, setLog] = useState<LiveLog>({ lines: [], ended: false, error: null, ready: false });
  const { follow, tail = 500, run = 0 } = options;

  // `run` is in the list so a new value starts the log over.
  useEffect(() => {
    setLog({ lines: [], ended: false, error: null, ready: false });
    // Not ready until the first lines (or the end) arrive; a quiet log still settles shortly.
    const quiet = setTimeout(() => setLog((current) => ({ ...current, ready: true })), 1_500);
    const stop = ownedSubscription({
      listen: window.runova.deployDocker.onLogs,
      start: () => window.runova.deployDocker.watchLogs({ serverId, containerId, follow, tail }),
      stop: window.runova.deployDocker.unwatchLogs,
      onEvent: (event) =>
        setLog((current) => ({
          lines: appendLines(current.lines, event.lines),
          ended: current.ended || event.ended !== undefined,
          error: event.ended?.error ?? current.error,
          ready: true,
        })),
      onError: (failure) =>
        setLog((current) => ({
          ...current,
          ended: true,
          ready: true,
          error: coreErrorMessage(failure),
        })),
    });
    return () => {
      clearTimeout(quiet);
      stop();
    };
  }, [serverId, containerId, follow, tail, run]);

  return log;
}
