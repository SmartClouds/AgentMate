import type { RunPauseReason } from '@runova/core';
import type { TerminalPauseChange, TerminalPauseResult, TerminalRunStatus } from '@shared/apiTypes';
import { toast } from 'sonner';
import { create } from 'zustand';
import { pickRunToStop } from '@/stores/runSessionStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/**
 * Which project runs are frozen by Pause. Main owns the state (it is what froze them, and it
 * outlives the window); this mirrors it so the status bar, the drawer tab, the banner and the
 * workspace header all agree. Not persisted: a fresh window reads it back from main.
 */

export interface RunPauseInfo {
  reason: RunPauseReason;
  pausedAt: number;
}

interface RunPauseState {
  paused: Record<string, RunPauseInfo>;
  /** Runs with a pause or resume on its way, so their buttons can say so and ignore clicks. */
  pending: Record<string, 'pausing' | 'resuming'>;
}

export const useRunPauseStore = create<RunPauseState>(() => ({ paused: {}, pending: {} }));

export function useRunPause(sessionId: string): {
  paused: RunPauseInfo | null;
  pending: 'pausing' | 'resuming' | null;
} {
  const paused = useRunPauseStore((s) => s.paused[sessionId] ?? null);
  const pending = useRunPauseStore((s) => s.pending[sessionId] ?? null);
  return { paused, pending };
}

/** When each run's state last changed here, so an older poll does not undo the change. */
const changedAt = new Map<string, number>();

function setPaused(sessionId: string, info: RunPauseInfo | null): void {
  changedAt.set(sessionId, Date.now());
  useRunPauseStore.setState((state) => {
    const paused = { ...state.paused };
    if (info) paused[sessionId] = info;
    else delete paused[sessionId];
    return { paused };
  });
}

function setPending(ids: readonly string[], value: 'pausing' | 'resuming' | null): void {
  useRunPauseStore.setState((state) => {
    const pending = { ...state.pending };
    for (const id of ids) {
      if (value) pending[id] = value;
      else delete pending[id];
    }
    return { pending };
  });
}

function labelOf(sessionId: string): string {
  const session = useTerminalStore.getState().sessions.find((one) => one.id === sessionId);
  return session?.run?.label ?? session?.title ?? 'the run';
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processNote(results: TerminalPauseResult[]): string | null {
  const failed = results.reduce((sum, one) => sum + one.failedCount, 0);
  if (failed === 0) return null;
  const total = failed + results.reduce((sum, one) => sum + one.processCount, 0);
  return `${failed} of ${total} ${total === 1 ? 'process' : 'processes'} could not be paused.`;
}

async function call(
  sessionId: string,
  run: () => Promise<TerminalPauseResult>,
): Promise<TerminalPauseResult> {
  try {
    return await run();
  } catch (error) {
    return {
      ok: false,
      paused: useRunPauseStore.getState().paused[sessionId] !== undefined,
      reason: null,
      pausedAt: null,
      processCount: 0,
      failedCount: 0,
      containersOnly: false,
      error: failureText(error),
    };
  }
}

/**
 * Freezes these runs' processes. A run the agent paused can be taken over by the user, after
 * which it is never resumed for them. `quiet` is for the automatic pause, which the status bar
 * and the tab already show without a toast each time an agent starts.
 */
export async function pauseRuns(
  sessionIds: readonly string[],
  { reason = 'user', quiet = false }: { reason?: RunPauseReason; quiet?: boolean } = {},
): Promise<void> {
  const { paused, pending } = useRunPauseStore.getState();
  const ids = sessionIds.filter(
    (id) => !pending[id] && (!paused[id] || (reason === 'user' && paused[id].reason === 'agent')),
  );
  if (ids.length === 0) return;
  setPending(ids, 'pausing');
  const done: { id: string; result: TerminalPauseResult }[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const result = await call(id, () => window.runova.terminal.pause(id, reason));
      setPending([id], null);
      if (result.paused && result.reason && result.pausedAt !== null) {
        setPaused(id, { reason: result.reason, pausedAt: result.pausedAt });
      }
      if (!result.ok && !quiet) {
        toast.error(`Could not pause "${labelOf(id)}"`, {
          description: result.error ?? 'Nothing could be paused.',
        });
      }
      if (result.ok) done.push({ id, result });
    }),
  );
  if (quiet || done.length === 0) return;

  const resume = { label: 'Resume', onClick: () => void resumeRuns(done.map((one) => one.id)) };
  const results = done.map((one) => one.result);
  const note = processNote(results);
  if (done.length > 1) {
    toast.success(`Paused ${done.length} runs`, {
      description: note ?? 'They use no CPU until you resume them.',
      action: resume,
    });
    return;
  }
  const title = `Paused "${labelOf(done[0].id)}"`;
  if (results[0].containersOnly) {
    toast.info(title, {
      description: 'Its Docker containers keep running, so they still use CPU.',
      action: resume,
    });
    return;
  }
  toast.success(title, {
    description: note ?? 'It uses no CPU until you resume it.',
    action: resume,
  });
}

