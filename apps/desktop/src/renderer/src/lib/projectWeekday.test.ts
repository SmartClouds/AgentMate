import { describe, expect, it, vi } from 'vitest';
import { projectRow, splitOf, usageOf } from '../components/usage/weekday/testing/fixtures';
import {
  addDays,
  assignSlots,
  buildChartModel,
  displayNames,
  foldWeekdays,
  hasPricedTokens,
  localeWeekInfo,
  mergeProjectDaily,
  niceScale,
  OTHER_KEY,
  priceState,
  rankProjects,
  type WeekdayProject,
  weekdayOfDay,
  weekdayOrder,
} from './projectWeekday';

/**
 * The arithmetic behind "Projects by weekday". The chart is only as honest as these numbers, so each
 * rule that a reader could check by hand has a case here.
 */

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

describe('calendar helpers', () => {
  it('finds the weekday of a day, with Sunday as 0', () => {
    expect(weekdayOfDay('2026-10-13')).toBe(2); // a Tuesday
    expect(weekdayOfDay('2026-10-18')).toBe(0); // a Sunday
    expect(weekdayOfDay('not a day')).toBeNull();
  });

  it('steps across month, year and leap-day boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-13', -27)).toBe('2026-09-16');
    expect(addDays('not a day', 1)).toBeNull();
  });

  it('orders the week from the first day given', () => {
    expect(weekdayOrder(1)).toEqual(WEEK_ORDER);
    expect(weekdayOrder(0)).toEqual(ALL_DAYS);
    expect(weekdayOrder(6)).toEqual([6, 0, 1, 2, 3, 4, 5]);
  });

  it("reads the locale's week start and weekend", () => {
    // ICU's week table for en-US differs across Node/ICU versions (Sunday vs Monday first),
    // so pin the platform values with a stub and check the Sunday-as-0 mapping only.
    // Node 22 only has the older `weekInfo` getter, so add the method that gets stubbed.
    const locale = Intl.Locale.prototype as unknown as { getWeekInfo?: () => unknown };
    const addedMethod = typeof locale.getWeekInfo !== 'function';
    if (addedMethod) locale.getWeekInfo = () => undefined;
    const spy = vi.spyOn(Intl.Locale.prototype, 'getWeekInfo');
    spy.mockImplementation(function (this: Intl.Locale) {
      const tag = this.toString();
      if (tag.startsWith('en-US')) return { firstDay: 7, weekend: [6, 7], minimalDays: 1 };
      if (tag.startsWith('en-GB')) return { firstDay: 1, weekend: [6, 7], minimalDays: 4 };
      if (tag.startsWith('fa-IR')) return { firstDay: 6, weekend: [5], minimalDays: 1 };
      return { firstDay: 1, weekend: [6, 7], minimalDays: 4 };
    });
    try {
      expect(localeWeekInfo('en-US')).toEqual({ firstDay: 0, weekend: [6, 0] });
      expect(localeWeekInfo('en-GB')).toEqual({ firstDay: 1, weekend: [6, 0] });
      expect(localeWeekInfo('fa-IR')).toEqual({ firstDay: 6, weekend: [5] });
    } finally {
      spy.mockRestore();
      if (addedMethod) delete locale.getWeekInfo;
    }
  });

  it('falls back to Monday with a Saturday and Sunday weekend for a locale it cannot read', () => {
    expect(localeWeekInfo('not a locale!!')).toEqual({ firstDay: 1, weekend: [6, 0] });
  });
});

