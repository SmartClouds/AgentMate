import { coreErrorMessage } from '@shared/coreErrors';
import type { StackInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { QUIET } from '@/components/deploy/files/hooks';
import { chosenServers } from '@/lib/deploy/railServers';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The apps a project runs on Runova servers: the apps on each server Deploy lists (with the core
 * installed) whose source is this project. The reads share their cache with the Deploy page, so
 * opening an app from here shows it at once.
 */

/** A project page looks again every half minute; the Apps panel itself keeps a quicker pace. */
const APPS_STALE_MS = 30_000;

const NO_IDS: string[] = [];

export type ServerAppsState = 'loading' | 'signed-out' | 'error' | 'ready';

export interface ServerApps {
  server: DeployServer;
  state: ServerAppsState;
  /** The project's apps on the server; empty until `state` is 'ready'. */
  apps: StackInfo[];
  /** What went wrong, for 'error' (or an unreachable core). */
  error: string | null;
  retry: () => void;
}

export interface ProjectRunovaApps {
  /** The servers Deploy lists that have the core, in the rail's order. */
  servers: DeployServer[];
  perServer: ServerApps[];
  /** True while the servers, or any server's apps, are still being read. */
  pending: boolean;
  /** The project's apps across every server. */
  count: number;
}

export function useProjectRunovaApps(projectId: string | undefined): ProjectRunovaApps {
  const serversQuery = useQuery({
    queryKey: queryKeys.deployServers,
    queryFn: () => window.runova.deploy.listServers(),
    meta: QUIET,
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    meta: QUIET,
  });
  const chosenIds = settingsQuery.data?.deployServerIds ?? NO_IDS;
  const servers = useMemo(
    () => chosenServers(serversQuery.data ?? [], chosenIds).filter((server) => server.core),
    [serversQuery.data, chosenIds],
  );

  const access = useQueries({
    queries: servers.map((server) => ({
      queryKey: queryKeys.deployAccess(server.id),
      queryFn: () => window.runova.deploy.access(server.id),
      retry: false,
      staleTime: APPS_STALE_MS,
      meta: QUIET,
    })),
  });
  const lists = useQueries({
    queries: servers.map((server, index) => ({
      queryKey: queryKeys.deployAppsList(server.id),
      queryFn: async () => (await window.runova.deployStacks.list(server.id)) ?? [],
      enabled: access[index]?.data?.state === 'signed-in',
      retry: false,
      staleTime: APPS_STALE_MS,
      refetchInterval: APPS_STALE_MS,
      meta: QUIET,
    })),
  });

  const perServer = servers.map((server, index): ServerApps => {
    const accessQuery = access[index];
    const listQuery = lists[index];
    const retry = () => {
      if (accessQuery?.isError || accessQuery?.data?.state === 'unreachable') {
        void accessQuery.refetch();
      } else {
        void listQuery?.refetch();
      }
    };
    if (!accessQuery || accessQuery.isPending) {
      return { server, state: 'loading', apps: [], error: null, retry };
    }
    if (accessQuery.isError) {
      return {
        server,
        state: 'error',
        apps: [],
        error: coreErrorMessage(accessQuery.error),
        retry,
      };
    }
    if (accessQuery.data.state === 'unreachable') {
      return { server, state: 'error', apps: [], error: accessQuery.data.message ?? null, retry };
    }
    if (accessQuery.data.state !== 'signed-in') {
      return { server, state: 'signed-out', apps: [], error: null, retry };
    }
    if (!listQuery || listQuery.isPending) {
      return { server, state: 'loading', apps: [], error: null, retry };
    }
    if (listQuery.isError) {
      return { server, state: 'error', apps: [], error: coreErrorMessage(listQuery.error), retry };
    }
    const apps = listQuery.data.filter((app) => app.source?.projectId === projectId);
    return { server, state: 'ready', apps, error: null, retry };
  });

  return {
    servers,
    perServer,
    pending:
      serversQuery.isPending ||
      settingsQuery.isPending ||
      perServer.some((entry) => entry.state === 'loading'),
    count: perServer.reduce((sum, entry) => sum + entry.apps.length, 0),
  };
}
