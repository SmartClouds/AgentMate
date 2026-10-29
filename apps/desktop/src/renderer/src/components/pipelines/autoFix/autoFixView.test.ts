import type { AutoFixAttempt, AutoFixSession } from '@shared/ciAutoFixTypes';
import { describe, expect, it } from 'vitest';
import { attemptRuns, isAutoFixActive, phaseView, sessionForRun } from './autoFixView';

/**
 * The chip on a run row is often the only sign an agent is about to push to the branch, so it
 * says in words where auto-fix stands and how many tries are left, not just in colour.
 */

function attempt(patch: Partial<AutoFixAttempt> = {}): AutoFixAttempt {
  return {
    n: 1,
    runId: 100,
    runNumber: 7,
    startedAt: 0,
    tabId: 'tab-1',
    baseSha: 'aaa',
    commitSha: null,
    nextRunId: null,
    nextRunNumber: null,
    outcome: 'fixing',
    ...patch,
  };
}

function session(patch: Partial<AutoFixSession> = {}): AutoFixSession {
  return {
    id: 'fix-1',
    projectId: 'proj-1',
    projectName: 'Shop',
    repo: 'acme/shop',
    workflowId: 9,
    workflowName: 'CI',
    branch: 'main',
    cliId: 'claude-code',
    runArgs: [],
    runLabel: null,
    maxAttempts: 3,
    runId: 100,
    runNumber: 7,
    waitFor: null,
    phase: 'watching',
    blocker: null,
    message: null,
    attempts: [],
    agent: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe('phaseView', () => {
  it('says auto-fix is on while the first run is still going', () => {
    expect(phaseView(session())).toMatchObject({
      label: 'Auto-fix on',
      tone: 'primary',
      pulse: false,
    });
    expect(phaseView(session()).description).toBe(
      'If run #7 fails, Claude Code CLI fixes it and Runova pushes the fix to main. Up to 3 tries.',
    );
  });

  it('counts the tries while fixing and while checking a fix', () => {
    const fixing = session({ phase: 'fixing', attempts: [attempt()] });
    expect(phaseView(fixing)).toMatchObject({ label: 'Fixing 1/3', pulse: true });
    const checking = session({
      phase: 'watching',
      runNumber: 8,
      attempts: [attempt({ outcome: 'pushed', commitSha: 'bbbbbbb1234' })],
    });
    expect(phaseView(checking)).toMatchObject({ label: 'Checking fix 1/3', pulse: true });
    expect(phaseView(checking).description).toBe('Waiting for run #8, which tests fix bbbbbbb.');
  });

  it('shows pushing and waiting for the run', () => {
    expect(phaseView(session({ phase: 'committing', attempts: [attempt()] })).label).toBe(
      'Pushing',
    );
    expect(phaseView(session({ phase: 'waiting-run', runId: null })).label).toBe('Waiting for run');
  });

  it('puts what the user has to do in the description when it needs them', () => {
    const view = phaseView(
      session({ phase: 'attention', blocker: 'dirty-tree', message: 'Commit or stash first.' }),
    );
    expect(view).toMatchObject({
      label: 'Needs you',
      tone: 'warning',
      description: 'Commit or stash first.',
    });
  });

  it('says how many tries a fix took', () => {
    expect(
      phaseView(session({ phase: 'succeeded', attempts: [attempt({ outcome: 'passed' })] })).label,
    ).toBe('Fixed in 1 try');
    expect(
      phaseView(
        session({
          phase: 'succeeded',
          attempts: [attempt({ outcome: 'failed' }), attempt({ n: 2, outcome: 'passed' })],
        }),
      ).label,
    ).toBe('Fixed in 2 tries');
    expect(phaseView(session({ phase: 'succeeded' })).label).toBe('Passed');
  });

  it('marks the ends that did not fix the run', () => {
    expect(phaseView(session({ phase: 'gave-up', message: 'Still failing.' }))).toMatchObject({
      label: 'Gave up',
      tone: 'destructive',
      description: 'Still failing.',
    });
    expect(phaseView(session({ phase: 'stopped' }))).toMatchObject({
      label: 'Auto-fix off',
      tone: 'neutral',
    });
  });
});

describe('sessionForRun', () => {
  it('finds the session following a run, or one that fixed it or started it', () => {
    const fixed = session({
      id: 'a',
      runId: 101,
      attempts: [attempt({ runId: 100, nextRunId: 101 })],
      createdAt: 1,
    });
    expect(sessionForRun([fixed], 'acme/shop', 100)?.id).toBe('a');
    expect(sessionForRun([fixed], 'acme/shop', 101)?.id).toBe('a');
    expect(sessionForRun([fixed], 'acme/shop', 55)).toBeNull();
    expect(sessionForRun([fixed], 'acme/other', 100)).toBeNull();
  });

  it('prefers the newest session when two touched the same run', () => {
    const older = session({ id: 'old', createdAt: 1, phase: 'stopped' });
    const newer = session({ id: 'new', createdAt: 2 });
    expect(sessionForRun([older, newer], 'acme/shop', 100)?.id).toBe('new');
  });
});

describe('isAutoFixActive', () => {
  it('is false only for the finished phases', () => {
    expect(isAutoFixActive(session())).toBe(true);
    expect(isAutoFixActive(session({ phase: 'attention' }))).toBe(true);
    expect(isAutoFixActive(session({ phase: 'gave-up' }))).toBe(false);
  });
});

describe('attemptRuns', () => {
  it('lists the failed run and the run the fix started, with how each ended', () => {
    expect(
      attemptRuns(
        attempt({ outcome: 'pushed', commitSha: 'bbbbbbb1234', nextRunId: 101, nextRunNumber: 8 }),
      ),
    ).toEqual({ failed: '#7', commit: 'bbbbbbb', next: '#8', nextState: 'running' });
    expect(
      attemptRuns(attempt({ outcome: 'failed', nextRunId: 101, nextRunNumber: 8 })).nextState,
    ).toBe('failed');
    expect(attemptRuns(attempt({ outcome: 'passed', nextRunNumber: 8 })).nextState).toBe('passed');
    expect(attemptRuns(attempt()).next).toBeNull();
  });
});
