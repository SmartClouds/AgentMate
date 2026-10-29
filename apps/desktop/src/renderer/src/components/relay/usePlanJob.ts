import type { RelayProposal } from '@runova/core';
import type { RelayPlannerResult } from '@shared/relayTypes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  cancelPlanJob,
  type PlanJob,
  type PlanJobStart,
  type PlannedResult,
  startPlanJob,
  updatePlanProposal,
  useRelayPlanJobsStore,
} from '@/stores/relayPlanJobsStore';

export type PlannerRunState =
  | { status: 'idle' }
  | { status: 'running'; requestId: string; startedAt: number }
  | { status: 'done'; result: PlannedResult }
  | { status: 'failed'; error: string };

export interface PlanJobRun {
  /** The job itself, for the inputs it was started with and the proposal as edited. */
  job: PlanJob | null;
  state: PlannerRunState;
  /** Seconds since the planner started, ticking while it runs. */
  elapsed: number;
  start: (
    start: PlanJobStart,
    run: (requestId: string) => Promise<RelayPlannerResult>,
  ) => Promise<void>;
  /** Stops a running planner, or drops a finished result. */
  cancel: () => void;
  setProposal: (proposal: RelayProposal) => void;
}

function stateOf(job: PlanJob | null): PlannerRunState {
  if (!job) return { status: 'idle' };
  if (job.status === 'running') {
    return { status: 'running', requestId: job.requestId, startedAt: job.startedAt };
  }
  if (job.status === 'done' && job.result) return { status: 'done', result: job.result };
  return { status: 'failed', error: job.error ?? 'The planner did not answer.' };
}

/**
 * The planner job for one dialog, read from the jobs store. The dialog only shows it: closing the
 * dialog leaves the planner running, and its result is there when the dialog opens again. Pass the
 * key only while the dialog is open, so the store knows a result landing there needs no toast.
 */
export function usePlanJob(key: string | null, shown: boolean): PlanJobRun {
  const job = useRelayPlanJobsStore((s) => (key ? s.jobs[key] : undefined)) ?? null;
  const [elapsed, setElapsed] = useState(0);

  const startedAt = job?.status === 'running' ? job.startedAt : null;
  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  useEffect(() => {
    if (!shown || !key) return;
    const { setShownKey } = useRelayPlanJobsStore.getState();
    setShownKey(key);
    return () => {
      if (useRelayPlanJobsStore.getState().shownKey === key) setShownKey(null);
    };
  }, [key, shown]);

  return {
    job,
    state: stateOf(job),
    elapsed,
    start: startPlanJob,
    cancel: () => {
      if (key) cancelPlanJob(key);
    },
    setProposal: (proposal) => {
      if (key) updatePlanProposal(key, proposal);
    },
  };
}

/** Says where a planner went when the user closes the dialog on it. */
export function announceBackgroundPlanning(): void {
  toast('Planning keeps going in the background', {
    description:
      'You will get a notification when it is ready. The status bar shows how it is doing.',
  });
}

/** "0:42", for the planner's progress line. */
export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
