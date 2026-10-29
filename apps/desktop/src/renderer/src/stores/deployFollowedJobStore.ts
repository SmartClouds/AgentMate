import type { JobInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useCallback, useRef } from 'react';
import { create } from 'zustand';

/**
 * The server jobs the Deploy sections follow (an image pull, the nginx install, a certificate, a
 * package upgrade). A job runs on the server whether or not the page is open, so the one a section
 * shows is kept here: its log opens again when the section comes back, and its end is handled once
 * however often the log is shown.
 */

interface DeployFollowedJobState {
  /** By `${serverId}:${slot}`. */
  jobs: Record<string, JobInfo>;
  /** The jobs whose end was handled, by `${serverId}:${jobId}`. */
  handled: Record<string, true>;
  follow: (key: string, job: JobInfo | null) => void;
  /** True the first time the end of a job is handled; false after that. */
  handle: (serverId: string, jobId: string) => boolean;
}

export const useDeployFollowedJobStore = create<DeployFollowedJobState>((set, get) => ({
  jobs: {},
  handled: {},
  follow: (key, job) =>
    set((state) => {
      if (job) return { jobs: { ...state.jobs, [key]: job } };
      const { [key]: _gone, ...rest } = state.jobs;
      return { jobs: rest };
    }),
  handle: (serverId, jobId) => {
    const key = `${serverId}:${jobId}`;
    if (get().handled[key]) return false;
    set((state) => ({ handled: { ...state.handled, [key]: true } }));
    return true;
  },
}));

/** A section's followed job, like `useState<JobInfo | null>`, kept across visits to the page. */
export function useFollowedJob(
  serverId: string,
  slot: string,
): [JobInfo | null, (job: JobInfo | null) => void] {
  const key = `${serverId}:${slot}`;
  const job = useDeployFollowedJobStore((state): JobInfo | undefined => state.jobs[key]) ?? null;
  const follow = useCallback(
    (next: JobInfo | null) => useDeployFollowedJobStore.getState().follow(key, next),
    [key],
  );
  return [job, follow];
}

/**
 * Wraps what a section does when a job ends (a refresh, a toast), so it runs once per job, even
 * when the job's log opens again after the page was left and the job is seen to end again.
 */
export function useFinishedOnce(
  serverId: string,
  callback?: (job: JobInfo) => void,
): (job: JobInfo) => void {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback(
    (job: JobInfo) => {
      if (useDeployFollowedJobStore.getState().handle(serverId, job.id)) latest.current?.(job);
    },
    [serverId],
  );
}
