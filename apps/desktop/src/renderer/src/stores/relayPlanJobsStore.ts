import type { RelayProposal } from '@runova/core';
import type { RelayPlannerResult } from '@shared/relayTypes';
import { toast } from 'sonner';
import { create } from 'zustand';
import { type RelayPlanKind, useRelayPlanDialogStore } from './relayPlanDialogStore';

/**
 * Relay planner runs, kept here rather than in the dialog that started them. A planner can read a
 * repository for a long time, so the user closes the dialog and goes on working; the run keeps
 * going, and its result waits here until they review it, discard it or plan again.
 *
 * Deliberately not persisted: a request can't survive a reload, so neither should a spinner.
 */

export type PlannedResult = Extract<RelayPlannerResult, { ok: true }>;

export interface PlanJob {
  key: string;
  kind: RelayPlanKind;
  projectId: string;
  projectName: string;
  /** Lets Cancel stop the run in main, and an OS notification click find the job again. */
  requestId: string;
  startedAt: number;
  /** What the run was started with, so a reopened dialog shows the same form. */
  text: string;
  budget: number;
  recordDone?: boolean;
  status: 'running' | 'done' | 'failed';
  result: PlannedResult | null;
  /** The proposal as the user has trimmed and corrected it so far. */
  proposal: RelayProposal | null;
  error: string | null;
}

export type PlanJobStart = Pick<
  PlanJob,
  'kind' | 'projectId' | 'projectName' | 'text' | 'budget' | 'recordDone'
>;

interface RelayPlanJobsState {
  jobs: Record<string, PlanJob | undefined>;
  /** The job whose dialog is on screen, so a result that lands there needs no toast. */
  shownKey: string | null;
  setShownKey: (key: string | null) => void;
}

export function planJobKey(kind: RelayPlanKind, projectId: string): string {
  return `${kind}:${projectId}`;
}

export const useRelayPlanJobsStore = create<RelayPlanJobsState>()((set) => ({
  jobs: {},
  shownKey: null,
  setShownKey: (shownKey) => set({ shownKey }),
}));

function getJob(key: string): PlanJob | undefined {
  return useRelayPlanJobsStore.getState().jobs[key];
}

function putJob(key: string, job: PlanJob | undefined): void {
  useRelayPlanJobsStore.setState((state) => ({ jobs: { ...state.jobs, [key]: job } }));
}

function patchJob(key: string, patch: Partial<PlanJob>): void {
  const job = getJob(key);
  if (job) putJob(key, { ...job, ...patch });
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Brings the job's dialog up again, from wherever the user is. */
export function openPlanJob(key: string): void {
  const job = getJob(key);
  if (!job) return;
  useRelayPlanDialogStore.getState().show({
    kind: job.kind,
    projectId: job.projectId,
    request: job.kind === 'split' ? job.text : undefined,
  });
}

export function findPlanJobByRequestId(requestId: string): PlanJob | undefined {
  return Object.values(useRelayPlanJobsStore.getState().jobs).find(
    (job) => job?.requestId === requestId,
  );
}

function readyText(job: PlanJob, result: PlannedResult): { title: string; description: string } {
  const where = job.projectName || 'the project';
  if (job.kind === 'split') {
    return {
      title: `Tasks for ${where} are ready`,
      description: `${plural(result.proposal.add.length, 'task')} to look over before they go on the board.`,
    };
  }
  if (result.entries.length === 0) {
    return { title: `Nothing to change on ${where}'s board`, description: 'Open it to see why.' };
  }
  return {
    title:
      job.kind === 'revise'
        ? `Board review for ${where} is ready`
        : `The rest of ${where} is planned`,
    description: `${plural(result.entries.length, 'change')} to look over before they are applied.`,
  };
}

/** Tells the user a run has ended, unless they are looking at it already. */
function announce(job: PlanJob, result: RelayPlannerResult): void {
  if (useRelayPlanJobsStore.getState().shownKey === job.key) return;
  const action = { label: 'Review', onClick: () => openPlanJob(job.key) };
  if (result.ok) {
    const { title, description } = readyText(job, result);
    toast.success(title, { description, action });
  } else {
    toast.error(`Planning for ${job.projectName || 'the project'} stopped`, {
      description: result.error,
      action: { ...action, label: 'Details' },
    });
  }
}

/**
 * Starts a planner run for the job's project and kind, stopping one that is already running
 * there. The run belongs to this store, so it lands whether or not a dialog is still open.
 */
export async function startPlanJob(
  start: PlanJobStart,
  run: (requestId: string) => Promise<RelayPlannerResult>,
): Promise<void> {
  const key = planJobKey(start.kind, start.projectId);
  const previous = getJob(key);
  if (previous?.status === 'running') void window.runova.relay.cancelPlanner(previous.requestId);
  const requestId = `relay-plan-${crypto.randomUUID()}`;
  putJob(key, {
    ...start,
    key,
    requestId,
    startedAt: Date.now(),
    status: 'running',
    result: null,
    proposal: null,
    error: null,
  });

  let result: RelayPlannerResult;
  try {
    result = await run(requestId);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const job = getJob(key);
  // Cancelled, discarded or replaced while it ran.
  if (job?.requestId !== requestId) return;
  if (result.ok) patchJob(key, { status: 'done', result, proposal: result.proposal });
  else if (result.cancelled) putJob(key, undefined);
  else patchJob(key, { status: 'failed', error: result.error });
  if (!result.ok && result.cancelled) return;
  announce(job, result);
}

/**
 * Forgets a job: stops it if it is still running, or drops a result whose tasks were added or that
 * the user does not want.
 */
export function cancelPlanJob(key: string): void {
  const job = getJob(key);
  if (!job) return;
  putJob(key, undefined);
  if (job.status === 'running') void window.runova.relay.cancelPlanner(job.requestId);
}

export function updatePlanProposal(key: string, proposal: RelayProposal): void {
  patchJob(key, { proposal });
}
