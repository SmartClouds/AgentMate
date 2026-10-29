import { describe, expect, it } from 'vitest';
import type { AutoFixSession } from '../../../shared/ciAutoFixTypes';
import {
  AGENT_SETTLE_MS,
  type AutoFixEvent,
  createAutoFixSession,
  RUN_WAIT_MS,
  reduceAutoFix,
} from './machine';

/**
 * Auto-fix commits and pushes to the user's branch with nobody watching, so the cases that matter
 * are the ones about stopping: at the attempt limit, when the agent changed nothing, when it asks
 * a question, and when a CLI without hooks has only gone quiet rather than finished.
 */

const T0 = 1_000_000;

function session(patch: Partial<AutoFixSession> = {}): AutoFixSession {
  return {
    ...createAutoFixSession(
      {
        projectId: 'proj-1',
        projectName: 'Shop',
        repo: 'acme/shop',
        workflowId: 9,
        workflowName: 'CI',
        branch: 'main',
        runId: 100,
        runNumber: 7,
        cliId: 'claude-code',
        runArgs: [],
        runLabel: null,
        maxAttempts: 3,
      },
      'fix-1',
      T0,
    ),
    ...patch,
  };
}

/** Feeds events one after another, collecting every effect, like the service does. */
function play(start: AutoFixSession, events: [AutoFixEvent, number?][]) {
  let current = start;
  const effects: ReturnType<typeof reduceAutoFix>['effects'] = [];
  for (const [event, at] of events) {
    const next = reduceAutoFix(current, event, at ?? T0);
    current = next.session;
    effects.push(...next.effects);
  }
  return { session: current, effects };
}

const failed: AutoFixEvent = { type: 'run-finished', conclusion: 'failure' };
const launched = (hooks = true): AutoFixEvent => ({
  type: 'launched',
  tabId: 'tab-1',
  baseSha: 'aaa',
  hooks,
});

describe('createAutoFixSession', () => {
  it('follows the given run straight away', () => {
    const s = session();
    expect(s).toMatchObject({ phase: 'watching', runId: 100, runNumber: 7, waitFor: null });
    expect(s.attempts).toEqual([]);
  });

  it('waits for the dispatched run when there is no run id yet', () => {
    const s = createAutoFixSession(
      {
        projectId: 'p',
        projectName: 'P',
        repo: 'a/b',
        workflowId: 1,
        workflowName: 'CI',
        branch: 'main',
        runId: null,
        runNumber: null,
        cliId: 'codex-cli',
        runArgs: [],
        runLabel: null,
        maxAttempts: 2,
      },
      'fix-2',
      T0,
    );
    expect(s).toMatchObject({
      phase: 'waiting-run',
      runId: null,
      waitFor: { kind: 'dispatch', since: T0 },
    });
  });
});

describe('a run that finishes', () => {
  it('ends the session quietly when it passes before any fix', () => {
    const { session: s, effects } = play(session(), [
      [{ type: 'run-finished', conclusion: 'success' }],
    ]);
    expect(s.phase).toBe('succeeded');
    expect(effects).toEqual([]);
  });

  it('starts attempt 1 when it fails', () => {
    const { session: s, effects } = play(session(), [[failed, T0 + 5]]);
    expect(s.phase).toBe('fixing');
    expect(s.attempts).toEqual([
      expect.objectContaining({ n: 1, runId: 100, runNumber: 7, outcome: 'fixing', tabId: null }),
    ]);
    expect(effects).toEqual([{ type: 'launch', attempt: 1, runId: 100 }]);
  });

  it('treats a time out like a failure', () => {
    const { session: s } = play(session(), [[{ type: 'run-finished', conclusion: 'timed_out' }]]);
    expect(s.phase).toBe('fixing');
  });

  it('stops when the run was cancelled, since there is nothing to fix', () => {
    const { session: s, effects } = play(session(), [
      [{ type: 'run-finished', conclusion: 'cancelled' }],
    ]);
    expect(s.phase).toBe('stopped');
    expect(s.message).toMatch(/cancelled/);
    expect(effects).toEqual([]);
  });
});

