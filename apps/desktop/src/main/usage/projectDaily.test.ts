import { estimateCost, MODEL_PRICES } from '@runova/core';
import { describe, expect, it } from 'vitest';
import {
  buildProjectDaily,
  createProjectResolver,
  foldWorktree,
  type KnownProjects,
  lastDayKeys,
  MAX_SPLIT_PROJECTS,
  normalizeFolder,
  type PathRules,
  SPLIT_DAYS,
} from './projectDaily';
import { makeTokens, type UsageEntry } from './shared';

/**
 * The per-project split behind "Projects by weekday". Every date here is built with local-time
 * constructors, so the day a token belongs to is the day of the calendar the user reads.
 */

const WINDOWS: PathRules = { caseInsensitive: true, windows: true };
const PRICED = Object.keys(MODEL_PRICES)[0];
const UNPRICED = 'a-model-nobody-has-priced';

/** Tuesday 13 October 2026, mid-afternoon. Offsets count whole days from it. */
const NOW = new Date(2026, 9, 13, 15, 30);
const now = NOW.getTime();
const at = (dayOffset: number, hour: number, minute = 0): Date =>
  new Date(2026, 9, 13 + dayOffset, hour, minute);

function entry(
  when: Date,
  folder: string | null,
  { model = PRICED, input = 1000, output = 0 } = {},
): UsageEntry {
  return { at: when, model, tokens: makeTokens(input, output, 0, 0), folder };
}

const known: KnownProjects = {
  projects: [
    { id: 'p1', name: 'Runova', folderPath: 'E:\\Runova' },
    { id: 'p2', name: 'Outer', folderPath: 'E:\\Work' },
    { id: 'p3', name: 'Inner', folderPath: 'E:\\Work\\inner' },
  ],
  worktrees: [{ projectId: 'p1', path: 'C:\\worktrees\\Runova-feature' }],
};

describe('normalizeFolder', () => {
  it('uses forward slashes, one separator at a time, and no trailing slash', () => {
    expect(normalizeFolder('E:\\Runova\\\\src//x/', WINDOWS)).toBe('E:/Runova/src/x');
  });

  it('strips the \\\\?\\ prefixes and keeps UNC shares', () => {
    expect(normalizeFolder('\\\\?\\C:\\Work\\app', WINDOWS)).toBe('C:/Work/app');
    expect(normalizeFolder('\\\\?\\UNC\\srv\\share\\dir', WINDOWS)).toBe('//srv/share/dir');
  });

  it('reads a Git Bash path as a drive path on Windows only', () => {
    expect(normalizeFolder('/e/Runova', WINDOWS)).toBe('E:/Runova');
    expect(normalizeFolder('/e/Runova', { caseInsensitive: false, windows: false })).toBe(
      '/e/Runova',
    );
  });

  it('keeps a drive root and a POSIX root as they are', () => {
    expect(normalizeFolder('E:\\', WINDOWS)).toBe('E:/');
    expect(normalizeFolder('/', WINDOWS)).toBe('/');
    expect(normalizeFolder('/home/me/app/', WINDOWS)).toBe('/home/me/app');
  });
});

describe('foldWorktree', () => {
  it('maps a Claude Code worktree back to its repository', () => {
    expect(foldWorktree('E:/Galaxy/.claude/worktrees/agent-1')).toBe('E:/Galaxy');
  });

  it('matches the marker whatever its case', () => {
    expect(foldWorktree('E:/Galaxy/.CLAUDE/Worktrees/x')).toBe('E:/Galaxy');
  });

  it('leaves a folder alone when there is no marker, or it is the marker itself', () => {
    expect(foldWorktree('E:/Galaxy/src')).toBe('E:/Galaxy/src');
    expect(foldWorktree('/.claude/worktrees/x')).toBe('/.claude/worktrees/x');
  });
});

