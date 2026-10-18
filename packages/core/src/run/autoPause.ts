/**
 * Pausing a project's runs while an AI agent works in the same folder. A dev server with hot
 * reload rebuilds on every file the agent writes and takes the CPU the agent needs; frozen, it
 * picks up all the changes in one go when it resumes. These are the rules only: the caller
 * feeds in what it sees, does the pausing, and keeps `memory` for the next call.
 */

/** Who paused a run. A run the user paused is never resumed for them. */
export type RunPauseReason = 'user' | 'agent';

/**
 * How long no working agent may cover a paused run before it resumes. Agents flip to idle for
 * a moment between tool calls, and resuming for each of those would bring back the rebuilds.
 */
export const AUTO_PAUSE_RESUME_DELAY_MS = 3000;

export interface AutoPauseAgent {
  id: string;
  cwd: string;
  /** Only `working` counts; waiting for input, done, idle and exited do not. */
  working: boolean;
}

export interface AutoPauseRun {
  id: string;
  cwd: string;
  /** False once the run's command has finished and only its shell is left. */
  active: boolean;
  paused: RunPauseReason | null;
  /** A pause or resume is on its way, so `paused` is about to change. */
  pending: boolean;
}

export interface AutoPauseMemory {
  /** When a working agent last covered each run that is being watched. */
  lastCoveredAt: Record<string, number>;
  /** Runs these rules paused and have not resumed yet. */
  autoPaused: string[];
  /** Runs the user resumed by hand while an agent worked, left alone until it is done. */
  overridden: string[];
}

export interface AutoPausePlan {
  pause: string[];
  resume: string[];
  memory: AutoPauseMemory;
}

export function emptyAutoPauseMemory(): AutoPauseMemory {
  return { lastCoveredAt: {}, autoPaused: [], overridden: [] };
}

function folderKey(path: string): string {
  const posix = path.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows paths compare without case; posix folders can differ by case alone.
  return /^[a-z]:/i.test(posix) ? posix.toLowerCase() : posix;
}

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * True when an agent in `agentCwd` can change files a run in `runCwd` watches: the same folder,
 * or one inside the other (an agent at the repo root and a run in `packages/web`, or the reverse).
 */
export function agentCoversRun(agentCwd: string, runCwd: string): boolean {
  if (!agentCwd.trim() || !runCwd.trim()) return false;
  const a = folderKey(agentCwd);
  const r = folderKey(runCwd);
  return inside(a, r) || inside(r, a);
}

export function planAgentRunPause(input: {
  runs: readonly AutoPauseRun[];
  agents: readonly AutoPauseAgent[];
  memory: AutoPauseMemory;
  now: number;
  enabled: boolean;
}): AutoPausePlan {
  const { runs, agents, memory, now, enabled } = input;

  if (!enabled) {
    return {
      pause: [],
      resume: runs.filter((r) => r.paused === 'agent' && !r.pending).map((r) => r.id),
      memory: emptyAutoPauseMemory(),
    };
  }

  const working = agents.filter((agent) => agent.working);
  const autoPaused = new Set(memory.autoPaused);
  const overridden = new Set(memory.overridden);
  const lastCoveredAt: Record<string, number> = {};
  const pause: string[] = [];
  const resume: string[] = [];

  for (const run of runs) {
    const previous = memory.lastCoveredAt[run.id];
    if (previous !== undefined) lastCoveredAt[run.id] = previous;
    if (run.pending) continue;

    const covered = working.some((agent) => agentCoversRun(agent.cwd, run.cwd));
    if (covered) lastCoveredAt[run.id] = now;

    if (autoPaused.has(run.id) && run.paused !== 'agent') {
      autoPaused.delete(run.id);
      // Running again while the agent still works: the user resumed it on purpose.
      if (run.paused === null && covered) overridden.add(run.id);
    }

    const quietFor = now - (lastCoveredAt[run.id] ?? now);
    const settled = !covered && quietFor >= AUTO_PAUSE_RESUME_DELAY_MS;

    if (overridden.has(run.id)) {
      lastCoveredAt[run.id] ??= now;
      if (settled) overridden.delete(run.id);
      continue;
    }

    if (run.paused === 'agent') {
      // A run paused before a reload has no memory yet; it gets the full delay from now.
      lastCoveredAt[run.id] ??= now;
      if (settled) {
        resume.push(run.id);
        autoPaused.delete(run.id);
      }
      continue;
    }

    if (covered && run.paused === null && run.active) {
      pause.push(run.id);
      autoPaused.add(run.id);
    }
  }

  const live = new Set(runs.map((run) => run.id));
  for (const id of Object.keys(lastCoveredAt)) if (!live.has(id)) delete lastCoveredAt[id];
  return {
    pause,
    resume,
    memory: {
      lastCoveredAt,
      autoPaused: [...autoPaused].filter((id) => live.has(id)),
      overridden: [...overridden].filter((id) => live.has(id)),
    },
  };
}