describe('the agent', () => {
  it('records the tab and HEAD when it starts', () => {
    const { session: s } = play(session(), [[failed], [launched()]]);
    expect(s.attempts[0]).toMatchObject({ tabId: 'tab-1', baseSha: 'aaa' });
    expect(s.agent).toEqual({ hooks: true, sawWork: false, quietSince: null });
  });

  it('goes to the user when the launch is blocked, with the reason', () => {
    const { session: s, effects } = play(session(), [
      [failed],
      [{ type: 'launch-blocked', blocker: 'dirty-tree', message: 'You have uncommitted changes.' }],
    ]);
    expect(s).toMatchObject({
      phase: 'attention',
      blocker: 'dirty-tree',
      message: 'You have uncommitted changes.',
    });
    expect(effects).toContainEqual({ type: 'notify', kind: 'attention' });
  });

  it('commits as soon as a CLI with hooks says it is done', () => {
    const { session: s, effects } = play(session(), [
      [failed],
      [launched(true)],
      [{ type: 'agent', status: 'working' }],
      [{ type: 'agent', status: 'done' }],
    ]);
    expect(s.phase).toBe('committing');
    expect(effects).toContainEqual({ type: 'commit', attempt: 1 });
  });

  it('waits for a CLI without hooks to stay quiet for the settle window', () => {
    const start = play(session(), [
      [failed],
      [launched(false)],
      [{ type: 'agent', status: 'working' }, T0 + 1000],
      [{ type: 'agent', status: 'done' }, T0 + 9000],
    ]);
    expect(start.session.phase).toBe('fixing');
    expect(start.effects).not.toContainEqual(expect.objectContaining({ type: 'commit' }));

    const early = reduceAutoFix(start.session, { type: 'tick' }, T0 + 9000 + AGENT_SETTLE_MS - 1);
    expect(early.session.phase).toBe('fixing');

    const settled = reduceAutoFix(start.session, { type: 'tick' }, T0 + 9000 + AGENT_SETTLE_MS);
    expect(settled.session.phase).toBe('committing');
    expect(settled.effects).toEqual([{ type: 'commit', attempt: 1 }]);
  });

  it('starts the settle window over when the agent picks up work again', () => {
    const { session: s } = play(session(), [
      [failed],
      [launched(false)],
      [{ type: 'agent', status: 'working' }, T0],
      [{ type: 'agent', status: 'done' }, T0 + 5000],
      [{ type: 'agent', status: 'working' }, T0 + 20_000],
      [{ type: 'tick' }, T0 + 5000 + AGENT_SETTLE_MS],
    ]);
    expect(s.phase).toBe('fixing');
    expect(s.agent?.quietSince).toBeNull();
  });

  it('counts a done that the user already looked at (idle) as quiet too', () => {
    const { session: s } = play(session(), [
      [failed],
      [launched(false)],
      [{ type: 'agent', status: 'working' }, T0],
      [{ type: 'agent', status: 'idle' }, T0 + 5000],
      [{ type: 'tick' }, T0 + 5000 + AGENT_SETTLE_MS],
    ]);
    expect(s.phase).toBe('committing');
  });

  it('does not take idle before any work as finished: the CLI is still starting', () => {
    const { session: s } = play(session(), [
      [failed],
      [launched(false)],
      [{ type: 'agent', status: 'idle' }, T0],
      [{ type: 'tick' }, T0 + AGENT_SETTLE_MS * 3],
    ]);
    expect(s.phase).toBe('fixing');
  });

  it('asks the user when the agent needs an answer, and carries on once it works again', () => {
    const asked = play(session(), [
      [failed],
      [launched()],
      [{ type: 'agent', status: 'needs-input' }],
    ]);
    expect(asked.session).toMatchObject({ phase: 'attention', blocker: 'needs-input' });
    expect(asked.effects).toContainEqual({ type: 'notify', kind: 'attention' });

    const resumed = reduceAutoFix(asked.session, { type: 'agent', status: 'working' }, T0 + 10);
    expect(resumed.session).toMatchObject({ phase: 'fixing', blocker: null, message: null });
  });

  it('commits what is there when the CLI exits', () => {
    const { session: s, effects } = play(session(), [
      [failed],
      [launched(false)],
      [{ type: 'agent', status: 'exited' }],
    ]);
    expect(s.phase).toBe('committing');
    expect(effects).toContainEqual({ type: 'commit', attempt: 1 });
  });

  it('lets the user commit before the agent is judged done', () => {
    const { session: s, effects } = play(session(), [
      [failed],
      [launched(false)],
      [{ type: 'commit-now' }],
    ]);
    expect(s.phase).toBe('committing');
    expect(effects).toContainEqual({ type: 'commit', attempt: 1 });
  });

  it('ignores Commit & push now before there is a tab', () => {
    const { session: s, effects } = play(session(), [[failed], [{ type: 'commit-now' }]]);
    expect(s.phase).toBe('fixing');
    expect(effects).toEqual([{ type: 'launch', attempt: 1, runId: 100 }]);
  });
});