describe('mergeProjectDaily', () => {
  it('returns nothing when no provider reports a split', () => {
    expect(mergeProjectDaily([])).toBeNull();
    expect(mergeProjectDaily([undefined, usageOf('cursor')])).toBeNull();
    const failed = { ...usageOf('claude-code', splitOf([])), status: 'error' as const };
    expect(mergeProjectDaily([failed])).toBeNull();
  });

  it('adds one project together across providers and keeps its first name', () => {
    const claude = splitOf([
      projectRow({ key: 'project:p1', name: 'Runova', tokens: [0, 0, 0, 0, 0, 0, 100] }),
    ]);
    const codex = splitOf([
      projectRow({ key: 'project:p1', name: 'Renamed', tokens: [0, 0, 0, 0, 0, 0, 50] }),
    ]);

    const merged = mergeProjectDaily([usageOf('claude-code', claude), usageOf('codex', codex)]);

    expect(merged?.projects).toHaveLength(1);
    expect(merged?.projects[0].name).toBe('Runova');
    // Saturday carries 150 (100 + 50) on each of the four Saturdays in the window.
    expect(merged?.projects[0].tokens.reduce((sum, value) => sum + value, 0)).toBe(600);
  });

  it('shifts a provider whose window ends a day earlier onto the newest day', () => {
    // The scan ran just before midnight, so its last day is yesterday.
    const older = splitOf(
      [projectRow({ key: 'folder:a', name: 'a', tokens: [0, 0, 0, 0, 0, 0, 0] })],
      '2026-10-12',
    );
    older.projects[0].tokens[27] = 50; // 12 October
    const newer = splitOf([
      projectRow({ key: 'folder:b', name: 'b', tokens: [0, 0, 0, 0, 0, 0, 0] }),
    ]);

    const merged = mergeProjectDaily([usageOf('claude-code', older), usageOf('codex', newer)]);

    expect(merged?.endDay).toBe('2026-10-13');
    const row = merged?.projects.find((item) => item.key === 'folder:a');
    expect(row?.tokens[26]).toBe(50);
    expect(row?.tokens[27]).toBe(0);
  });

  it('treats missing, negative and non-numeric values as nothing', () => {
    const split = splitOf([
      projectRow({ key: 'folder:a', name: 'a', tokens: [1, 1, 1, 1, 1, 1, 1] }),
    ]);
    split.projects[0].tokens[3] = Number.NaN;
    split.projects[0].tokens[4] = -5;
    split.projects[0].tokens[5] = Number.POSITIVE_INFINITY;

    const merged = mergeProjectDaily([usageOf('claude-code', split)]);

    expect(merged?.projects[0].tokens[3]).toBe(0);
    expect(merged?.projects[0].tokens[4]).toBe(0);
    expect(merged?.projects[0].tokens[5]).toBe(0);
  });

  it('ignores a window whose end day is not a day', () => {
    const broken = splitOf(
      [projectRow({ key: 'folder:a', name: 'a', tokens: [1, 0, 0, 0, 0, 0, 0] })],
      'soon',
    );
    expect(mergeProjectDaily([usageOf('claude-code', broken)])).toBeNull();
  });
});

describe('hasPricedTokens and priceState', () => {
  it('offers the cost view only when some token has a price', () => {
    const priced = splitOf([
      projectRow({ key: 'folder:a', name: 'a', tokens: [5, 0, 0, 0, 0, 0, 0] }),
    ]);
    const unpriced = splitOf([
      projectRow({
        key: 'folder:a',
        name: 'a',
        tokens: [5, 0, 0, 0, 0, 0, 0],
        unpriced: [5, 0, 0, 0, 0, 0, 0],
      }),
    ]);
    expect(hasPricedTokens(mergeProjectDaily([usageOf('claude-code', priced)]))).toBe(true);
    expect(hasPricedTokens(mergeProjectDaily([usageOf('claude-code', unpriced)]))).toBe(false);
    expect(hasPricedTokens(null)).toBe(false);
  });

  it('tells a fully priced, partly priced, unpriced and empty figure apart', () => {
    expect(priceState({ tokens: 10, unpricedTokens: 0 })).toBe('priced');
    expect(priceState({ tokens: 10, unpricedTokens: 4 })).toBe('partial');
    expect(priceState({ tokens: 10, unpricedTokens: 10 })).toBe('unpriced');
    expect(priceState({ tokens: 0, unpricedTokens: 0 })).toBe('none');
  });
});

