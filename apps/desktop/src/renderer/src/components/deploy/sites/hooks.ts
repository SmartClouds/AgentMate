import { coreErrorMessage } from '@shared/coreErrors';
import type { SiteLogKind } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { ownedSubscription } from '@/lib/deploy/overview/subscription';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The Websites section's data: nginx, the sites and the stream proxies, each its own query so
 * each card shimmers on its own, and a site's live log.
 */

export function useNginxStatus(serverId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deployNginx(serverId),
    queryFn: () => window.runova.deploySites.status(serverId),
    enabled,
    retry: false,
  });
}

export function useSites(serverId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deploySites(serverId),
    queryFn: async () => (await window.runova.deploySites.list(serverId)) ?? [],
    enabled,
    retry: false,
  });
}

export function useStreams(serverId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deployStreams(serverId),
    queryFn: async () => (await window.runova.deploySites.listStreams(serverId)) ?? [],
    enabled,
    retry: false,
  });
}

/** Reads nginx, the sites and the proxies again after a change. */
export function useRefreshWeb(serverId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.deployWeb(serverId) }),
    [queryClient, serverId],
  );
}

export interface SiteLog {
  lines: string[];
  /** How many times the file was rotated (or the log started over) while it was shown. */
  resets: number;
  ended: boolean;
  error: string | null;
}

/** The most lines kept on screen; the server keeps the whole file. */
export const MAX_LOG_LINES = 1_000;

/** A site's access or error log as nginx writes it, from the last lines on. */
export function useSiteLog(serverId: string, siteId: string, kind: SiteLogKind): SiteLog {
  const [log, setLog] = useState<SiteLog>({ lines: [], resets: 0, ended: false, error: null });

  useEffect(() => {
    setLog({ lines: [], resets: 0, ended: false, error: null });
    return ownedSubscription({
      listen: window.runova.deploySites.onLog,
      start: () => window.runova.deploySites.watchLog({ serverId, siteId, kind }),
      stop: window.runova.deploySites.unwatchLog,
      onEvent: (event) =>
        setLog((current) => ({
          lines: [...(event.reset ? [] : current.lines), ...event.lines].slice(-MAX_LOG_LINES),
          resets: current.resets + (event.reset && current.lines.length > 0 ? 1 : 0),
          ended: current.ended || event.ended !== undefined,
          error: event.ended?.error ?? current.error,
        })),
      onError: (failure) =>
        setLog((current) => ({ ...current, ended: true, error: coreErrorMessage(failure) })),
    });
  }, [serverId, siteId, kind]);

  return log;
}
