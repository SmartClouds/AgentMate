import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { buildProblems, type Problem } from '@/lib/deploy/problems/problems';
import { queryKeys } from '@/lib/queryKeys';
import { useLiveAlerts } from '../overview/hooks';

/**
 * The problems feed's inputs (E09 T2): the server's containers, apps, open alerts (live),
 * certificates and exposure, each read on its own so one that fails (no Docker, no nginx, a role
 * that may not read the firewall) leaves the others standing. Lists refresh every half minute.
 */

const REFRESH_MS = 30_000;

export interface ProblemsFeedData {
  problems: Problem[];
  /** True until every source answered once, so the feed shows shimmer cards. */
  loading: boolean;
  containers: ReturnType<typeof useContainersQuery>['data'];
}

function useContainersQuery(serverId: string) {
  return useQuery({
    queryKey: queryKeys.deployContainers(serverId),
    queryFn: () => window.runova.deployDocker.listContainers(serverId),
    refetchInterval: REFRESH_MS,
    retry: false,
    meta: { silentLoading: true },
  });
}

export function useProblems(serverId: string): ProblemsFeedData {
  const containers = useContainersQuery(serverId);
  const stacks = useQuery({
    queryKey: queryKeys.deployAppsList(serverId),
    queryFn: async () => (await window.runova.deployStacks.list(serverId)) ?? [],
    refetchInterval: REFRESH_MS,
    retry: false,
    meta: { silentLoading: true },
  });
  const certificates = useQuery({
    queryKey: queryKeys.deployCertificates(serverId),
    queryFn: async () => (await window.runova.deployCerts.list(serverId)) ?? [],
    retry: false,
    meta: { silentLoading: true },
  });
  const exposure = useQuery({
    queryKey: queryKeys.deployFirewallExposure(serverId),
    queryFn: () => window.runova.deployFirewall.exposure(serverId),
    retry: false,
    meta: { silentLoading: true },
  });
  const alerts = useLiveAlerts(serverId, true);

  const problems = useMemo(
    () =>
      buildProblems({
        now: Date.now(),
        containers: containers.data?.groups.flatMap((group) => group.containers) ?? [],
        stacks: stacks.data ?? [],
        alerts: alerts.open,
        certificates: certificates.data ?? [],
        exposure: exposure.data ?? null,
      }),
    [containers.data, stacks.data, alerts.open, certificates.data, exposure.data],
  );

  return {
    problems,
    loading:
      containers.isLoading ||
      stacks.isLoading ||
      certificates.isLoading ||
      exposure.isLoading ||
      !alerts.ready,
    containers: containers.data,
  };
}