describe('foldWeekdays', () => {
  // Sunday 1000, Monday 2000 ... Saturday 7000: each weekday has a distinct, easy-to-check total.
  const split = mergedOf([
    projectRow({
      key: 'folder:a',
      name: 'a',
      tokens: [1000, 2000, 3000, 4000, 5000, 6000, 7000],
      costUsd: [1, 2, 3, 4, 5, 6, 7],
    }),
  ]);

  it('sums each weekday over four occurrences in the 4-week range', () => {
    const { projects, dates } = foldWeekdays(split, 28);
    expect(projects[0].cells.map((cell) => cell.tokens)).toEqual([
      4000, 8000, 12000, 16000, 20000, 24000, 28000,
    ]);
    expect(projects[0].tokens).toBe(112000);
    expect(projects[0].costUsd).toBeCloseTo(4 * 28, 10);
    expect(dates[2]).toEqual(['2026-09-22', '2026-09-29', '2026-10-06', '2026-10-13']);
  });

  it('counts each weekday once in the 7-day range, and dates it', () => {
    const { projects, dates } = foldWeekdays(split, 7);
    expect(projects[0].cells.map((cell) => cell.tokens)).toEqual([
      1000, 2000, 3000, 4000, 5000, 6000, 7000,
    ]);
    expect(dates[2]).toEqual(['2026-10-13']);
  });

  it('leaves out a project with nothing in the range', () => {
    const old = mergedOf([
      projectRow({ key: 'folder:old', name: 'old', tokens: [9, 9, 9, 9, 9, 9, 9] }),
    ]);
    // Only the first day of the 28-day window carries tokens, which the 7-day range never reaches.
    old.projects[0].tokens = old.projects[0].tokens.map((_, i) => (i === 0 ? 500 : 0));
    expect(foldWeekdays(old, 7).projects).toEqual([]);
    expect(foldWeekdays(old, 28).projects).toHaveLength(1);
  });
});

