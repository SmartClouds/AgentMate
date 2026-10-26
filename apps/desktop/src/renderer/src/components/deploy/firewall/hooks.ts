import type { FirewallStatus } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployFirewallOperation } from '@shared/deployFirewallTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { type StepStates, withStep } from './StepList';

/**
 * The Firewall section's data. While a change waits for its confirmation the status is read
 * every few seconds, and once more just after the deadline, so a rollback by the server's
 * timer shows up without anyone refreshing.
 */

const WAITING_POLL_MS = 3_000;
const IDLE_POLL_MS = 60_000;

export function useFirewallData(serverId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const read = { enabled, retry: false } as const;
  const status = useQuery({
    ...read,
    queryKey: queryKeys.deployFirewallStatus(serverId),
    queryFn: () => window.runova.deployFirewall.status(serverId),
    refetchInterval: (query) =>
      (query.state.data as FirewallStatus | undefined)?.pending ? WAITING_POLL_MS : IDLE_POLL_MS,
  });
  const presets = useQuery({
    ...read,
    queryKey: queryKeys.deployFirewallPresets(serverId),
    queryFn: () => window.runova.deployFirewall.presets(serverId),
    staleTime: 5 * 60_000,
  });
  const history = useQuery({
    ...read,
    queryKey: queryKeys.deployFirewallHistory(serverId),
    queryFn: () => window.runova.deployFirewall.history({ serverId, limit: 20 }),
  });
  const exposure = useQuery({
    ...read,
    queryKey: queryKeys.deployFirewallExposure(serverId),
    queryFn: () => window.runova.deployFirewall.exposure(serverId),
    refetchInterval: 2 * 60_000,
  });

  const deadline = status.data?.pending?.deadlineUnixMs;
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: queryKeys.deployFirewall(serverId) }),
      Math.max(0, deadline - Date.now()) + 1_500,
    );
    return () => clearTimeout(timer);
  }, [deadline, queryClient, serverId]);

  return { status, presets, history, exposure };
}

/** The steps the main process reports, per operation, for this server only. */
export function useFirewallSteps(serverId: string) {
  const [steps, setSteps] = useState<Record<DeployFirewallOperation, StepStates>>({
    apply: [],
    confirm: [],
    revert: [],
  });
  useEffect(
    () =>
      window.runova.deployFirewall.onProgress((event) => {
        if (event.serverId !== serverId) return;
        setSteps((current) => ({
          ...current,
          [event.operation]: withStep(current[event.operation], event),
        }));
      }),
    [serverId],
  );
  const reset = useCallback(
    (operation: DeployFirewallOperation) =>
      setSteps((current) => ({ ...current, [operation]: [] })),
    [],
  );
  return { steps, reset };
}

/** The clock, ticking only while `active`, for the countdown. */
export function useTicking(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