export async function resumeRuns(
  sessionIds: readonly string[],
  { quiet = false }: { quiet?: boolean } = {},
): Promise<void> {
  const { paused, pending } = useRunPauseStore.getState();
  const ids = sessionIds.filter((id) => paused[id] && !pending[id]);
  if (ids.length === 0) return;
  setPending(ids, 'resuming');
  let resumed = 0;
  await Promise.all(
    ids.map(async (id) => {
      const result = await call(id, () => window.runova.terminal.resume(id));
      setPending([id], null);
      if (!result.paused) setPaused(id, null);
      if (result.ok) resumed += 1;
      else if (!quiet) {
        toast.error(`Could not resume "${labelOf(id)}"`, {
          description: result.error ?? 'It is still paused.',
        });
      }
    }),
  );
  if (quiet || resumed === 0) return;
  toast.success(resumed === 1 ? `Resumed "${labelOf(ids[0])}"` : `Resumed ${resumed} runs`);
}

/** Pauses a running run, or resumes a paused one. Ignored while a change is on its way. */
export async function togglePauseRun(sessionId: string): Promise<void> {
  const { paused, pending } = useRunPauseStore.getState();
  if (pending[sessionId]) return;
  if (paused[sessionId]) await resumeRuns([sessionId]);
  else await pauseRuns([sessionId]);
}

/** The pause shortcut's action: the same run the stop shortcut would end. */
export async function togglePauseActiveRun(): Promise<void> {
  const id = pickRunToStop(
    useTerminalStore.getState(),
    useWorkspaceStore.getState().activeProjectId,
  );
  if (id) await togglePauseRun(id);
  else toast.info('Nothing is running');
}

export function applyPauseChange(change: TerminalPauseChange): void {
  setPaused(
    change.sessionId,
    change.paused && change.reason && change.pausedAt !== null
      ? { reason: change.reason, pausedAt: change.pausedAt }
      : null,
  );
}

/**
 * Takes what the run status poll says as the truth for the runs it covers, which is how a
 * window that opened after a pause (or after main restarted) finds out. Runs mid-change, and
 * runs that changed after the poll was asked for, are left alone: reading the process list can
 * take seconds, so the answer may describe the run as it was before.
 */
export function syncPausesFromStatus(
  statuses: readonly Pick<TerminalRunStatus, 'sessionId' | 'paused' | 'pauseReason' | 'pausedAt'>[],
  askedAt = Number.POSITIVE_INFINITY,
): void {
  const { paused, pending } = useRunPauseStore.getState();
  const next = { ...paused };
  let changed = false;
  for (const status of statuses) {
    if (pending[status.sessionId]) continue;
    if ((changedAt.get(status.sessionId) ?? 0) >= askedAt) continue;
    const current = next[status.sessionId];
    if (status.paused && status.pauseReason && status.pausedAt !== null) {
      if (current?.reason !== status.pauseReason || current.pausedAt !== status.pausedAt) {
        next[status.sessionId] = { reason: status.pauseReason, pausedAt: status.pausedAt };
        changedAt.set(status.sessionId, Date.now());
        changed = true;
      }
    } else if (current) {
      delete next[status.sessionId];
      changedAt.set(status.sessionId, Date.now());
      changed = true;
    }
  }
  if (changed) useRunPauseStore.setState({ paused: next });
}

/** Follows the pause changes main announces. Returns the unsubscribe. */
export function initRunPauses(): () => void {
  return window.runova.terminal.onPauseChange(applyPauseChange);
}
