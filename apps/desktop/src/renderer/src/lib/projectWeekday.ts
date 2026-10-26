import type { ProjectDaily, ProviderUsage } from '@runova/core';

// The model behind "Projects by weekday". The scan sends each project's tokens and cost for each of
// the last 28 local days. This turns that into weekday columns, ranks the projects, and gives the
// busiest ones a colour slot that they keep. Pure, so the chart's arithmetic is tested on its own.

export type WeekdayMetric = 'tokens' | 'cost';
export type WeekdayRange = 7 | 28;

/** Days of the week as JavaScript numbers: 0 is Sunday, 6 is Saturday. */
export interface WeekInfo {
  firstDay: number;
  weekend: readonly number[];
}

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The series key of the folded rest. Project keys never take this form. */
export const OTHER_KEY = 'other';
/** The rows the scan writes for sessions with no folder and for the rows past its cap. */
export const UNKNOWN_KEY = 'unknown';
const TAIL_KEY = 'tail';
/** Projects that get a colour of their own. The rest fold into Other. */
export const MAX_NAMED = 6;
/** The categorical palette has eight validated colours. */
export const SLOT_COUNT = 8;

const DAY_MS = 86_400_000;

const pad = (value: number): string => String(value).padStart(2, '0');

/** Midnight UTC of a `YYYY-MM-DD` day, or null when the text is not one. */
function parseDay(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** The weekday of a calendar day. UTC arithmetic, so no time zone can shift it. */
export function weekdayOfDay(day: string): number | null {
  const ms = parseDay(day);
  return ms === null ? null : new Date(ms).getUTCDay();
}

/** The day `delta` days after `day`, as `YYYY-MM-DD`. */
export function addDays(day: string, delta: number): string | null {
  const ms = parseDay(day);
  if (ms === null) return null;
  const date = new Date(ms + delta * DAY_MS);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function daysBetween(from: string, to: string): number {
  const a = parseDay(from);
  const b = parseDay(to);
  return a === null || b === null ? Number.NaN : Math.round((b - a) / DAY_MS);
}

/**
 * The week the user's locale starts on, and its weekend, from the platform's locale data. Falls back
 * to Monday, with a Saturday and Sunday weekend, where the platform has none.
 */
export function localeWeekInfo(locale?: string): WeekInfo {
  const fallback: WeekInfo = { firstDay: 1, weekend: [6, 0] };
  try {
    const tag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
    const intl = new Intl.Locale(tag) as unknown as {
      getWeekInfo?: () => { firstDay: number; weekend?: number[] };
    };
    const info = intl.getWeekInfo?.();
    if (!info || !Number.isInteger(info.firstDay)) return fallback;
    const weekend = Array.isArray(info.weekend)
      ? info.weekend.map((day) => day % 7)
      : fallback.weekend;
    return { firstDay: info.firstDay % 7, weekend };
  } catch {
    return fallback;
  }
}

/** The seven weekdays, starting from `firstDay`. */
export function weekdayOrder(firstDay: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (firstDay + i) % 7);
}

export interface SplitProject {
  key: string;
  name: string;
  path: string | null;
  tokens: number[];
  costUsd: number[];
  unpricedTokens: number[];
}

/** The split of every provider that reports one, on a single window ending at `endDay`. */
export interface DailySplit {
  endDay: string;
  days: number;
  projects: SplitProject[];
}

const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const zeros = (length: number): number[] => new Array<number>(length).fill(0);

/**
 * One split from every provider's. Projects with the same key are added together. A provider whose
 * window ends a day earlier (the scan ran just before midnight) is shifted onto the newest day.
 */
export function mergeProjectDaily(
  usages: readonly (ProviderUsage | undefined)[],
): DailySplit | null {
  const parts: ProjectDaily[] = [];
  for (const usage of usages) {
    const daily = usage?.status === 'ok' ? usage.projectDaily : undefined;
    if (daily && parseDay(daily.endDay) !== null) parts.push(daily);
  }
  if (parts.length === 0) return null;

  const endDay =
    parts
      .map((part) => part.endDay)
      .sort()
      .at(-1) ?? parts[0].endDay;
  const days = Math.max(
    0,
    ...parts.flatMap((part) => part.projects.map((row) => row.tokens.length)),
  );
  const byKey = new Map<string, SplitProject>();
  for (const part of parts) {
    const shift = daysBetween(part.endDay, endDay);
    for (const row of part.projects) {
      let target = byKey.get(row.key);
      if (!target) {
        target = {
          key: row.key,
          name: row.name,
          path: row.path,
          tokens: zeros(days),
          costUsd: zeros(days),
          unpricedTokens: zeros(days),
        };
        byKey.set(row.key, target);
      }
      const length = row.tokens.length;
      for (let j = 0; j < length; j += 1) {
        const i = j + (days - length) - shift;
        if (i < 0 || i >= days) continue;
        target.tokens[i] += finite(row.tokens[j]);
        target.costUsd[i] += finite(row.costUsd[j]);
        target.unpricedTokens[i] += finite(row.unpricedTokens[j]);
      }
    }
  }
  return { endDay, days, projects: [...byKey.values()] };
}

/** Whether any token in the split could be priced, which decides whether the cost view is offered. */
export function hasPricedTokens(split: DailySplit | null): boolean {
  if (!split) return false;
  return split.projects.some((row) =>
    row.tokens.some((tokens, i) => tokens - (row.unpricedTokens[i] ?? 0) > 0),
  );
}

export interface WeekdayCell {
  tokens: number;
  costUsd: number;
  unpricedTokens: number;
}

export interface WeekdayProject {
  key: string;
  name: string;
  path: string | null;
  /** One cell per weekday, indexed by the JavaScript weekday number. */
  cells: WeekdayCell[];
  tokens: number;
  costUsd: number;
  unpricedTokens: number;
}

export interface WeekdayFold {
  /** The projects with any tokens inside the range. */
  projects: WeekdayProject[];
  /** The days that fall on each weekday inside the range, oldest first. */
  dates: string[][];
}

const emptyCell = (): WeekdayCell => ({ tokens: 0, costUsd: 0, unpricedTokens: 0 });

/** Folds the last `range` days of the split into one cell per weekday. */
export function foldWeekdays(split: DailySplit, range: WeekdayRange): WeekdayFold {
  const first = Math.max(0, split.days - range);
  const dates: string[][] = Array.from({ length: 7 }, () => []);
  const weekdays: (number | null)[] = [];
  for (let i = first; i < split.days; i += 1) {
    const day = addDays(split.endDay, i - (split.days - 1));
    const weekday = day === null ? null : weekdayOfDay(day);
    weekdays.push(weekday);
    if (day !== null && weekday !== null) dates[weekday].push(day);
  }

  const projects: WeekdayProject[] = [];
  for (const row of split.projects) {
    const cells = Array.from({ length: 7 }, emptyCell);
    for (let i = first; i < split.days; i += 1) {
      const weekday = weekdays[i - first];
      if (weekday === null || weekday === undefined) continue;
      cells[weekday].tokens += row.tokens[i] ?? 0;
      cells[weekday].costUsd += row.costUsd[i] ?? 0;
      cells[weekday].unpricedTokens += row.unpricedTokens[i] ?? 0;
    }
    const tokens = cells.reduce((sum, cell) => sum + cell.tokens, 0);
    if (tokens <= 0) continue;
    projects.push({
      key: row.key,
      name: row.name,
      path: row.path,
      cells,
      tokens,
      costUsd: cells.reduce((sum, cell) => sum + cell.costUsd, 0),
      unpricedTokens: cells.reduce((sum, cell) => sum + cell.unpricedTokens, 0),
    });
  }
  return { projects, dates };
}

export const metricValue = (
  value: { tokens: number; costUsd: number },
  metric: WeekdayMetric,
): number => (metric === 'cost' ? value.costUsd : value.tokens);

export type PriceState = 'none' | 'priced' | 'partial' | 'unpriced';

/** Whether a figure is fully priced, partly priced, or made only of models with no price. */
export function priceState(value: { tokens: number; unpricedTokens: number }): PriceState {
  if (!(value.tokens > 0)) return 'none';
  if (value.unpricedTokens >= value.tokens) return 'unpriced';
  return value.unpricedTokens > 0 ? 'partial' : 'priced';
}

export interface Ranking {
  /** The busiest projects, each with a colour of its own, busiest first. */
  named: WeekdayProject[];
  /** Everything else, including the unknown and tail rows, which never get a colour. */
  rest: WeekdayProject[];
}

/**
 * Ranks the projects of one range by the larger of their token share and their cost share, so a
 * project that is expensive but light on tokens can still earn a colour. Ties fall to tokens, then
 * name, then key.
 */
export function rankProjects(projects: readonly WeekdayProject[], max = MAX_NAMED): Ranking {
  const totalTokens = projects.reduce((sum, project) => sum + project.tokens, 0);
  const totalCost = projects.reduce((sum, project) => sum + project.costUsd, 0);
  const score = (project: WeekdayProject): number =>
    Math.max(
      totalTokens > 0 ? project.tokens / totalTokens : 0,
      totalCost > 0 ? project.costUsd / totalCost : 0,
    );
  const folded = (project: WeekdayProject): boolean =>
    project.key === UNKNOWN_KEY || project.key === TAIL_KEY;

  const ranked = projects
    .filter((project) => !folded(project))
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        b.tokens - a.tokens ||
        a.name.localeCompare(b.name) ||
        a.key.localeCompare(b.key),
    );
  return {
    named: ranked.slice(0, max),
    rest: [...ranked.slice(max), ...projects.filter(folded)],
  };
}

