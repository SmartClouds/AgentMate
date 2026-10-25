import { describe, expect, it } from 'vitest';
import {
  applyJobEvent,
  cleanInstallerLine,
  type DevJobEvent,
  type DevJobState,
  EMPTY_JOB_STATE,
  explainWingetExit,
  MAX_LOG_LINES,
  overallFraction,
  parseInstallerProgress,
  phaseFromInstallerLine,
} from './jobEvents.js';

/**
 * The installer reports what it is doing as a stream of small events, and the page folds them into
 * one state. A late event from a finished run, a failure that must stick until retried, and a
 * progress bar that must never run backwards are the things that go wrong here, so they are pinned.
 */

function run(events: DevJobEvent[], from: DevJobState = EMPTY_JOB_STATE): DevJobState {
  return events.reduce(applyJobEvent, from);
}

describe('applyJobEvent', () => {
  it('starts with nothing running', () => {
    expect(EMPTY_JOB_STATE).toMatchObject({ jobId: null, running: false, items: {}, order: [] });
  });

  it('queues every step of a new run', () => {
    const state = run([{ type: 'plan', jobId: 'a', steps: ['git', 'node'] }]);

    expect(state).toMatchObject({
      jobId: 'a',
      running: true,
      order: ['git', 'node'],
      items: { git: { status: 'queued' }, node: { status: 'queued' } },
      current: null,
    });
  });

  it('moves an item to installing when it starts, and makes it the current one', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git', 'node'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
    ]);

    expect(state.current).toBe('git');
    expect(state.items.git).toEqual({ status: 'installing', phase: 'preparing', fraction: null });
    expect(state.items.node).toEqual({ status: 'queued' });
  });

  it('records progress on the item being installed', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      {
        type: 'progress',
        jobId: 'a',
        itemId: 'git',
        phase: 'downloading',
        fraction: 0.25,
        detail: '1 of 4 MB',
      },
    ]);

    expect(state.items.git).toEqual({
      status: 'installing',
      phase: 'downloading',
      fraction: 0.25,
      detail: '1 of 4 MB',
    });
  });

  it('keeps what it knew when a progress event carries only some of it', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      {
        type: 'progress',
        jobId: 'a',
        itemId: 'git',
        phase: 'downloading',
        fraction: 0.5,
        detail: '2 of 4 MB',
      },
      { type: 'progress', jobId: 'a', itemId: 'git', fraction: 0.75 },
    ]);

    expect(state.items.git).toMatchObject({
      phase: 'downloading',
      fraction: 0.75,
      detail: '2 of 4 MB',
    });
  });

  it('never lets progress run backwards within a phase', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'progress', jobId: 'a', itemId: 'git', phase: 'downloading', fraction: 0.8 },
      { type: 'progress', jobId: 'a', itemId: 'git', phase: 'downloading', fraction: 0.3 },
    ]);

    expect(state.items.git).toMatchObject({ fraction: 0.8 });
  });

  it('lets progress start over when the phase changes', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'progress', jobId: 'a', itemId: 'git', phase: 'downloading', fraction: 1 },
      { type: 'progress', jobId: 'a', itemId: 'git', phase: 'installing', fraction: null },
    ]);

    expect(state.items.git).toMatchObject({ phase: 'installing', fraction: null });
  });

  it('ignores progress for an item that is not being installed', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'progress', jobId: 'a', itemId: 'git', phase: 'downloading', fraction: 0.5 },
    ]);

    expect(state.items.git).toEqual({ status: 'queued' });
  });

  it('drops an item that installed, and counts it as done', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git', 'node'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'finished', jobId: 'a', itemId: 'git', result: 'installed' },
    ]);

    expect(state.items.git).toBeUndefined();
    expect(state.completed).toEqual(['git']);
    expect(state.current).toBeNull();
    expect(state.running).toBe(true);
  });

  it('keeps a failure on the item, with the reason, so the row can show it', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      {
        type: 'finished',
        jobId: 'a',
        itemId: 'git',
        result: 'failed',
        message: 'It stopped.',
        exitCode: 1603,
      },
    ]);

    expect(state.items.git).toEqual({ status: 'failed', message: 'It stopped.', exitCode: 1603 });
  });

  it('removes an item that was cancelled', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'finished', jobId: 'a', itemId: 'git', result: 'cancelled' },
    ]);

    expect(state.items.git).toBeUndefined();
    expect(state.completed).toEqual([]);
  });

  it('ends the run, clearing anything still waiting but keeping failures', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git', 'node', 'gh'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'finished', jobId: 'a', itemId: 'git', result: 'failed', message: 'No.' },
      { type: 'done', jobId: 'a', cancelled: false },
    ]);

    expect(state.running).toBe(false);
    expect(state.current).toBeNull();
    expect(state.items).toEqual({ git: { status: 'failed', message: 'No.', exitCode: null } });
  });

  it('ignores events from a run that is over, which can arrive late', () => {
    const finished = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'done', jobId: 'a', cancelled: false },
    ]);

    const after = applyJobEvent(finished, { type: 'started', jobId: 'a-old', itemId: 'git' });

    expect(after).toBe(finished);
  });

  it('ignores events from another run than the current one', () => {
    const state = run([{ type: 'plan', jobId: 'b', steps: ['git'] }]);

    expect(applyJobEvent(state, { type: 'started', jobId: 'a', itemId: 'git' })).toBe(state);
  });

  it('adds new steps to a run that is already going, leaving the others as they are', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'plan', jobId: 'a', steps: ['git', 'node'] },
    ]);

    expect(state.items.git).toMatchObject({ status: 'installing' });
    expect(state.items.node).toEqual({ status: 'queued' });
    expect(state.order).toEqual(['git', 'node']);
  });

  it('shows a failed step as queued again the moment it is added to the run that is going', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git', 'node'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'finished', jobId: 'a', itemId: 'git', result: 'failed', message: 'No.' },
      { type: 'started', jobId: 'a', itemId: 'node' },
      { type: 'log', jobId: 'a', itemId: 'git', line: 'old attempt' },
      { type: 'plan', jobId: 'a', steps: ['git'] },
    ]);

    expect(state.items.git).toEqual({ status: 'queued' });
    expect(state.items.node).toMatchObject({ status: 'installing' });
    expect(state.order).toEqual(['git', 'node']);
    expect(state.logs.git).toBeUndefined();
  });

  it('leaves a step that is already queued or installing alone when it is planned again', () => {
    const before = run([
      { type: 'plan', jobId: 'a', steps: ['git', 'node'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'log', jobId: 'a', itemId: 'git', line: 'Found Git' },
    ]);

    const after = applyJobEvent(before, { type: 'plan', jobId: 'a', steps: ['git', 'node'] });

    expect(after.items).toEqual(before.items);
    expect(after.logs).toEqual(before.logs);
    expect(after.order).toEqual(['git', 'node']);
  });

  it('starts a clean run after the last one, but keeps a failure that was not retried', () => {
    const first = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'finished', jobId: 'a', itemId: 'git', result: 'failed', message: 'No.' },
      { type: 'done', jobId: 'a', cancelled: false },
    ]);

    const second = applyJobEvent(first, { type: 'plan', jobId: 'b', steps: ['node'] });

    expect(second.jobId).toBe('b');
    expect(second.items.git).toMatchObject({ status: 'failed' });
    expect(second.items.node).toEqual({ status: 'queued' });
    expect(second.completed).toEqual([]);
  });

  it('replaces an old failure when the same item is planned again', () => {
    const first = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'finished', jobId: 'a', itemId: 'git', result: 'failed', message: 'No.' },
      { type: 'done', jobId: 'a', cancelled: false },
    ]);

    const second = applyJobEvent(first, { type: 'plan', jobId: 'b', steps: ['git'] });

    expect(second.items.git).toEqual({ status: 'queued' });
  });

  it('collects the log lines for each item', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'log', jobId: 'a', itemId: 'git', line: 'Found Git' },
      { type: 'log', jobId: 'a', itemId: 'git', line: 'Downloading' },
    ]);

    expect(state.logs.git).toEqual(['Found Git', 'Downloading']);
  });

  it('keeps only the most recent lines of a long log', () => {
    const lines: DevJobEvent[] = Array.from({ length: MAX_LOG_LINES + 25 }, (_, index) => ({
      type: 'log',
      jobId: 'a',
      itemId: 'git',
      line: `line ${index}`,
    }));
    const state = run([{ type: 'plan', jobId: 'a', steps: ['git'] }, ...lines]);

    expect(state.logs.git).toHaveLength(MAX_LOG_LINES);
    expect(state.logs.git?.at(-1)).toBe(`line ${MAX_LOG_LINES + 24}`);
    expect(state.logs.git?.[0]).toBe('line 25');
  });

  it('starts a fresh log for an item that is run again', () => {
    const first = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'log', jobId: 'a', itemId: 'git', line: 'old' },
      { type: 'done', jobId: 'a', cancelled: false },
    ]);

    const second = applyJobEvent(first, { type: 'plan', jobId: 'b', steps: ['git'] });

    expect(second.logs.git).toBeUndefined();
  });

  it('remembers that a restart was advised', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['docker-desktop'] },
      {
        type: 'finished',
        jobId: 'a',
        itemId: 'docker-desktop',
        result: 'installed',
        restartAdvised: true,
      },
    ]);

    expect(state.restartAdvised).toBe(true);
  });
});