describe('rankProjects', () => {
  function project(key: string, tokens: number, costUsd: number, name = key): WeekdayProject {
    return {
      key,
      name,
      path: null,
      cells: [
        { tokens, costUsd, unpricedTokens: 0 },
        ...Array.from({ length: 6 }, () => ({ tokens: 0, costUsd: 0, unpricedTokens: 0 })),
      ],
      tokens,
      costUsd,
      unpricedTokens: 0,
    };
  }

  it('keeps six named projects and folds the rest', () => {
    const projects = Array.from({ length: 8 }, (_, i) => project(`p${i}`, (8 - i) * 100, 1));
    const { named, rest } = rankProjects(projects);
    expect(named.map((item) => item.key)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(rest.map((item) => item.key)).toEqual(['p6', 'p7']);
  });

  it('gives a colour to a project that is expensive even when it is light on tokens', () => {
    const cheap = Array.from({ length: 6 }, (_, i) => project(`cheap${i}`, 1000, 1));
    const costly = project('costly', 500, 50);
    const { named } = rankProjects([...cheap, costly]);
    expect(named[0].key).toBe('costly');
    expect(named).toHaveLength(6);
  });

  it('always folds the unknown and tail rows, however large', () => {
    const { named, rest } = rankProjects([
      project('unknown', 9000, 9),
      project('tail', 8000, 8),
      project('p1', 10, 1),
    ]);
    expect(named.map((item) => item.key)).toEqual(['p1']);
    expect(rest.map((item) => item.key)).toEqual(['unknown', 'tail']);
  });

  it('breaks a tie by name, then key, so the order never changes between renders', () => {
    const { named } = rankProjects([project('b', 100, 1, 'Beta'), project('a', 100, 1, 'Alpha')]);
    expect(named.map((item) => item.name)).toEqual(['Alpha', 'Beta']);
  });
});

describe('assignSlots', () => {
  it('keeps the slot a project already had', () => {
    const memory = new Map([
      ['a', 3],
      ['b', 5],
    ]);
    expect(assignSlots(memory, ['b', 'a'])).toEqual(
      new Map([
        ['b', 5],
        ['a', 3],
      ]),
    );
  });

  it('gives a newcomer the lowest slot that is free', () => {
    const memory = new Map([['a', 2]]);
    expect(assignSlots(memory, ['new', 'a'])).toEqual(
      new Map([
        ['new', 0],
        ['a', 2],
      ]),
    );
  });

  it('lets a higher-ranked project keep its slot over a lower-ranked one', () => {
    const memory = new Map([
      ['b', 0],
      ['a', 0],
    ]);
    expect(assignSlots(memory, ['b', 'a'])).toEqual(
      new Map([
        ['b', 0],
        ['a', 1],
      ]),
    );
  });

  it('gives back a remembered slot when a project returns to the chart', () => {
    const memory = new Map([['old', 4]]);
    expect(assignSlots(memory, ['new'])).toEqual(new Map([['new', 0]]));
    expect(assignSlots(memory, ['old'])).toEqual(new Map([['old', 4]]));
  });

  it('never hands out more than eight slots', () => {
    const keys = Array.from({ length: 9 }, (_, i) => `k${i}`);
    expect(assignSlots(new Map(), keys).size).toBe(8);
  });
});

describe('displayNames', () => {
  it('leaves unique names alone', () => {
    const names = displayNames([{ key: 'a', name: 'Galaxy', path: 'E:/Galaxy' }]);
    expect(names.get('a')).toBe('Galaxy');
  });

  it('adds the parent folder to two projects with one name', () => {
    const names = displayNames([
      { key: 'a', name: 'Runova', path: 'E:/Runova' },
      { key: 'b', name: 'Runova', path: 'D:/Old/Runova' },
    ]);
    expect(names.get('a')).toBe('Runova (E:)');
    expect(names.get('b')).toBe('Runova (Old)');
  });

  it('numbers names that are still the same after the parent is added', () => {
    const names = displayNames([
      { key: 'a', name: 'app', path: null },
      { key: 'b', name: 'app', path: null },
    ]);
    expect([names.get('a'), names.get('b')]).toEqual(['app', 'app 2']);
  });
});

describe('niceScale', () => {
  it('ends the axis on a round number with four gridlines', () => {
    expect(niceScale(100)).toEqual({ max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceScale(4991)).toEqual({ max: 8000, ticks: [0, 2000, 4000, 6000, 8000] });
  });

  it('gives a usable axis for nothing, or a value that is not a number', () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(niceScale(Number.NaN).max).toBe(1);
    expect(niceScale(-5).max).toBe(1);
  });

  it('rounds away floating-point noise in the ticks', () => {
    expect(niceScale(0.3).ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
  });
});

describe('buildChartModel', () => {
  // Five projects on a 4-week window. Each weekday's total is fixed by the numbers below.
  const split = mergedOf([
    projectRow({
      key: 'project:a',
      name: 'Alpha',
      tokens: [0, 4000, 0, 0, 0, 0, 0],
      costUsd: [0, 4, 0, 0, 0, 0, 0],
    }),
    projectRow({
      key: 'project:b',
      name: 'Beta',
      tokens: [0, 0, 1000, 0, 0, 0, 0],
      costUsd: [0, 0, 1, 0, 0, 0, 0],
    }),
    projectRow({
      key: 'project:c',
      name: 'Gamma',
      tokens: [0, 0, 0, 500, 0, 0, 0],
      costUsd: [0, 0, 0, 9, 0, 0, 0],
    }),
    projectRow({ key: 'unknown', name: 'Unknown folder', tokens: [0, 0, 0, 0, 200, 0, 0] }),
    projectRow({
      key: 'folder:d',
      name: 'Delta',
      tokens: [0, 0, 0, 0, 0, 100, 0],
      costUsd: [0, 0, 0, 0, 0, 1, 0],
    }),
  ]);
  const fold = foldWeekdays(split, 7);
  const ranking = rankProjects(fold.projects, 2);

  function model(overrides: Partial<Parameters<typeof buildChartModel>[0]> = {}) {
    const slots = assignSlots(
      new Map(),
      ranking.named.map((item) => item.key),
    );
    return buildChartModel({
      projects: fold.projects,
      ranking,
      slots,
      metric: 'tokens',
      range: 7,
      order: WEEK_ORDER,
      ...overrides,
    });
  }

  it('puts one column per weekday in display order, with each total', () => {
    const chart = model();
    // The week starts on Monday here, so the columns run Monday to Sunday.
    expect(chart.columns.map((column) => column.weekday)).toEqual(WEEK_ORDER);
    expect(chart.columns.map((column) => column.total)).toEqual([4000, 1000, 500, 200, 100, 0, 0]);
    expect(chart.total).toBe(5800);
  });

  it('stacks the named projects by colour slot, with Other on top', () => {
    const chart = model();
    expect(chart.series.map((series) => series.key)).toEqual(['project:a', 'project:c', OTHER_KEY]);
    const other = chart.series.at(-1);
    expect(other?.members).toBe(3);
    expect(other?.tokens).toBe(1000 + 200 + 100);
  });

  it('scales the axis to the tallest column', () => {
    const chart = model();
    expect(chart.scale.max).toBeGreaterThanOrEqual(4000);
    expect(chart.scale.ticks.at(-1)).toBe(chart.scale.max);
  });

  it('finds the busiest weekday and its share of the visible total', () => {
    expect(model().busiest).toEqual({ weekday: 1, total: 4000, share: 4000 / 5800 });
  });

  it('shows one project alone when it is soloed, and rescales to it', () => {
    const chart = model({ solo: 'project:a' });
    expect(chart.series.map((series) => series.key)).toEqual(['project:a']);
    expect(chart.total).toBe(4000);
    expect(chart.allSeries.length).toBe(3);
    expect(chart.topProject?.share).toBeCloseTo(4000 / 5800, 10);
  });

  it('ignores a solo that matches no series', () => {
    expect(model({ solo: 'project:missing' }).series.length).toBe(3);
  });

  it('switches the figures to cost without changing which projects are on the chart', () => {
    const tokens = model({ metric: 'tokens' });
    const cost = model({ metric: 'cost' });
    expect(cost.allSeries.map((series) => series.key)).toEqual(
      tokens.allSeries.map((series) => series.key),
    );
    // Monday is Alpha's day: 4 dollars. Every project's cost adds up to 4 + 1 + 9 + 1.
    expect(cost.columns[0].total).toBe(4);
    expect(cost.allTotal).toBeCloseTo(15, 10);
  });

  it('keeps the unknown folder out of the top project, even when it is the largest', () => {
    const big = mergedOf([
      projectRow({ key: 'unknown', name: 'Unknown folder', tokens: [0, 9000, 0, 0, 0, 0, 0] }),
      projectRow({ key: 'project:a', name: 'Alpha', tokens: [0, 100, 0, 0, 0, 0, 0] }),
    ]);
    const folded = foldWeekdays(big, 7);
    const chart = buildChartModel({
      projects: folded.projects,
      ranking: rankProjects(folded.projects),
      slots: new Map(),
      metric: 'tokens',
      range: 7,
      order: WEEK_ORDER,
    });
    expect(chart.topProject?.key).toBe('project:a');
  });

  it('gives an occurrence count of four for a 4-week range and one for a week', () => {
    expect(model({ range: 7 }).occurrences).toBe(1);
    expect(model({ range: 28 }).occurrences).toBe(4);
  });

  it('reports no busiest day and no top project when there is nothing to show', () => {
    const empty = buildChartModel({
      projects: [],
      ranking: { named: [], rest: [] },
      slots: new Map(),
      metric: 'tokens',
      range: 7,
      order: WEEK_ORDER,
    });
    expect(empty.busiest).toBeNull();
    expect(empty.topProject).toBeNull();
    expect(empty.total).toBe(0);
    expect(empty.scale.max).toBe(1);
  });
});

/** The merged split of one provider, ready to fold. */
function mergedOf(projects: ReturnType<typeof projectRow>[]) {
  const merged = mergeProjectDaily([usageOf('claude-code', splitOf(projects))]);
  if (!merged) throw new Error('the fixture should merge');
  return merged;
}