describe('committing', () => {
  const committing = () =>
    play(session(), [[failed], [launched()], [{ type: 'agent', status: 'done' }]]);

  it('waits for the run of the pushed commit', () => {
    const { session: s } = play(committing().session, [
      [{ type: 'committed', result: { kind: 'pushed', sha: 'bbb' } }, T0 + 50],
    ]);
    expect(s).toMatchObject({
      phase: 'waiting-run',
      runId: null,
      waitFor: { kind: 'commit', sha: 'bbb', since: T0 + 50 },
      agent: null,
    });
    expect(s.attempts[0]).toMatchObject({ commitSha: 'bbb', outcome: 'pushed' });
  });

  it('gives up when the agent changed nothing, since retrying would loop', () => {
    const { session: s, effects } = play(committing().session, [
      [{ type: 'committed', result: { kind: 'no-change' } }],
    ]);
    expect(s.phase).toBe('gave-up');
    expect(s.attempts[0].outcome).toBe('no-change');
    expect(s.message).toMatch(/without changing any files/);
    expect(effects).toEqual([{ type: 'notify', kind: 'gave-up' }]);
  });

  it('goes to the user when the push is refused, and Retry pushes again', () => {
    const blocked = play(committing().session, [
      [
        {
          type: 'committed',
          result: { kind: 'blocked', blocker: 'push-failed', message: 'The push was rejected.' },
        },
      ],
    ]);
    expect(blocked.session).toMatchObject({ phase: 'attention', blocker: 'push-failed' });
    const retried = reduceAutoFix(blocked.session, { type: 'retry' }, T0 + 1);
    expect(retried.session.phase).toBe('committing');
    expect(retried.effects).toEqual([{ type: 'commit', attempt: 1 }]);
  });
});

describe('following the fix', () => {
  const pushed = () =>
    play(session(), [
      [failed],
      [launched()],
      [{ type: 'agent', status: 'done' }],
      [{ type: 'committed', result: { kind: 'pushed', sha: 'bbb' } }],
    ]).session;

  it('follows the new run once it shows up', () => {
    const { session: s } = play(pushed(), [[{ type: 'run-found', runId: 101, runNumber: 8 }]]);
    expect(s).toMatchObject({ phase: 'watching', runId: 101, runNumber: 8, waitFor: null });
    expect(s.attempts[0]).toMatchObject({ nextRunId: 101, nextRunNumber: 8 });
  });

  it('succeeds and tells the user when the fix makes the run pass', () => {
    const { session: s, effects } = play(pushed(), [
      [{ type: 'run-found', runId: 101, runNumber: 8 }],
      [{ type: 'run-finished', conclusion: 'success' }],
    ]);
    expect(s.phase).toBe('succeeded');
    expect(s.attempts[0].outcome).toBe('passed');
    expect(effects).toEqual([{ type: 'notify', kind: 'fixed' }]);
  });

  it('tries again on the new failure, up to the limit, then gives up', () => {
    let s = pushed();
    for (const [n, runId] of [
      [2, 101],
      [3, 102],
    ] as const) {
      s = play(s, [[{ type: 'run-found', runId, runNumber: runId - 93 }], [failed]]).session;
      expect(s.attempts[n - 2].outcome).toBe('failed');
      expect(s.attempts).toHaveLength(n);
      expect(s.phase).toBe('fixing');
      s = play(s, [
        [launched()],
        [{ type: 'agent', status: 'done' }],
        [{ type: 'committed', result: { kind: 'pushed', sha: `sha${n}` } }],
      ]).session;
    }
    const last = play(s, [[{ type: 'run-found', runId: 103, runNumber: 10 }], [failed]]);
    expect(last.session.phase).toBe('gave-up');
    expect(last.session.attempts).toHaveLength(3);
    expect(last.session.message).toBe('The run still fails after 3 fixes.');
    expect(last.effects).toEqual([{ type: 'notify', kind: 'gave-up' }]);
  });

  it('goes to the user when no run starts for the pushed commit', () => {
    const s = pushed();
    expect(reduceAutoFix(s, { type: 'tick' }, T0 + RUN_WAIT_MS - 1).session.phase).toBe(
      'waiting-run',
    );
    const late = reduceAutoFix(s, { type: 'tick' }, T0 + RUN_WAIT_MS);
    expect(late.session).toMatchObject({ phase: 'attention', blocker: 'run-missing' });
    const retried = reduceAutoFix(late.session, { type: 'retry' }, T0 + RUN_WAIT_MS + 5);
    expect(retried.session).toMatchObject({
      phase: 'waiting-run',
      waitFor: { kind: 'commit', sha: 'bbb', since: T0 + RUN_WAIT_MS + 5 },
    });
  });
});

