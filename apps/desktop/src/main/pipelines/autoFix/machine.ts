import type { AgentStatus } from '@runova/core';
import {
  AUTO_FIX_FINISHED,
  type AutoFixAttempt,
  type AutoFixBlocker,
  type AutoFixSession,
} from '../../../shared/ciAutoFixTypes';

/**
 * The CI auto-fix state machine. Pure and clock-free, like core's agentStatus: every event comes
 * with the time it happened, and the reducer returns the next session plus the work the service
 * has to do (launch an agent, commit, tell the user). The service owns the I/O and feeds the
 * results back in as events.
 */

/**
 * How long a CLI without hooks has to stay quiet before its silence counts as finished. Its
 * `done` is a guess from four seconds of silence, and an agent thinking or running a slow test
 * is quiet for longer than that, so committing on it would push half a fix.
 */
export const AGENT_SETTLE_MS = 45_000;

/** How long to wait for GitHub to start the run of a pushed commit or a dispatch. */
export const RUN_WAIT_MS = 10 * 60_000;

export type AutoFixCommitResult =
  | { kind: 'pushed'; sha: string }
  | { kind: 'no-change' }
  | { kind: 'blocked'; blocker: AutoFixBlocker; message: string };

export type AutoFixEvent =
  | { type: 'run-found'; runId: number; runNumber: number | null }
  | { type: 'run-finished'; conclusion: string | null }
  | { type: 'launched'; tabId: string; baseSha: string | null; hooks: boolean }
  | { type: 'launch-blocked'; blocker: AutoFixBlocker; message: string }
  | { type: 'agent'; status: AgentStatus }
  /** The attempt's tab is no longer tracked, as after the app restarted. */
  | { type: 'agent-lost' }
  | { type: 'committed'; result: AutoFixCommitResult }
  | { type: 'commit-now' }
  | { type: 'retry' }
  | { type: 'stop' }
  | { type: 'tick' }
  /** The session was read back from disk at startup. */
  | { type: 'resumed' };

export type AutoFixEffect =
  | { type: 'launch'; attempt: number; runId: number }
  | { type: 'commit'; attempt: number }
  | { type: 'notify'; kind: 'fixed' | 'attention' | 'gave-up' };

export interface AutoFixTransition {
  session: AutoFixSession;
  effects: AutoFixEffect[];
}