describe('createProjectResolver', () => {
  it('puts a folder inside a registered project on that project', () => {
    const resolve = createProjectResolver(known, WINDOWS);
    expect(resolve('E:\\Runova\\apps\\desktop')).toMatchObject({
      key: 'project:p1',
      name: 'Runova',
      path: 'E:/Runova',
    });
  });

  it('puts a Runova worktree outside the project folder on its project', () => {
    const resolve = createProjectResolver(known, WINDOWS);
    expect(resolve('C:\\worktrees\\Runova-feature\\src')).toMatchObject({ key: 'project:p1' });
  });

  it('puts a Claude Code worktree on the repository it belongs to', () => {
    const resolve = createProjectResolver(known, WINDOWS);
    expect(resolve('E:\\Runova\\.claude\\worktrees\\agent-9')).toMatchObject({
      key: 'project:p1',
    });
  });

  it('picks the innermost project when projects are nested', () => {
    const resolve = createProjectResolver(known, WINDOWS);
    expect(resolve('E:\\Work\\inner\\src')).toMatchObject({ key: 'project:p3', name: 'Inner' });
    expect(resolve('E:\\Work\\other')).toMatchObject({ key: 'project:p2', name: 'Outer' });
  });

  it('does not treat a sibling that shares a prefix as inside the project', () => {
    const resolve = createProjectResolver(known, WINDOWS);
    expect(resolve('E:\\Runova2\\src')).toMatchObject({
      key: 'folder:e:/runova2/src',
      name: 'src',
    });
  });

  it('names an unregistered folder after its last segment and keeps its path', () => {
    const resolve = createProjectResolver(known, WINDOWS);
    expect(resolve('D:\\Scratch\\Demo App')).toEqual({
      key: 'folder:d:/scratch/demo app',
      name: 'Demo App',
      path: 'D:/Scratch/Demo App',
    });
  });

  it('matches case-insensitively only when the rules say so', () => {
    expect(createProjectResolver(known, WINDOWS)('e:\\runova\\x')).toMatchObject({
      key: 'project:p1',
    });
    const strict = createProjectResolver(known, { caseInsensitive: false, windows: true });
    expect(strict('e:\\runova\\x')).toMatchObject({ key: 'folder:e:/runova/x' });
  });

  it('gives a missing folder the unknown row', () => {
    const resolve = createProjectResolver(known, WINDOWS);
    for (const folder of [null, undefined, '', '   ']) {
      expect(resolve(folder)).toEqual({ key: 'unknown', name: 'Unknown folder', path: null });
    }
  });

  it('skips a worktree whose project is not registered', () => {
    const resolve = createProjectResolver(
      { projects: [], worktrees: [{ projectId: 'gone', path: 'C:\\wt' }] },
      WINDOWS,
    );
    expect(resolve('C:\\wt\\x')).toMatchObject({ key: 'folder:c:/wt/x' });
  });
});

describe('lastDayKeys', () => {
  it('ends on the day that holds now and runs oldest first', () => {
    const keys = lastDayKeys(now, SPLIT_DAYS);
    expect(keys).toHaveLength(SPLIT_DAYS);
    expect(keys[SPLIT_DAYS - 1]).toBe('2026-10-13');
    expect(keys[0]).toBe('2026-09-16');
  });

  it('crosses a month and a year boundary', () => {
    const keys = lastDayKeys(new Date(2026, 0, 2, 9).getTime(), 28);
    expect(keys[0]).toBe('2025-12-06');
    expect(keys[keys.length - 1]).toBe('2026-01-02');
  });

  it('gives consecutive calendar days in any time zone, daylight saving included', () => {
    const keys = lastDayKeys(new Date(2026, 2, 20, 12).getTime(), 40);
    for (let i = 1; i < keys.length; i += 1) {
      const gap = Date.UTC(...splitKey(keys[i])) - Date.UTC(...splitKey(keys[i - 1]));
      expect(gap).toBe(86_400_000);
    }
  });
});

function splitKey(key: string): [number, number, number] {
  const [year, month, day] = key.split('-').map(Number);
  return [year, month - 1, day];
}

