import { parseRunDevices, parseScopeId } from '@runova/core';
import { toast } from 'sonner';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { extractLocalUrls, stripAnsi } from '@/lib/browser/devServers';
import { offerStopContainers, type StoppedRun } from '@/lib/docker/offerStopContainers';
import {
  type TerminalRunInfo,
  type TerminalSessionMeta,
  useTerminalStore,
} from '@/stores/terminalStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/**
 * What each project run's terminal has printed that says where to reach it: local addresses
 * (`http://localhost:5173/`) and the emulator or phone a mobile app went to. Persisted, so a
 * run that is still going after a restart keeps its device; the port also comes back from the
 * listening-port scan.
 */

/** Enough of the previous chunk to catch an address or device line split across two writes. */
const CARRY = 160;
const MAX_URLS = 6;
const MAX_DEVICES = 4;

export interface RunOutput {
  /** In the order they were printed. */
  urls: string[];
  /** In the order they were printed; the last one is the latest. */
  devices: string[];
}

interface RunSessionState {
  outputs: Record<string, RunOutput>;
  noteOutput: (sessionId: string, data: string) => void;
  /** Drops what is kept for sessions that are no longer runs in the drawer. */
  prune: (liveIds: readonly string[]) => void;
}

const tails = new Map<string, string>();

function merged(current: string[], found: string[], max: number): string[] {
  const next = [...current.filter((item) => !found.includes(item)), ...found];
  return next.slice(-max);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

export const useRunSessionStore = create<RunSessionState>()(
  persist(
    (set) => ({
      outputs: {},

      noteOutput: (sessionId, data) => {
        const plain = stripAnsi((tails.get(sessionId) ?? '') + data);
        // Only the unfinished last line carries over; finished lines were scanned already.
        tails.set(sessionId, plain.slice(plain.lastIndexOf('\n') + 1).slice(-CARRY));
        // Cheap check first: most output names neither an address nor a device.
        if (!/:\/\/|emulator-|Launching|Installing|Opening/.test(plain)) return;
        const urls = extractLocalUrls(plain);
        const devices = parseRunDevices(plain);
        if (urls.length === 0 && devices.length === 0) return;
        set((state) => {
          const current = state.outputs[sessionId] ?? { urls: [], devices: [] };
          // An address printed again keeps its first place: Vite lists Local before Network.
          const nextUrls = [
            ...current.urls,
            ...urls.filter((url) => !current.urls.includes(url)),
          ].slice(0, MAX_URLS);
          const nextDevices = merged(current.devices, devices, MAX_DEVICES);
          if (sameList(nextUrls, current.urls) && sameList(nextDevices, current.devices)) {
            return state;
          }
          return {
            outputs: { ...state.outputs, [sessionId]: { urls: nextUrls, devices: nextDevices } },
          };
        });
      },

      prune: (liveIds) => {
        const live = new Set(liveIds);
        for (const id of tails.keys()) if (!live.has(id)) tails.delete(id);
        set((state) => {
          const kept = Object.entries(state.outputs).filter(([id]) => live.has(id));
          if (kept.length === Object.keys(state.outputs).length) return state;
          return { outputs: Object.fromEntries(kept) };
        });
      },
    }),
    {
      name: 'runova-run-sessions',
      partialize: (state) => ({ outputs: state.outputs }),
    },
  ),
);

export type RunSessionMeta = TerminalSessionMeta & { run: TerminalRunInfo };

/** The drawer tabs that run a project's run command, oldest first. */
export function runSessionsOf(sessions: readonly TerminalSessionMeta[]): RunSessionMeta[] {
  return sessions.filter(
    (session): session is RunSessionMeta => session.run !== undefined && session.kind !== 'ssh',
  );
}

/**
 * Closes these tabs, which ends their shells and everything the shells started. For a run that
 * is also the moment to ask about its Docker containers: ending the shell does not stop what
 * `docker compose up -d` left running. The tabs close first and Docker is only consulted after,
 * in the background, so a slow or stopped Docker never delays a stop.
 *
 * `quiet` leaves out the per-run "Stopped" toast, for a caller that reports on its own.
 */
export function stopRuns(sessionIds: readonly string[], { quiet = false } = {}): void {
  const wanted = new Set(sessionIds);
  const sessions = useTerminalStore.getState().sessions.filter((s) => wanted.has(s.id));
  const stopped: StoppedRun[] = [];
  for (const session of sessions) {
    useTerminalStore.getState().closeSession(session.id);
    if (!session.run) continue;
    stopped.push({ cwd: session.cwd, title: session.title });
    if (!quiet) toast.success(`Stopped "${session.run.label}"`);
  }
  if (stopped.length > 0) void offerStopContainers(stopped);
}

/** Closes a run's tab, which ends its shell and everything the shell started. */
export function stopRun(sessionId: string): void {
  stopRuns([sessionId]);
}

/** Closing a drawer tab by hand: a run's tab is a stop, so it goes the same way. */
export function closeTerminalTab(sessionId: string): void {
  stopRuns([sessionId]);
}

/**
 * Which run the stop shortcut ends: the run open in the drawer, or else the newest run of the
 * workspace's project, or else the newest run. Plain shells and agent tabs are never picked.
 */
export function pickRunToStop(
  terminal: Pick<
    ReturnType<typeof useTerminalStore.getState>,
    'sessions' | 'activeSessionId' | 'isOpen'
  >,
  workspaceScopeId: string | null,
): string | null {
  const runs = runSessionsOf(terminal.sessions);
  if (runs.length === 0) return null;
  if (terminal.isOpen) {
    const active = runs.find((run) => run.id === terminal.activeSessionId);
    if (active) return active.id;
  }
  if (workspaceScopeId) {
    const projectId = parseScopeId(workspaceScopeId).projectId;
    const ofProject = runs.filter(
      (run) => run.projectId === workspaceScopeId || run.projectId === projectId,
    );
    const newest = ofProject.at(-1);
    if (newest) return newest.id;
  }
  return runs.at(-1)?.id ?? null;
}

/** The stop shortcut's action. */
export function stopActiveRun(): void {
  const id = pickRunToStop(
    useTerminalStore.getState(),
    useWorkspaceStore.getState().activeProjectId,
  );
  if (id) stopRun(id);
  else toast.info('Nothing is running');
}
