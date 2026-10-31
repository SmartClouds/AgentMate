import type {
  AffectedMatch,
  InstalledTool,
  NewsListItem,
  NewsTechnology,
} from '../../shared/newsTypes';

/**
 * "Affects your system" (E42): which of an item's technologies match a tool found on this machine.
 * The version range grammar is the one in docs/website/api-contract.md, the same one the website
 * API validates with (VersionRange.cs). Pure, so it runs without Electron.
 */

const MAX_PARTS = 4;

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  operator: Operator;
  version: number[];
}

/** One comparator set per ` || ` alternative; an empty set is `*` and holds for every version. */
export type VersionRange = Comparator[][];

/** A comparator's own version is strict: one to four integers, after an optional v. */
const COMPARATOR = /^(<=|>=|<|>|=)(v?\d+(?:\.\d+){0,3})$/;

/**
 * Up to four leading numeric parts, read until the first character that is not a digit or a dot,
 * after one leading `v`. Missing parts are 0. Null when there is no numeric part at all.
 */
export function versionParts(version: string): number[] | null {
  const text = version.startsWith('v') ? version.slice(1) : version;
  const leading = /^[\d.]*/.exec(text)?.[0] ?? '';
  const parts: number[] = [];
  for (const part of leading.split('.')) {
    if (parts.length === MAX_PARTS || part.length === 0) break;
    parts.push(Number(part));
  }
  if (parts.length === 0) return null;
  while (parts.length < MAX_PARTS) parts.push(0);
  return parts;
}

export function parseVersionRange(text: string): VersionRange | null {
  if (!text) return null;
  const sets: VersionRange = [];
  for (const set of text.split(' || ')) {
    if (set === '*') {
      sets.push([]);
      continue;
    }
    const comparators: Comparator[] = [];
    for (const part of set.split(' ')) {
      const match = COMPARATOR.exec(part);
      const version = match ? versionParts(match[2]) : null;
      if (!match || !version) return null;
      comparators.push({ operator: match[1] as Operator, version });
    }
    sets.push(comparators);
  }
  return sets;
}

function compare(left: number[], right: number[]): number {
  for (let i = 0; i < MAX_PARTS; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function holds(comparator: Comparator, version: number[]): boolean {
  const order = compare(version, comparator.version);
  switch (comparator.operator) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    default:
      return order === 0;
  }
}

/** Whether the version is in the range. An unparseable range or a version with no number never is. */
export function satisfiesRange(range: string, version: string): boolean {
  const parsed = parseVersionRange(range);
  const parts = versionParts(version);
  if (!parsed || !parts) return false;
  return parsed.some((set) => set.every((comparator) => holds(comparator, parts)));
}

function matchTechnology(
  technology: NewsTechnology,
  installed: readonly InstalledTool[],
): AffectedMatch | null {
  // Candidates are tried in the order given, which is how the installed Node.js wins over the one
  // inside Runova when both are affected.
  const tool = installed.find(
    (candidate) =>
      candidate.slug === technology.technology &&
      satisfiesRange(technology.versionRange, candidate.version),
  );
  if (!tool) return null;
  return {
    slug: technology.technology,
    label: tool.label,
    version: tool.version,
    versionRange: technology.versionRange,
    fixedIn: technology.fixedIn,
  };
}

/** Every technology of the item that an installed tool is affected by, in the item's order. */
export function matchNewsAll(
  item: NewsListItem,
  installed: readonly InstalledTool[],
): AffectedMatch[] {
  return item.technologies.flatMap((technology) => matchTechnology(technology, installed) ?? []);
}

/** The first affected technology, the one the badge names, or null. */
export function matchNews(
  item: NewsListItem,
  installed: readonly InstalledTool[],
): AffectedMatch | null {
  return matchNewsAll(item, installed)[0] ?? null;
}