describe('buildProjectDaily', () => {
  it('puts each entry on the local day it happened, at the edges of the day too', () => {
    const split = buildProjectDaily([entry(at(0, 0, 0), 'E:\\A'), entry(at(-1, 23, 59), 'E:\\A')], {
      now,
      rules: WINDOWS,
    });
    expect(split.endDay).toBe('2026-10-13');
    const [row] = split.projects;
    expect(row.tokens).toHaveLength(SPLIT_DAYS);
    expect(row.tokens[SPLIT_DAYS - 1]).toBe(1000);
    expect(row.tokens[SPLIT_DAYS - 2]).toBe(1000);
    expect(row.tokens.reduce((sum, value) => sum + value, 0)).toBe(2000);
  });

  it('leaves out days before the window and days after today', () => {
    const split = buildProjectDaily(
      [entry(at(-28, 12), 'E:\\A'), entry(at(-27, 12), 'E:\\A'), entry(at(1, 0, 0), 'E:\\A')],
      { now, rules: WINDOWS },
    );
    const [row] = split.projects;
    expect(row.tokens[0]).toBe(1000); // 27 days ago is the first day of the window
    expect(row.tokens.reduce((sum, value) => sum + value, 0)).toBe(1000);
  });

  it('prices each model once and adds up to what the catalog says', () => {
    const split = buildProjectDaily(
      [entry(at(0, 9), 'E:\\A', { input: 1000 }), entry(at(0, 10), 'E:\\A', { input: 3000 })],
      { now, rules: WINDOWS },
    );
    const [row] = split.projects;
    const expected = estimateCost(PRICED, makeTokens(4000, 0, 0, 0)) ?? 0;
    expect(row.costUsd[SPLIT_DAYS - 1]).toBeCloseTo(expected, 10);
    expect(row.unpricedTokens[SPLIT_DAYS - 1]).toBe(0);
  });

  it('keeps tokens of an unpriced model out of the cost and counts them apart', () => {
    const split = buildProjectDaily([entry(at(0, 9), 'E:\\A', { model: UNPRICED, input: 700 })], {
      now,
      rules: WINDOWS,
    });
    const [row] = split.projects;
    expect(row.tokens[SPLIT_DAYS - 1]).toBe(700);
    expect(row.costUsd[SPLIT_DAYS - 1]).toBe(0);
    expect(row.unpricedTokens[SPLIT_DAYS - 1]).toBe(700);
  });

  it('skips placeholders, negative and non-numeric counts', () => {
    const bad: UsageEntry = {
      at: at(0, 9),
      model: PRICED,
      tokens: { input: -5, output: Number.NaN, cacheRead: 0, cacheWrite: 0, total: 0 },
      folder: 'E:\\A',
    };
    const split = buildProjectDaily([bad, entry(at(0, 9), 'E:\\A', { input: 0 })], {
      now,
      rules: WINDOWS,
    });
    expect(split.projects).toEqual([]);
  });

  it('rolls a worktree and its project into one row', () => {
    const split = buildProjectDaily(
      [entry(at(0, 9), 'E:\\Runova\\apps'), entry(at(0, 10), 'C:\\worktrees\\Runova-feature')],
      { now, known, rules: WINDOWS },
    );
    expect(split.projects).toHaveLength(1);
    expect(split.projects[0]).toMatchObject({ key: 'project:p1', name: 'Runova' });
    expect(split.projects[0].tokens[SPLIT_DAYS - 1]).toBe(2000);
  });

  it('gives sessions with no folder their own unknown row', () => {
    const split = buildProjectDaily([entry(at(0, 9), null)], { now, rules: WINDOWS });
    expect(split.projects[0]).toMatchObject({ key: 'unknown', name: 'Unknown folder', path: null });
  });

  it('sorts the busiest project first, with ties broken by key', () => {
    const split = buildProjectDaily(
      [
        entry(at(0, 9), 'D:\\small', { input: 10 }),
        entry(at(0, 9), 'D:\\zeta', { input: 500 }),
        entry(at(0, 9), 'D:\\alpha', { input: 500 }),
      ],
      { now, rules: WINDOWS },
    );
    expect(split.projects.map((row) => row.name)).toEqual(['alpha', 'zeta', 'small']);
  });

  it('folds the smallest folders into one tail row past the cap, keeping the totals', () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry(at(0, 9), `D:\\folder-${i}`, { input: (i + 1) * 100 }),
    );
    const total = entries.reduce((sum, item) => sum + item.tokens.total, 0);
    const split = buildProjectDaily(entries, { now, rules: WINDOWS, maxProjects: 5 });
    expect(split.projects).toHaveLength(5);
    const tail = split.projects[4];
    expect(tail).toMatchObject({ key: 'tail', name: 'Other folders', path: null });
    const sum = split.projects.reduce(
      (acc, row) => acc + row.tokens.reduce((n, value) => n + value, 0),
      0,
    );
    expect(sum).toBe(total);
  });

  it('keeps sixty rows by default', () => {
    const entries = Array.from({ length: MAX_SPLIT_PROJECTS + 5 }, (_, i) =>
      entry(at(0, 9), `D:\\f${i}`, { input: i + 1 }),
    );
    expect(buildProjectDaily(entries, { now, rules: WINDOWS }).projects).toHaveLength(
      MAX_SPLIT_PROJECTS,
    );
  });

  it('returns the window even when nothing was used, and survives a structured clone', () => {
    const empty = buildProjectDaily([], { now, rules: WINDOWS });
    expect(empty).toEqual({ endDay: '2026-10-13', projects: [] });
    const split = buildProjectDaily([entry(at(0, 9), 'E:\\A')], { now, rules: WINDOWS });
    expect(() => structuredClone(split)).not.toThrow();
  });
});
