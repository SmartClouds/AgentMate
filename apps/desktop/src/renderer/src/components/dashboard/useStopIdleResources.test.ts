import type { ResourceStopResult } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { summarizeStop } from './useStopIdleResources';

function result(overrides: Partial<ResourceStopResult> = {}): ResourceStopResult {
  return {
    ref: { kind: 'docker', id: 'a' },
    name: 'db',
    ok: true,
    ...overrides,
  };
}

describe('summarizeStop', () => {
  it('names a single container it stopped', () => {
    expect(summarizeStop([result()])).toEqual({ tone: 'success', message: 'Stopped db.' });
  });

  it('counts several', () => {
    const many = [result(), result({ name: 'redis' }), result({ name: 'Pixel_7' })];
    expect(summarizeStop(many)).toEqual({ tone: 'success', message: 'Stopped 3 idle items.' });
  });

  it('adds what was left running because it became busy', () => {
    const outcome = summarizeStop([
      result(),
      result({ name: 'redis' }),
      result({ name: 'web', ok: false, skipped: 'active' }),
    ]);
    expect(outcome).toEqual({
      tone: 'success',
      message: 'Stopped 2 idle items. 1 became active again, so it was left running.',
    });
  });

  it('says why one failed', () => {
    expect(summarizeStop([result({ ok: false, message: 'permission denied' })])).toEqual({
      tone: 'error',
      message: 'Could not stop db: permission denied',
    });
  });

  it('falls back to a plain sentence when there is no reason', () => {
    expect(summarizeStop([result({ ok: false })]).message).toBe('Could not stop db.');
  });

  it('reports a partial success as an error, with the first failure', () => {
    const outcome = summarizeStop([
      result(),
      result({ name: 'redis', ok: false, message: 'timed out' }),
    ]);
    expect(outcome).toEqual({
      tone: 'error',
      message: 'Stopped 1 of 2. redis did not stop: timed out',
    });
  });

  it('counts several failures when nothing stopped', () => {
    const outcome = summarizeStop([
      result({ ok: false, message: 'daemon busy' }),
      result({ name: 'redis', ok: false, message: 'daemon busy' }),
    ]);
    expect(outcome).toEqual({ tone: 'error', message: 'Could not stop 2 of them: daemon busy' });
  });

  it('is informational when everything had become busy', () => {
    expect(summarizeStop([result({ ok: false, skipped: 'active' })])).toEqual({
      tone: 'info',
      message: 'db became active again, so it was left running.',
    });
    expect(
      summarizeStop([
        result({ ok: false, skipped: 'active' }),
        result({ name: 'redis', ok: false, skipped: 'active' }),
      ]).message,
    ).toBe('2 became active again, so they were left running.');
  });

  it('is informational when the resources had already gone', () => {
    expect(summarizeStop([result({ ok: false, skipped: 'gone' })]).message).toBe(
      'It is not running any more.',
    );
    expect(
      summarizeStop([
        result({ ok: false, skipped: 'gone' }),
        result({ name: 'redis', ok: false, skipped: 'gone' }),
      ]).message,
    ).toBe('None of them are running any more.');
  });
});
