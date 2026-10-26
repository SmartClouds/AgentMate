import type { DeployHealth, DeployServer } from '@shared/deployTypes';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import type { SetupRun } from '@/stores/deploySetupStore';

/** How often a core's health is checked while the Deploy page is open. */
export const HEALTH_INTERVAL_MS = 30_000;

/**
 * A core's live health. The rail entry and the health card share it, so they never disagree.
 * Background checks do not ask about a changed host key; the health card's "Try again" does.
 */
export function useCoreHealth(server: DeployServer): UseQueryResult<DeployHealth> {
  return useQuery({
    queryKey: queryKeys.deployHealth(server.id),
    queryFn: () => window.runova.deploy.health(server.id),
    enabled: server.core !== null,
    refetchInterval: HEALTH_INTERVAL_MS,
    retry: false,
  });
}

export type ServerState = 'not-installed' | 'busy' | 'connecting' | 'online' | 'offline';

export function serverState(
  server: DeployServer,
  health: Pick<UseQueryResult<DeployHealth>, 'isError' | 'isSuccess'>,
  run: SetupRun | undefined,
): ServerState {
  if (run?.status === 'running') return 'busy';
  if (!server.core) return 'not-installed';
  if (health.isError) return 'offline';
  if (health.isSuccess) return 'online';
  return 'connecting';
}

type Transport = NonNullable<DeployServer['core']>['transport'];

/** A label, for the Connection tile. */
export const TRANSPORT_TEXT: Record<Transport, string> = {
  streamlocal: 'SSH tunnel',
  bridge: 'Core bridge over SSH',
  'dev-tcp': 'Loopback (DevHost)',
  'direct-tls': 'Direct TLS',
};

/** The same, inside a sentence: "Answering through ...". */
export const TRANSPORT_PHRASE: Record<Transport, string> = {
  streamlocal: 'the SSH tunnel',
  bridge: "the core's bridge over SSH",
  'dev-tcp': 'loopback to the DevHost',
  'direct-tls': "the core's own TLS port",
};