/**
 * The colour slot of each named project. A project keeps the slot it was given before while nothing
 * ranked above it has taken that slot, and a newcomer takes the lowest free one. `memory` may hold
 * projects that are out of view right now, so they get their colour back when they return.
 */
export function assignSlots(
  memory: ReadonlyMap<string, number>,
  keys: readonly string[],
  slots = SLOT_COUNT,
): Map<string, number> {
  const assigned = new Map<string, number>();
  const taken = new Set<number>();
  for (const key of keys) {
    const slot = memory.get(key);
    if (slot !== undefined && slot < slots && !taken.has(slot)) {
      assigned.set(key, slot);
      taken.add(slot);
    }
  }
  for (const key of keys) {
    if (assigned.has(key)) continue;
    let slot = 0;
    while (slot < slots && taken.has(slot)) slot += 1;
    if (slot >= slots) break;
    assigned.set(key, slot);
    taken.add(slot);
  }
  return assigned;
}

/** The folder above a path: `E:` for `E:/Runova`. Used to tell two folders with one name apart. */
function parentOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : (parts[0] ?? path);
}

/**
 * Names for the projects on the chart. Two projects with one name get their parent folder added,
 * and if that still clashes they are numbered.
 */
export function displayNames(
  items: readonly { key: string; name: string; path: string | null }[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);

  const labelled = new Map<string, string>();
  for (const item of items) {
    const clash = (counts.get(item.name) ?? 0) > 1;
    labelled.set(
      item.key,
      clash && item.path ? `${item.name} (${parentOf(item.path)})` : item.name,
    );
  }

  const names = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const item of items) {
    const label = labelled.get(item.key) ?? item.name;
    const occurrence = (seen.get(label) ?? 0) + 1;
    seen.set(label, occurrence);
    names.set(item.key, occurrence === 1 ? label : `${label} ${occurrence}`);
  }
  return names;
}