describe('overallFraction', () => {
  it('counts finished items and the part done of the current one', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git', 'node', 'gh', 'pnpm'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
      { type: 'finished', jobId: 'a', itemId: 'git', result: 'installed' },
      { type: 'started', jobId: 'a', itemId: 'node' },
      { type: 'progress', jobId: 'a', itemId: 'node', phase: 'downloading', fraction: 0.5 },
    ]);

    expect(overallFraction(state)).toBeCloseTo((1 + 0.5) / 4);
  });

  it('is zero before anything has happened, and one when everything is done', () => {
    expect(overallFraction(EMPTY_JOB_STATE)).toBe(0);
    const queued = run([{ type: 'plan', jobId: 'a', steps: ['git'] }]);
    expect(overallFraction(queued)).toBe(0);
    const done = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'finished', jobId: 'a', itemId: 'git', result: 'installed' },
    ]);
    expect(overallFraction(done)).toBe(1);
  });

  it('counts the current item as nothing yet when it reports no percentage', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git', 'node'] },
      { type: 'started', jobId: 'a', itemId: 'git' },
    ]);

    expect(overallFraction(state)).toBe(0);
  });
});

describe('cleanInstallerLine', () => {
  it('trims a line and drops colour codes', () => {
    expect(cleanInstallerLine('  \u001B[32mFound Git\u001B[0m  ')).toBe('Found Git');
  });

  it.each([
    [''],
    ['   '],
    ['   -   '],
    ['\\'],
    ['  |  '],
    ['/'],
    ['  ███▒▒▒  45%'],
    ['██████████'],
  ])('drops the spinner or progress-bar line %j, since it is noise in a log', (line) => {
    expect(cleanInstallerLine(line)).toBeNull();
  });

  it('keeps an ordinary line that happens to contain a dash', () => {
    expect(cleanInstallerLine('Installing - this may take a minute')).toBe(
      'Installing - this may take a minute',
    );
  });
});

