import { getCliDefinition } from '@runova/core';
import {
  AUTO_FIX_FINISHED,
  type AutoFixAttempt,
  type AutoFixSession,
} from '@shared/ciAutoFixTypes';
import type { ChipTone } from '@/components/pageKit';

export interface AutoFixPhaseView {
  /** A few words for the chip. */
  label: string;
  tone: ChipTone;
  /** Something is under way. */
  pulse: boolean;
  /** One sentence on where the session stands, for a tooltip or the panel. */
  description: string;
}

export function isAutoFixActive(session: AutoFixSession): boolean {
  return !AUTO_FIX_FINISHED.includes(session.phase);
}

export function cliName(cliId: string): string {
  return getCliDefinition(cliId)?.name ?? cliId;
}

function tries(count: number): string {
  return `${count} ${count === 1 ? 'try' : 'tries'}`;
}

function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 7) : null;
}

export function phaseView(session: AutoFixSession): AutoFixPhaseView {
  const last = session.attempts[session.attempts.length - 1];
  const count = `${session.attempts.length}/${session.maxAttempts}`;
  const run = session.runNumber ? `run #${session.runNumber}` : 'the run';
  switch (session.phase) {
    case 'watching':
      if (!last) {
        return {
          label: 'Auto-fix on',
          tone: 'primary',
          pulse: false,
          description: `If ${run} fails, ${cliName(session.cliId)} fixes it and Runova pushes the fix to ${session.branch}. Up to ${tries(session.maxAttempts)}.`,
        };
      }
      return {
        label: `Checking fix ${count}`,
        tone: 'primary',
        pulse: true,
        description: `Waiting for ${run}, which tests fix ${shortSha(last.commitSha) ?? 'the fix'}.`,
      };
    case 'waiting-run':
      return {
        label: 'Waiting for run',
        tone: 'primary',
        pulse: true,
        description: last?.commitSha
          ? `Pushed ${shortSha(last.commitSha)}. Waiting for GitHub to start its run.`
          : 'Waiting for GitHub to start the run you dispatched.',
      };
    case 'fixing':
      return {
        label: `Fixing ${count}`,
        tone: 'primary',
        pulse: true,
        description: last?.tabId
          ? `${cliName(session.cliId)} is working on the failure in its tab.`
          : `Reading the failure and starting ${cliName(session.cliId)}.`,
      };
    case 'committing':
      return {
        label: 'Pushing',
        tone: 'primary',
        pulse: true,
        description: `Committing the fix and pushing it to ${session.branch}.`,
      };
    case 'attention':
      return {
        label: 'Needs you',
        tone: 'warning',
        pulse: false,
        description: session.message ?? 'Auto-fix is waiting for you.',
      };
    case 'succeeded':
      return {
        label: last ? `Fixed in ${tries(session.attempts.length)}` : 'Passed',
        tone: 'success',
        pulse: false,
        description: last
          ? `${session.workflowName} passes on ${session.branch} again.`
          : (session.message ?? 'The run passed. Nothing to fix.'),
      };
    case 'gave-up':
      return {
        label: 'Gave up',
        tone: 'destructive',
        pulse: false,
        description: session.message ?? 'Auto-fix could not make the run pass.',
      };
    case 'stopped':
      return {
        label: 'Auto-fix off',
        tone: 'neutral',
        pulse: false,
        description: session.message ?? 'Auto-fix was switched off.',
      };
  }
}

/** The newest session that follows this run, fixed it, or was started by its fix. */
export function sessionForRun(
  sessions: readonly AutoFixSession[],
  repo: string,
  runId: number,
): AutoFixSession | null {
  const matches = sessions.filter(
    (session) =>
      session.repo === repo &&
      (session.runId === runId ||
        session.attempts.some((item) => item.runId === runId || item.nextRunId === runId)),
  );
  return matches.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** One attempt's runs, as the panel's timeline shows them. */
export function attemptRuns(attempt: AutoFixAttempt): {
  failed: string;
  commit: string | null;
  next: string | null;
  nextState: 'running' | 'passed' | 'failed';
} {
  return {
    failed: attempt.runNumber ? `#${attempt.runNumber}` : 'the run',
    commit: shortSha(attempt.commitSha),
    next: attempt.nextRunNumber ? `#${attempt.nextRunNumber}` : null,
    nextState:
      attempt.outcome === 'passed' ? 'passed' : attempt.outcome === 'failed' ? 'failed' : 'running',
  };
}
