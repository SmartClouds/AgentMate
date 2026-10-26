import { coreErrorMessage } from '@shared/coreErrors';
import type {
  JobInfo,
  JobLogLine,
  StackDetails,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ownedSubscription } from '@/lib/deploy/overview/subscription';
import { queryKeys } from '@/lib/queryKeys';
import { hasRole } from '../security/format';

/** What a server's Apps read: who is signed in, the apps, one app, and a job's live log. */

export interface AppsAccess {
  pending: boolean;
  signedIn: boolean;
  roles: string[];
  canOperate: boolean;
  canAdmin: boolean;
}

/** The signed-in user's roles on the server. The core checks every call again. */
export function useAppsAccess(serverId: string): AppsAccess {
  const access = useQuery({
    queryKey: queryKeys.deployAccess(serverId),
    queryFn: () => window.runova.deploy.access(serverId),
    retry: false,
    staleTime: 30_000,
  });
  const roles = access.data?.user?.roles ?? [];
  return {
    pending: access.isPending,
    signedIn: access.data?.state === 'signed-in',
    roles,
    canOperate: hasRole(roles, 'operator'),
    canAdmin: hasRole(roles, 'admin'),
  };
}

export function useStacks(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.deployAppsList(serverId),
    queryFn: async () => (await window.runova.deployStacks.list(serverId)) ?? [],
    enabled,
    retry: false,
    refetchInterval: 15_000,
  });
}

/** Whether anything works on the app right now, from what the core last said. */
export function stackIsBusy(details: StackDetails | undefined): boolean {
  if (!details) return false;
  return (
    details.stack.status === 'busy' ||
    details.stack.activeJobId !== undefined ||
    details.revisions.some((revision) => revision.state === 'deploying')
  );
}

/**
 * One app, read again every 1.5 seconds while a job works on it (its steps move), and every 20
 * seconds otherwise. `following` keeps the quick pace for a job the app just started.
 */
export function useStack(serverId: string, stackId: string, enabled: boolean, following: boolean) {
  return useQuery({
    queryKey: queryKeys.deployApp(serverId, stackId),
    queryFn: () => window.runova.deployStacks.get({ serverId, stackId }),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      following || stackIsBusy(query.state.data as StackDetails | undefined) ? 1_500 : 20_000,
  });
}

/** A clock for durations that tick; it only runs while something is running. */
export function useNow(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

export interface JobLines {
  job: JobInfo | null;
  lines: JobLogLine[];
  ended: boolean;
  error: string | null;
}

/** A deploy keeps more on screen than an Overview job; the core keeps the whole log. */
const MAX_LINES = 5_000;

/** One job's log as it is written (already redacted by the core), and the job when it changes. */
export function useJobLines(serverId: string, jobId: string | null): JobLines {
  const [log, setLog] = useState<JobLines>({ job: null, lines: [], ended: false, error: null });

  useEffect(() => {
    setLog({ job: null, lines: [], ended: false, error: null });
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
            lines:
              fresh.length > 0 ? [...current.lines, ...fresh].slice(-MAX_LINES) : current.lines,
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