describe('parseInstallerProgress', () => {
  it('reads a percentage', () => {
    expect(parseInstallerProgress('  ████▒▒▒▒  45%')).toEqual({
      fraction: 0.45,
      detail: '45%',
    });
  });

  it('reads the sizes winget prints beside its bar', () => {
    expect(parseInstallerProgress('  ███▒▒▒  1.20 MB / 3.60 MB')).toEqual({
      fraction: 1.2 / 3.6,
      detail: '1.20 MB of 3.60 MB',
    });
  });

  it('mixes units correctly', () => {
    const result = parseInstallerProgress('512 KB / 2 MB');
    expect(result?.fraction).toBeCloseTo(0.25);
    expect(result?.detail).toBe('512 KB of 2 MB');
  });

  it('caps the fraction at one', () => {
    expect(parseInstallerProgress('120%')?.fraction).toBe(1);
  });

  it('has nothing to say about an ordinary line', () => {
    expect(parseInstallerProgress('Successfully installed')).toBeNull();
    expect(parseInstallerProgress('')).toBeNull();
  });
});

describe('explainWingetExit', () => {
  it('treats the "already installed" codes as fine, since the check afterwards decides', () => {
    expect(explainWingetExit(0x8a150061 | 0)).toMatchObject({ kind: 'already' });
    expect(explainWingetExit(0x8a15010d | 0)).toMatchObject({ kind: 'already' });
    expect(explainWingetExit(0x8a15002b | 0)).toMatchObject({ kind: 'already' });
  });

  it('accepts the code the way Windows reports it, as an unsigned number', () => {
    expect(explainWingetExit(0x8a150061)).toMatchObject({ kind: 'already' });
    expect(explainWingetExit(0x8a150102)).toMatchObject({ kind: 'failure' });
  });

  it('says a restart is needed to finish', () => {
    expect(explainWingetExit(0x8a150109 | 0)).toEqual({
      kind: 'restart',
      message: 'Installed. Restart your computer to finish.',
    });
    expect(explainWingetExit(3010)).toMatchObject({ kind: 'restart' });
  });

  it('gives a plain reason for the failures a person can do something about', () => {
    expect(explainWingetExit(0x8a150102 | 0)).toEqual({
      kind: 'failure',
      message: 'Another installer is running. Wait for it to finish, then try again.',
    });
    expect(explainWingetExit(1618)?.message).toBe(
      'Another installer is running. Wait for it to finish, then try again.',
    );
    expect(explainWingetExit(0x8a150101 | 0)?.message).toBe(
      'Close the app that is using it, then try again.',
    );
    expect(explainWingetExit(0x8a150008 | 0)?.message).toBe(
      'The download failed. Check your internet connection and try again.',
    );
    expect(explainWingetExit(0x8a150011 | 0)?.message).toBe(
      'The download did not match its checksum, so it was not installed.',
    );
    expect(explainWingetExit(0x8a15010c | 0)?.message).toBe('The install was cancelled.');
    expect(explainWingetExit(1602)?.message).toBe('The install was cancelled.');
    expect(explainWingetExit(0x8a150014 | 0)?.message).toBe('winget could not find this package.');
    expect(explainWingetExit(0x8a150010 | 0)?.message).toBe(
      'There is no installer for this computer.',
    );
  });

  it('names the code when it has nothing better to say', () => {
    expect(explainWingetExit(1603)).toEqual({
      kind: 'failure',
      message: 'winget could not finish (code 1603).',
    });
    expect(explainWingetExit(0x8a150999 | 0)).toEqual({
      kind: 'failure',
      message: 'winget could not finish (code 0x8A150999).',
    });
  });

  it('has nothing to say about success or a missing code', () => {
    expect(explainWingetExit(0)).toBeNull();
    expect(explainWingetExit(null)).toBeNull();
  });
});

