import { describe, expect, it } from 'vitest';
import {
  changeCountText,
  changesSummaryText,
  conflictStory,
  deployButtonText,
  durationText,
  LEFT_OUT_REASON,
  lastDeployText,
  NOTICE_TEXT,
  PHASE_LABEL,
  plural,
  relativeTimeText,
  runCountsText,
  TRIGGER_LABEL,
  timeLeftMs,
  transferRate,
} from './copy';
import { planChange, progressEvent, runResult } from './testing/fixtures';

/** The sentences the FTP and SFTP screens build from numbers, and the speed of a running deploy. */

const NOW = Date.parse('2026-10-18T10:00:00Z');

describe('counts', () => {
  it('says one and many', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(3, 'file')).toBe('3 files');
    expect(plural(0, 'change')).toBe('0 changes');
    expect(changeCountText(1)).toBe('1 change');
  });

  it('sums up the pending changes, with their size when there is one', () => {
    expect(changesSummaryText(12, 3.4 * 1024 * 1024)).toBe(
      '12 changes, 3.40 MB since the last deploy',
    );
    expect(changesSummaryText(2, 0)).toBe('2 changes since the last deploy');
    expect(deployButtonText(12, 3.4 * 1024 * 1024)).toBe('Deploy 12 changes (3.40 MB)');
    expect(deployButtonText(1, 0)).toBe('Deploy 1 change');
  });

  it("lists a run's counts, leaving out the zeros", () => {
    expect(runCountsText(runResult({ uploaded: 3, deleted: 1, skipped: 0 }))).toBe(
      '3 uploaded, 1 deleted',
    );
    expect(
      runCountsText(
        runResult({
          uploaded: 0,
          deleted: 0,
          adopted: 2,
          skipped: 4,
          failed: [{ path: 'a', code: 'server', message: 'x' }],
        }),
      ),
    ).toBe('2 already there, 4 skipped, 1 failed');
    expect(runCountsText(runResult({ uploaded: 0, deleted: 0 }))).toBe('Nothing to send');
  });
});

describe('times', () => {
  it('says how long something took', () => {
    expect(durationText(400)).toBe('under a second');
    expect(durationText(12_300)).toBe('12 s');
    expect(durationText(125_000)).toBe('2 min 5 s');
    expect(durationText(120_000)).toBe('2 min');
    expect(durationText(3_780_000)).toBe('1 h 3 min');
    expect(durationText(7_200_000)).toBe('2 h');
  });

  it('says how long ago something was', () => {
    expect(relativeTimeText(NOW - 20_000, NOW)).toBe('just now');
    expect(relativeTimeText(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(relativeTimeText(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(relativeTimeText(NOW - 2 * 86_400_000, NOW)).toBe('2 days ago');
    expect(relativeTimeText(NOW - 86_400_000, NOW)).toBe('yesterday');
    expect(relativeTimeText(NOW + 60_000, NOW)).toBe('just now');
  });

  it('says when the site was last deployed and how it went', () => {
    expect(lastDeployText(null, NOW)).toBe('Never deployed');
    expect(
      lastDeployText(
        {
          at: NOW - 5 * 60_000,
          state: 'done',
          trigger: 'user',
          uploaded: 3,
          deleted: 0,
          failed: 0,
        },
        NOW,
      ),
    ).toBe('Deployed 5 min ago');
    expect(
      lastDeployText(
        {
          at: NOW - 5 * 60_000,
          state: 'failed',
          trigger: 'deployOnSave',
          uploaded: 0,
          deleted: 0,
          failed: 2,
        },
        NOW,
      ),
    ).toBe('Last deploy failed 5 min ago (Deploy on save)');
  });
});

describe('labels', () => {
  it('names each phase, trigger, notice and left-out reason', () => {
    expect(PHASE_LABEL.uploading).toBe('Uploading');
    expect(TRIGGER_LABEL).toEqual({ user: 'You', deployOnSave: 'Deploy on save' });
    expect(NOTICE_TEXT.clockShift(2)).toMatch(/2 hours/);
    expect(NOTICE_TEXT.clockShift(1)).toMatch(/1 hour\b/);
    expect(NOTICE_TEXT.clockShift(null)).toMatch(/whole number of hours/);
    for (const reason of Object.values(LEFT_OUT_REASON)) {
      expect(reason.label.length).toBeGreaterThan(0);
      expect(reason.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('conflictStory', () => {
  it('says what happened on the server, in words', () => {
    expect(conflictStory(planChange('a', { conflict: 'changedOnServer' }))).toBe(
      'Changed on the server since your last deploy.',
    );
    expect(conflictStory(planChange('a', { local: 'deleted', conflict: 'changedOnServer' }))).toBe(
      'Deleted here, but changed on the server since your last deploy.',
    );
    expect(conflictStory(planChange('a', { local: 'added', conflict: 'existsOnServer' }))).toBe(
      'Already on the server, and not from a deploy of yours.',
    );
    expect(conflictStory(planChange('a', { conflict: 'deletedOnServer' }))).toBe(
      'Changed here, but deleted on the server.',
    );
    expect(conflictStory(planChange('a', { conflict: null }))).toBe('');
  });
});

describe('transferRate and timeLeftMs', () => {
  it('needs a second of readings before it says a speed', () => {
    expect(transferRate([])).toBeNull();
    expect(transferRate([{ at: 0, bytes: 0 }])).toBeNull();
    expect(
      transferRate([
        { at: 0, bytes: 0 },
        { at: 500, bytes: 100 },
      ]),
    ).toBeNull();
  });

  it('reads bytes a second from the first and last readings', () => {
    expect(
      transferRate([
        { at: 0, bytes: 0 },
        { at: 1000, bytes: 1000 },
        { at: 4000, bytes: 8000 },
      ]),
    ).toBe(2000);
    expect(
      transferRate([
        { at: 0, bytes: 5000 },
        { at: 2000, bytes: 5000 },
      ]),
    ).toBe(0);
  });

  it('works out the time left from the bytes still to go', () => {
    expect(timeLeftMs(progressEvent({ bytesDone: 2000, bytesTotal: 10_000 }), 2000)).toBe(4000);
    expect(timeLeftMs(progressEvent(), null)).toBeNull();
    expect(timeLeftMs(progressEvent(), 0)).toBeNull();
    expect(timeLeftMs(progressEvent({ bytesDone: 10, bytesTotal: 5 }), 100)).toBe(0);
  });
});
