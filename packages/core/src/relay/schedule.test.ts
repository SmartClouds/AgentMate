import { describe, expect, it } from 'vitest';
import { describeTrigger, type TriggerContext, triggerVerdict } from './schedule.js';

const NOW = 1_760_000_000_000;

function context(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    now: NOW,
    taskStatus: () => 'todo',
    sessionState: () => 'working',
    ...overrides,
  };
}

describe('triggerVerdict', () => {
  it('starts now at once', () => {
    expect(triggerVerdict({ kind: 'now' }, context())).toEqual({ ready: true });
  });

  it('waits for the time to come', () => {
    expect(triggerVerdict({ kind: 'at', at: NOW + 1 }, context()).ready).toBe(false);
    expect(triggerVerdict({ kind: 'at', at: NOW }, context()).ready).toBe(true);
  });

  it('waits for another task to be done', () => {
    const trigger = { kind: 'after-task', projectId: 'p1', taskId: 'T004' } as const;
    expect(triggerVerdict(trigger, context({ taskStatus: () => 'in-progress' })).ready).toBe(false);
    expect(triggerVerdict(trigger, context({ taskStatus: () => 'testing' })).ready).toBe(false);
    expect(triggerVerdict(trigger, context({ taskStatus: () => 'done' }))).toEqual({ ready: true });
  });

  it('says so when the task it waits for is gone', () => {
    const verdict = triggerVerdict(
      { kind: 'after-task', projectId: 'p1', taskId: 'T004' },
      context({ taskStatus: () => null }),
    );
    expect(verdict).toEqual({ ready: false, problem: expect.stringContaining('T004') });
  });

  it('waits for a busy session to finish, end or close', () => {
    const trigger = { kind: 'after-session', sessionId: 'tab-1' } as const;
    for (const state of ['working', 'needs-input'] as const) {
      expect(triggerVerdict(trigger, context({ sessionState: () => state })).ready).toBe(false);
    }
    for (const state of ['done', 'idle', 'exited', 'gone'] as const) {
      expect(triggerVerdict(trigger, context({ sessionState: () => state })).ready).toBe(true);
    }
  });
});

describe('describeTrigger', () => {
  it('reads as a sentence', () => {
    expect(describeTrigger({ kind: 'now' })).toBe('Starts now');
    expect(describeTrigger({ kind: 'after-task', projectId: 'p1', taskId: 'T004' })).toBe(
      'Starts when T004 is done',
    );
    expect(
      describeTrigger({ kind: 'after-session', sessionId: 'tab-1', label: 'Claude Code 2' }),
    ).toBe('Starts when Claude Code 2 finishes');
    expect(describeTrigger({ kind: 'after-session', sessionId: 'tab-1' })).toBe(
      'Starts when that session finishes',
    );
    expect(
      describeTrigger({ kind: 'at', at: NOW }, { formatTime: (at) => `at ${at === NOW}` }),
    ).toBe('Starts at true');
  });
});
