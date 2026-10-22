import { describe, expect, it } from 'vitest';
import {
  backupSize,
  cronOf,
  keepSentence,
  scheduleOf,
  scheduleProblem,
  telegramPartNote,
} from './backupSchedule';

/**
 * A plan's schedule as the editor shows it (every N hours, daily, weekly, or a cron line of its
 * own) and the cron the core runs, both ways, plus the sentence the live preview reads as.
 */

describe('cronOf', () => {
  it('writes each preset as a five-field cron line', () => {
    expect(cronOf({ kind: 'hours', every: 6 })).toBe('0 */6 * * *');
    expect(cronOf({ kind: 'hours', every: 1 })).toBe('0 * * * *');
    expect(cronOf({ kind: 'daily', time: '03:30' })).toBe('30 3 * * *');
    expect(cronOf({ kind: 'weekly', day: 0, time: '23:05' })).toBe('5 23 * * 0');
    expect(cronOf({ kind: 'cron', cron: '  15 2 1 * *  ' })).toBe('15 2 1 * *');
  });
});

describe('scheduleOf', () => {
  it('reads a preset back from its cron line', () => {
    expect(scheduleOf('0 */6 * * *')).toEqual({ kind: 'hours', every: 6 });
    expect(scheduleOf('0 * * * *')).toEqual({ kind: 'hours', every: 1 });
    expect(scheduleOf('30 3 * * *')).toEqual({ kind: 'daily', time: '03:30' });
    expect(scheduleOf('5 23 * * 0')).toEqual({ kind: 'weekly', day: 0, time: '23:05' });
  });

  it('keeps anything else as a cron line', () => {
    expect(scheduleOf('15 2 1 * *')).toEqual({ kind: 'cron', cron: '15 2 1 * *' });
    expect(scheduleOf('0 3 * * 1-5')).toEqual({ kind: 'cron', cron: '0 3 * * 1-5' });
  });
});

describe('scheduleProblem', () => {
  it('turns down what the presets cannot mean', () => {
    expect(scheduleProblem({ kind: 'hours', every: 0 })).toMatch(/1 to 23/);
    expect(scheduleProblem({ kind: 'hours', every: 24 })).toMatch(/1 to 23/);
    expect(scheduleProblem({ kind: 'daily', time: '25:00' })).toMatch(/HH:MM/);
    expect(scheduleProblem({ kind: 'cron', cron: '* * *' })).toMatch(/five fields/);
    expect(scheduleProblem({ kind: 'daily', time: '04:00' })).toBeNull();
    expect(scheduleProblem({ kind: 'cron', cron: '0 4 * * *' })).toBeNull();
  });
});

describe('backupSize', () => {
  it('reads like a person would say it', () => {
    expect(backupSize(14 * 1024 ** 3)).toBe('14 GB');
    expect(backupSize(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(backupSize(300 * 1024 ** 2)).toBe('300 MB');
    expect(backupSize(2048)).toBe('2 KB');
  });
});

describe('keepSentence', () => {
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it('says how many stay, about how much room, and when the oldest goes', () => {
    expect(
      keepSentence(
        {
          nextRunsUnixMs: [],
          kept: 7,
          bytesPerDestination: 14 * 1024 ** 3,
          firstDeletionAtUnixMs: Date.UTC(2026, 10, 3),
          coversMs: 0,
        },
        date,
      ),
    ).toBe('Keeps 7 backups on each destination, about 14 GB each, the oldest goes on 2026-11-03.');
  });

  it('leaves out what the core cannot know yet', () => {
    expect(keepSentence({ nextRunsUnixMs: [], kept: 1, coversMs: 0 }, date)).toBe(
      'Keeps 1 backup on each destination.',
    );
  });
});

describe('telegramPartNote', () => {
  it('names the part size for the account', () => {
    expect(telegramPartNote(false)).toMatch(/2000 MB/);
    expect(telegramPartNote(true)).toMatch(/4000 MB/);
  });
});