describe('phaseFromInstallerLine', () => {
  it.each([
    ['Found Git [Git.Git] Version 2.55.0', 'preparing'],
    ['This application is licensed to you by its owner.', 'preparing'],
    [
      'Downloading https://github.com/git-for-windows/git/releases/download/v2.55.0/Git.exe',
      'downloading',
    ],
    ['Successfully verified installer hash', 'verifying'],
    ['Starting package install...', 'installing'],
    ['==> Fetching downloads for: gh', 'downloading'],
    ['==> Downloading https://ghcr.io/v2/homebrew/core/gh/manifests/2.62.0', 'downloading'],
    ['==> Pouring gh--2.62.0.arm64_sonoma.bottle.tar.gz', 'installing'],
    ['==> Installing gh', 'installing'],
    ['npm http fetch GET 200 https://registry.npmjs.org/pnpm', 'downloading'],
    ['added 1 package in 2s', 'installing'],
  ] as const)('reads "%s" as the %s phase', (line, phase) => {
    expect(phaseFromInstallerLine(line)).toBe(phase);
  });

  it('has nothing to say about a line that gives no hint', () => {
    expect(phaseFromInstallerLine('Some other output')).toBeNull();
    expect(phaseFromInstallerLine('')).toBeNull();
  });
});

describe('applyJobEvent: how a run ended', () => {
  it('remembers that a run was cancelled', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'done', jobId: 'a', cancelled: true },
    ]);

    expect(state.cancelled).toBe(true);
  });

  it('does not call a run that finished cancelled', () => {
    const state = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'done', jobId: 'a', cancelled: false },
    ]);

    expect(state.cancelled).toBeFalsy();
  });

  it('forgets it when the next run starts', () => {
    const first = run([
      { type: 'plan', jobId: 'a', steps: ['git'] },
      { type: 'done', jobId: 'a', cancelled: true },
    ]);

    const second = applyJobEvent(first, { type: 'plan', jobId: 'b', steps: ['node'] });

    expect(second.cancelled).toBeFalsy();
  });
});

describe('applyJobEvent: an update run', () => {
  const update: DevJobEvent = { type: 'plan', jobId: 'u', steps: ['node', 'gh'], intent: 'update' };

  it('remembers that the run, and each queued step, is an update', () => {
    const state = run([update]);

    expect(state.intent).toBe('update');
    expect(state.items).toEqual({
      node: { status: 'queued', intent: 'update' },
      gh: { status: 'queued', intent: 'update' },
    });
  });

  it('keeps the intent on the step through starting, progress and failing', () => {
    const started = run([update, { type: 'started', jobId: 'u', itemId: 'node' }]);
    expect(started.items.node).toMatchObject({ status: 'installing', intent: 'update' });

    const progressed = applyJobEvent(started, {
      type: 'progress',
      jobId: 'u',
      itemId: 'node',
      phase: 'downloading',
      fraction: 0.5,
    });
    expect(progressed.items.node).toMatchObject({ status: 'installing', intent: 'update' });

    const failed = applyJobEvent(progressed, {
      type: 'finished',
      jobId: 'u',
      itemId: 'node',
      result: 'failed',
      message: 'nope',
    });
    expect(failed.items.node).toMatchObject({ status: 'failed', intent: 'update' });
  });

  it('leaves an install run without any intent', () => {
    const state = run([{ type: 'plan', jobId: 'i', steps: ['git'] }]);

    expect(state).not.toHaveProperty('intent');
    expect(state.items.git).toEqual({ status: 'queued' });
  });

  it('gives a step added to a run that is going the intent of the request that added it', () => {
    const state = run([
      { type: 'plan', jobId: 'i', steps: ['git'] },
      { type: 'plan', jobId: 'i', steps: ['node'], intent: 'update' },
    ]);

    expect(state.items.git).toEqual({ status: 'queued' });
    expect(state.items.node).toEqual({ status: 'queued', intent: 'update' });
  });
});