export interface NewAutoFixSession {
  projectId: string;
  projectName: string;
  repo: string;
  workflowId: number;
  workflowName: string;
  branch: string;
  runId: number | null;
  runNumber: number | null;
  cliId: string;
  runArgs: string[];
  runLabel: string | null;
  maxAttempts: number;
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
/** Blockers where Retry launches the attempt again: the agent never started, or is gone. */
const LAUNCH_BLOCKERS = new Set<AutoFixBlocker>([
  'wrong-branch',
  'dirty-tree',
  'behind',
  'read-failed',
  'launch-failed',
  'agent-lost',
]);
/** Blockers with an agent tab whose work the user can commit as it stands. */
const COMMITTABLE_BLOCKERS = new Set<AutoFixBlocker>(['needs-input', 'agent-lost']);

export function createAutoFixSession(
  input: NewAutoFixSession,
  id: string,
  now: number,
): AutoFixSession {
  const hasRun = input.runId !== null;
  return {
    ...input,
    id,
    phase: hasRun ? 'watching' : 'waiting-run',
    waitFor: hasRun ? null : { kind: 'dispatch', since: now },
    blocker: null,
    message: null,
    attempts: [],
    agent: null,
    createdAt: now,
    updatedAt: now,
  };
}

function noEffects(session: AutoFixSession): AutoFixTransition {
  return { session, effects: [] };
}

function current(session: AutoFixSession): AutoFixAttempt | undefined {
  return session.attempts[session.attempts.length - 1];
}

/** The session with its newest attempt patched. */
function withAttempt(session: AutoFixSession, patch: Partial<AutoFixAttempt>): AutoFixSession {
  const last = current(session);
  if (!last) return session;
  return { ...session, attempts: [...session.attempts.slice(0, -1), { ...last, ...patch }] };
}

function commit(session: AutoFixSession): AutoFixTransition {
  return {
    session: { ...session, phase: 'committing', blocker: null, message: null },
    effects: [{ type: 'commit', attempt: current(session)?.n ?? 0 }],
  };
}

function attention(
  session: AutoFixSession,
  blocker: AutoFixBlocker,
  message: string,
): AutoFixTransition {
  return {
    session: { ...session, phase: 'attention', blocker, message },
    effects: [{ type: 'notify', kind: 'attention' }],
  };
}

function runFinished(session: AutoFixSession, conclusion: string | null, now: number) {
  if (session.phase !== 'watching' || session.runId === null) return noEffects(session);
  const fixed = session.attempts.length > 0;
  if (conclusion === 'success') {
    return {
      session: {
        ...withAttempt(session, { outcome: 'passed' }),
        phase: 'succeeded' as const,
        message: fixed ? null : 'The run passed. Nothing to fix.',
      },
      effects: fixed ? [{ type: 'notify' as const, kind: 'fixed' as const }] : [],
    };
  }
  if (!conclusion || !FAILED_CONCLUSIONS.has(conclusion)) {
    return noEffects({
      ...session,
      phase: 'stopped',
      message: `The run was ${conclusion === 'cancelled' ? 'cancelled' : `left as ${conclusion ?? 'unknown'}`}, so there is nothing to fix.`,
    });
  }
  const tried = fixed ? withAttempt(session, { outcome: 'failed' }) : session;
  if (tried.attempts.length >= tried.maxAttempts) {
    const count = tried.attempts.length;
    return {
      session: {
        ...tried,
        phase: 'gave-up' as const,
        message: `The run still fails after ${count} ${count === 1 ? 'fix' : 'fixes'}.`,
      },
      effects: [{ type: 'notify' as const, kind: 'gave-up' as const }],
    };
  }
  const attempt: AutoFixAttempt = {
    n: tried.attempts.length + 1,
    runId: session.runId,
    runNumber: session.runNumber,
    startedAt: now,
    tabId: null,
    baseSha: null,
    commitSha: null,
    nextRunId: null,
    nextRunNumber: null,
    outcome: 'fixing',
  };
  return {
    session: { ...tried, phase: 'fixing' as const, attempts: [...tried.attempts, attempt] },
    effects: [{ type: 'launch' as const, attempt: attempt.n, runId: session.runId }],
  };
}

function agentEvent(session: AutoFixSession, status: AgentStatus, now: number) {
  const asking = session.phase === 'attention' && session.blocker === 'needs-input';
  if ((session.phase !== 'fixing' && !asking) || !session.agent) return noEffects(session);
  const agent = session.agent;
  switch (status) {
    case 'working':
      return noEffects({
        ...session,
        phase: 'fixing',
        blocker: null,
        message: null,
        agent: { ...agent, sawWork: true, quietSince: null },
      });
    case 'needs-input':
      if (asking) return noEffects(session);
      return attention(session, 'needs-input', 'The agent is waiting for an answer in its tab.');
    case 'exited':
      return commit(session);
    case 'done':
      if (agent.hooks) return commit(session);
      return noEffects({
        ...session,
        agent: { ...agent, sawWork: true, quietSince: agent.quietSince ?? now },
      });
    case 'idle':
      // A done the user already looked at reads idle, but idle before any work is a CLI
      // still starting up, not one that finished.
      if (!agent.sawWork || agent.quietSince !== null) return noEffects(session);
      return noEffects({ ...session, agent: { ...agent, quietSince: now } });
    default:
      return noEffects(session);
  }
}

function tick(session: AutoFixSession, now: number): AutoFixTransition {
  const quietSince = session.agent?.quietSince;
  if (
    session.phase === 'fixing' &&
    session.agent &&
    !session.agent.hooks &&
    quietSince != null &&
    now - quietSince >= AGENT_SETTLE_MS
  ) {
    return commit(session);
  }
  if (
    session.phase === 'waiting-run' &&
    session.waitFor &&
    now - session.waitFor.since >= RUN_WAIT_MS
  ) {
    return attention(
      session,
      'run-missing',
      session.waitFor.kind === 'commit'
        ? 'GitHub has not started a run for the pushed fix.'
        : 'GitHub has not started the run you dispatched.',
    );
  }
  return noEffects(session);
}

function retry(session: AutoFixSession, now: number): AutoFixTransition {
  if (session.phase !== 'attention' || !session.blocker) return noEffects(session);
  const cleared = { ...session, blocker: null, message: null };
  const last = current(session);
  if (LAUNCH_BLOCKERS.has(session.blocker) && last) {
    return {
      session: { ...withAttempt(cleared, { tabId: null }), phase: 'fixing', agent: null },
      effects: [{ type: 'launch', attempt: last.n, runId: last.runId }],
    };
  }
  if (session.blocker === 'commit-failed' || session.blocker === 'push-failed') {
    return commit(cleared);
  }
  if (session.blocker === 'run-missing' && session.waitFor) {
    return noEffects({
      ...cleared,
      phase: 'waiting-run',
      waitFor: { ...session.waitFor, since: now },
    });
  }
  return noEffects(session);
}

function step(session: AutoFixSession, event: AutoFixEvent, now: number): AutoFixTransition {
  switch (event.type) {
    case 'run-found': {
      if (session.phase !== 'waiting-run') return noEffects(session);
      const followed =
        session.waitFor?.kind === 'commit'
          ? withAttempt(session, { nextRunId: event.runId, nextRunNumber: event.runNumber })
          : session;
      return noEffects({
        ...followed,
        phase: 'watching',
        runId: event.runId,
        runNumber: event.runNumber,
        waitFor: null,
      });
    }
    case 'run-finished':
      return runFinished(session, event.conclusion, now);
    case 'launched':
      if (session.phase !== 'fixing') return noEffects(session);
      return noEffects({
        ...withAttempt(session, { tabId: event.tabId, baseSha: event.baseSha }),
        agent: { hooks: event.hooks, sawWork: false, quietSince: null },
      });
    case 'launch-blocked':
      if (session.phase !== 'fixing') return noEffects(session);
      return attention(session, event.blocker, event.message);
    case 'agent':
      return agentEvent(session, event.status, now);
    case 'committed': {
      if (session.phase !== 'committing') return noEffects(session);
      const result = event.result;
      if (result.kind === 'pushed') {
        return noEffects({
          ...withAttempt(session, { commitSha: result.sha, outcome: 'pushed' }),
          phase: 'waiting-run',
          runId: null,
          runNumber: null,
          waitFor: { kind: 'commit', sha: result.sha, since: now },
          agent: null,
        });
      }
      if (result.kind === 'no-change') {
        return {
          session: {
            ...withAttempt(session, { outcome: 'no-change' }),
            phase: 'gave-up',
            message: 'The agent finished without changing any files, so there was nothing to push.',
          },
          effects: [{ type: 'notify', kind: 'gave-up' }],
        };
      }
      return attention(session, result.blocker, result.message);
    }
    case 'agent-lost':
      if (session.phase !== 'fixing' || !current(session)?.tabId) return noEffects(session);
      return attention(
        session,
        'agent-lost',
        'Runova lost track of the agent tab. Check its work, then commit it or press Retry for a new agent.',
      );
    case 'resumed':
      if (session.phase === 'committing') {
        return attention(
          session,
          'commit-failed',
          'Runova closed while committing the fix. Press Retry to commit and push it.',
        );
      }
      if (session.phase === 'fixing' && !current(session)?.tabId) {
        return attention(
          session,
          'launch-failed',
          'Runova closed before the agent started. Press Retry to start it.',
        );
      }
      return noEffects(session);
    case 'commit-now': {
      const blocked =
        session.phase === 'attention' &&
        session.blocker !== null &&
        COMMITTABLE_BLOCKERS.has(session.blocker);
      if ((session.phase !== 'fixing' && !blocked) || !current(session)?.tabId) {
        return noEffects(session);
      }
      return commit(session);
    }
    case 'retry':
      return retry(session, now);
    case 'stop': {
      const last = current(session);
      const cancelled =
        last?.outcome === 'fixing' ? withAttempt(session, { outcome: 'cancelled' }) : session;
      return noEffects({
        ...cancelled,
        phase: 'stopped',
        blocker: null,
        message: 'Stopped by you.',
        agent: null,
      });
    }
    case 'tick':
      return tick(session, now);
  }
}

/** The next session after `event`, and what the service has to do about it. */
export function reduceAutoFix(
  session: AutoFixSession,
  event: AutoFixEvent,
  now: number,
): AutoFixTransition {
  if (AUTO_FIX_FINISHED.includes(session.phase)) return noEffects(session);
  const next = step(session, event, now);
  if (next.session === session) return next;
  return { ...next, session: { ...next.session, updatedAt: now } };
}
