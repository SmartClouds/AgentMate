/**
 * CI auto-fix: the user switches it on for a run, and when that run fails an agent CLI fixes it in
 * a workspace tab, Runova commits and pushes to the same branch, and follows the run the push
 * starts. Main owns every session, so it keeps going whichever page the user is on.
 */

/**
 * Where a session stands.
 * - `watching`: following a run until it finishes.
 * - `fixing`: an agent tab is working on the failure.
 * - `committing`: committing the agent's change and pushing it.
 * - `waiting-run`: pushed (or dispatched), waiting for GitHub to start the run.
 * - `attention`: something only the user can sort out, said in `message`.
 * - `succeeded`, `gave-up`, `stopped`: finished.
 */
export type AutoFixPhase =
  | 'watching'
  | 'fixing'
  | 'committing'
  | 'waiting-run'
  | 'attention'
  | 'succeeded'
  | 'gave-up'
  | 'stopped';

/** What stopped a session and is waiting on the user. Decides what Retry does. */
export type AutoFixBlocker =
  | 'wrong-branch'
  | 'dirty-tree'
  | 'behind'
  | 'read-failed'
  | 'launch-failed'
  | 'needs-input'
  | 'agent-lost'
  | 'commit-failed'
  | 'push-failed'
  | 'run-missing';

export type AutoFixAttemptOutcome =
  | 'fixing'
  | 'pushed'
  | 'passed'
  | 'failed'
  | 'no-change'
  | 'cancelled';

/** One try: the failed run it fixes, the tab that fixed it, and the commit it pushed. */
export interface AutoFixAttempt {
  n: number;
  runId: number;
  runNumber: number | null;
  startedAt: number;
  tabId: string | null;
  /** HEAD when the agent started, so a commit the agent made itself is still pushed. */
  baseSha: string | null;
  commitSha: string | null;
  /** The run the pushed commit started. */
  nextRunId: number | null;
  nextRunNumber: number | null;
  outcome: AutoFixAttemptOutcome;
}

/** What the agent in the current attempt's tab has been seen doing. */
export interface AutoFixAgentWatch {
  /** The CLI reports through hooks, so its `done` is exact rather than a guess from silence. */
  hooks: boolean;
  /** It produced work at least once, so a quiet tab is a finished one rather than a slow start. */
  sawWork: boolean;
  /** Since when it has looked finished, for CLIs without hooks. */
  quietSince: number | null;
}

/** What a session waits for while it has no run to follow. */
export type AutoFixRunWait =
  | { kind: 'commit'; sha: string; since: number }
  | { kind: 'dispatch'; since: number };

export interface AutoFixSession {
  id: string;
  projectId: string;
  projectName: string;
  /** `owner/name`. */
  repo: string;
  workflowId: number;
  workflowName: string;
  branch: string;
  cliId: string;
  /** Model and effort flags for the CLI, picked when auto-fix was switched on. */
  runArgs: string[];
  /** Shown with the CLI, e.g. "Opus 5.5 · High". */
  runLabel: string | null;
  maxAttempts: number;
  /** The run being followed, or null while waiting for one to start. */
  runId: number | null;
  runNumber: number | null;
  waitFor: AutoFixRunWait | null;
  phase: AutoFixPhase;
  blocker: AutoFixBlocker | null;
  /** Why the session needs the user, or how it ended, in a sentence. */
  message: string | null;
  attempts: AutoFixAttempt[];
  agent: AutoFixAgentWatch | null;
  createdAt: number;
  updatedAt: number;
}

/** What the renderer sends to switch auto-fix on, for a run in progress or one just dispatched. */
export interface AutoFixStartInput {
  projectId: string;
  repo: string;
  workflowId: number;
  workflowName: string;
  branch: string;
  /** The run to follow. Leave it out right after a dispatch, before GitHub has created the run. */
  runId?: number;
  runNumber?: number;
  /** Null uses the CLI from Settings, then the project's own. */
  cliId?: string | null;
  runArgs?: string[];
  runLabel?: string | null;
  maxAttempts?: number;
}

export type AutoFixStartResult =
  | { ok: true; session: AutoFixSession }
  | { ok: false; error: string };

/** A tab main opened for an attempt, for the renderer to show in the project's workspace. */
export interface AutoFixTabEvent {
  projectId: string;
  tabId: string;
  sessionId: string;
  cliId: string;
  title: string;
  runLabel?: string;
  cwd: string;
}

/** The phases that are over: nothing more happens without the user starting a new session. */
export const AUTO_FIX_FINISHED: readonly AutoFixPhase[] = ['succeeded', 'gave-up', 'stopped'];

export const AUTO_FIX_MAX_ATTEMPTS = 5;
export const AUTO_FIX_DEFAULT_ATTEMPTS = 3;