describe('the user', () => {
  it('can retry a blocked launch, which launches the same attempt again', () => {
    const blocked = play(session(), [
      [failed],
      [{ type: 'launch-blocked', blocker: 'wrong-branch', message: 'Switch to main.' }],
    ]).session;
    const { session: s, effects } = play(blocked, [[{ type: 'retry' }]]);
    expect(s).toMatchObject({ phase: 'fixing', blocker: null, message: null });
    expect(s.attempts).toHaveLength(1);
    expect(effects).toEqual([{ type: 'launch', attempt: 1, runId: 100 }]);
  });

  it('can stop at any point, which cancels the attempt in progress', () => {
    const { session: s, effects } = play(session(), [[failed], [launched()], [{ type: 'stop' }]]);
    expect(s.phase).toBe('stopped');
    expect(s.attempts[0].outcome).toBe('cancelled');
    expect(effects).toEqual([{ type: 'launch', attempt: 1, runId: 100 }]);
  });

  it('cannot move a finished session', () => {
    const done = play(session(), [[{ type: 'run-finished', conclusion: 'success' }]]).session;
    for (const event of [
      { type: 'stop' },
      { type: 'retry' },
      failed,
      { type: 'tick' },
    ] as AutoFixEvent[]) {
      const next = reduceAutoFix(done, event, T0 + 99);
      expect(next.session).toBe(done);
      expect(next.effects).toEqual([]);
    }
  });
});

describe('losing the agent', () => {
  it('asks the user when the tab is no longer tracked, and lets them commit what is there', () => {
    const lost = play(session(), [[failed], [launched()], [{ type: 'agent-lost' }]]);
    expect(lost.session).toMatchObject({ phase: 'attention', blocker: 'agent-lost' });
    expect(lost.effects).toContainEqual({ type: 'notify', kind: 'attention' });
    const committed = reduceAutoFix(lost.session, { type: 'commit-now' }, T0 + 1);
    expect(committed.effects).toEqual([{ type: 'commit', attempt: 1 }]);
  });

  it('starts a new agent for the same attempt on Retry', () => {
    const lost = play(session(), [[failed], [launched()], [{ type: 'agent-lost' }]]).session;
    const retried = reduceAutoFix(lost, { type: 'retry' }, T0 + 1);
    expect(retried.session.attempts[0].tabId).toBeNull();
    expect(retried.effects).toEqual([{ type: 'launch', attempt: 1, runId: 100 }]);
  });

  it('ignores a lost agent before one was launched', () => {
    const fixing = play(session(), [[failed]]).session;
    expect(reduceAutoFix(fixing, { type: 'agent-lost' }, T0 + 1).session).toBe(fixing);
  });
});

describe('after a restart', () => {
  it('asks to retry a commit the app closed in the middle of', () => {
    const committing = play(session(), [
      [failed],
      [launched()],
      [{ type: 'agent', status: 'done' }],
    ]).session;
    const { session: s } = play(committing, [[{ type: 'resumed' }]]);
    expect(s).toMatchObject({ phase: 'attention', blocker: 'commit-failed' });
    expect(s.message).toMatch(/closed while committing/);
  });

  it('asks to retry a launch the app closed before the agent started', () => {
    const { session: s } = play(session(), [[failed], [{ type: 'resumed' }]]);
    expect(s).toMatchObject({ phase: 'attention', blocker: 'launch-failed' });
  });

  it('leaves a session with a running agent or a run to follow alone', () => {
    const watching = session();
    expect(reduceAutoFix(watching, { type: 'resumed' }, T0 + 1).session).toBe(watching);
    const fixing = play(session(), [[failed], [launched()]]).session;
    expect(reduceAutoFix(fixing, { type: 'resumed' }, T0 + 1).session).toBe(fixing);
  });
});

describe('stale events', () => {
  it('ignores a launch result that lands after the user stopped', () => {
    const stopped = play(session(), [[failed], [{ type: 'stop' }]]).session;
    const next = reduceAutoFix(stopped, launched(), T0 + 1);
    expect(next.session).toBe(stopped);
  });

  it('ignores agent status while committing', () => {
    const committing = play(session(), [
      [failed],
      [launched()],
      [{ type: 'agent', status: 'done' }],
    ]).session;
    const next = reduceAutoFix(committing, { type: 'agent', status: 'needs-input' }, T0 + 1);
    expect(next.session).toBe(committing);
  });

  it('stamps updatedAt only when something changed', () => {
    const start = session();
    expect(reduceAutoFix(start, { type: 'tick' }, T0 + 500).session).toBe(start);
    expect(reduceAutoFix(start, failed, T0 + 500).session.updatedAt).toBe(T0 + 500);
  });
});