/**
 * A y-axis that ends on a round number, with `intervals` gridlines above zero. Steps are 1, 2, 2.5
 * or 5 times a power of ten, so the ticks read easily at any size.
 */
export function niceScale(max: number, intervals = 4): { max: number; ticks: number[] } {
  const top = Number.isFinite(max) && max > 0 ? max : 1;
  const raw = top / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    ([1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= raw) ?? 10) * magnitude;
  const ticks = Array.from({ length: intervals + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  return { max: ticks[intervals], ticks };
}

export interface ChartSeries {
  key: string;
  name: string;
  path: string | null;
  /** The colour slot, or null for Other. */
  slot: number | null;
  /** How many projects this series stands for. Other can stand for many. */
  members: number;
  cells: WeekdayCell[];
  tokens: number;
  costUsd: number;
  unpricedTokens: number;
}

export interface ChartColumn {
  weekday: number;
  /** The visible segments of this weekday, bottom first, zero values left out. */
  segments: { series: ChartSeries; value: number }[];
  total: number;
}

export interface ChartModel {
  metric: WeekdayMetric;
  range: WeekdayRange;
  /** How many times each weekday occurs in the range: four in 28 days, one in seven. */
  occurrences: number;
  /** Every series, for the legend, whether or not one is soloed. */
  allSeries: ChartSeries[];
  /** The series on the chart, in stack order: by colour slot, with Other on top. */
  series: ChartSeries[];
  /** One column per weekday, in display order. */
  columns: ChartColumn[];
  scale: { max: number; ticks: number[] };
  /** The visible total in the metric. */
  total: number;
  /** The total in the metric across every project, soloed or not. */
  allTotal: number;
  busiest: { weekday: number; total: number; share: number } | null;
  topProject: { key: string; name: string; value: number; share: number } | null;
}

export interface ChartInput {
  /** Every project in the range, unfolded. */
  projects: readonly WeekdayProject[];
  ranking: Ranking;
  slots: ReadonlyMap<string, number>;
  metric: WeekdayMetric;
  range: WeekdayRange;
  order: readonly number[];
  /** The one project the reader soloed, if any. */
  solo?: string | null;
  names?: ReadonlyMap<string, string>;
}

const sumOf = (cells: readonly WeekdayCell[], field: keyof WeekdayCell): number =>
  cells.reduce((sum, cell) => sum + cell[field], 0);

/** Everything the chart draws, worked out from the ranking, the slots and the metric. */
export function buildChartModel(input: ChartInput): ChartModel {
  const { projects, ranking, slots, metric, range, order } = input;
  const names =
    input.names ??
    displayNames(
      projects.map((project) => ({ key: project.key, name: project.name, path: project.path })),
    );

  const named: ChartSeries[] = ranking.named.map((project) => ({
    key: project.key,
    name: names.get(project.key) ?? project.name,
    path: project.path,
    slot: slots.get(project.key) ?? null,
    members: 1,
    cells: project.cells,
    tokens: project.tokens,
    costUsd: project.costUsd,
    unpricedTokens: project.unpricedTokens,
  }));
  const allSeries = [...named];
  if (ranking.rest.length > 0) {
    const cells = Array.from({ length: 7 }, (_, weekday) => ({
      tokens: ranking.rest.reduce((sum, project) => sum + project.cells[weekday].tokens, 0),
      costUsd: ranking.rest.reduce((sum, project) => sum + project.cells[weekday].costUsd, 0),
      unpricedTokens: ranking.rest.reduce(
        (sum, project) => sum + project.cells[weekday].unpricedTokens,
        0,
      ),
    }));
    allSeries.push({
      key: OTHER_KEY,
      name: 'Other',
      path: null,
      slot: null,
      members: ranking.rest.length,
      cells,
      tokens: sumOf(cells, 'tokens'),
      costUsd: sumOf(cells, 'costUsd'),
      unpricedTokens: sumOf(cells, 'unpricedTokens'),
    });
  }

  const solo =
    input.solo && allSeries.some((series) => series.key === input.solo) ? input.solo : null;
  const series = (solo ? allSeries.filter((item) => item.key === solo) : allSeries)
    .slice()
    .sort((a, b) => (a.slot ?? SLOT_COUNT) - (b.slot ?? SLOT_COUNT));

  const columns: ChartColumn[] = order.map((weekday) => {
    const segments = series.flatMap((item) => {
      const value = metricValue(item.cells[weekday], metric);
      return value > 0 ? [{ series: item, value }] : [];
    });
    return { weekday, segments, total: segments.reduce((sum, segment) => sum + segment.value, 0) };
  });
  const total = columns.reduce((sum, column) => sum + column.total, 0);
  const allTotal = allSeries.reduce((sum, item) => sum + metricValue(item, metric), 0);

  let busiest: ChartModel['busiest'] = null;
  for (const column of columns) {
    if (column.total > 0 && (!busiest || column.total > busiest.total)) {
      busiest = { weekday: column.weekday, total: column.total, share: column.total / total };
    }
  }

  const projectValue = (project: WeekdayProject): number => metricValue(project, metric);
  let topProject: ChartModel['topProject'] = null;
  if (solo) {
    const only = series[0];
    if (only) {
      const value = metricValue(only, metric);
      topProject = {
        key: only.key,
        name: only.name,
        value,
        share: allTotal > 0 ? value / allTotal : 0,
      };
    }
  } else {
    const best = projects
      .filter((project) => project.key !== UNKNOWN_KEY && project.key !== TAIL_KEY)
      .slice()
      .sort((a, b) => projectValue(b) - projectValue(a) || a.name.localeCompare(b.name))[0];
    if (best && projectValue(best) > 0) {
      const value = projectValue(best);
      topProject = {
        key: best.key,
        name: names.get(best.key) ?? best.name,
        value,
        share: allTotal > 0 ? value / allTotal : 0,
      };
    }
  }

  const maxColumn = Math.max(0, ...columns.map((column) => column.total));
  return {
    metric,
    range,
    occurrences: range / 7,
    allSeries,
    series,
    columns,
    scale: niceScale(maxColumn),
    total,
    allTotal,
    busiest,
    topProject,
  };
}
