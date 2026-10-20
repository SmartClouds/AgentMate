/**
 * Ranking for the explorer's file search. The whole file list comes over once and every
 * keystroke is matched here, so this stays to plain string scans: `indexOf` for the common
 * case, and a subsequence walk only for the paths that have no straight match. A query that is
 * a glob or a `/regex/` skips the ranking and is matched by one compiled expression instead.
 */

export interface FileHit {
  /** Where the path sits in the list that was searched. */
  index: number;
  /** Path relative to the project root, with forward slashes. */
  path: string;
  /** Where the file name starts inside `path`. */
  nameStart: number;
  /** [start, end) ranges in `path` that matched, for highlighting. */
  ranges: [number, number][];
  score: number;
}

export interface FileSearchResult {
  hits: FileHit[];
  /** How many files matched, which can be more than `hits` holds. */
  total: number;
  /** Set when the query was a `/regex/` that does not compile. */
  invalid?: true;
}

export const DEFAULT_SEARCH_LIMIT = 200;

/**
 * Score floors, best first. Each match adds up to 99 on top, so a weaker kind of match can
 * never outrank a better one.
 */
const NAME_EXACT = 900;
const NAME_START = 800;
const NAME_PART = 700;
const PATH_PART = 600;
const NAME_FUZZY = 500;
const PATH_FUZZY = 400;

const WORD_BREAK = /[\\/\-_. ]/;

interface Match {
  score: number;
  ranges: [number, number][];
}

/** True at the start, after a separator, and at a camelCase hump. */
function isWordStart(text: string, at: number): boolean {
  if (at === 0) return true;
  const previous = text[at - 1];
  if (WORD_BREAK.test(previous)) return true;
  return previous === previous.toLowerCase() && text[at] !== text[at].toLowerCase();
}

/** An early, word-aligned run scores highest. Always between 0 and 99. */
function runBonus(original: string, at: number): number {
  return Math.max(0, 60 - at) + (isWordStart(original, at) ? 39 : 0);
}

/** The query's characters found in order, or null. Neighbouring hits merge into one range. */
function subsequence(
  lower: string,
  original: string,
  query: string,
  from: number,
): { ranges: [number, number][]; starts: number; spread: number } | null {
  const ranges: [number, number][] = [];
  let starts = 0;
  let cursor = from;
  let first = -1;
  for (const char of query) {
    const at = lower.indexOf(char, cursor);
    if (at === -1) return null;
    if (first === -1) first = at;
    if (isWordStart(original, at)) starts += 1;
    const last = ranges.at(-1);
    if (last && last[1] === at) last[1] = at + 1;
    else ranges.push([at, at + 1]);
    cursor = at + 1;
  }
  return { ranges, starts, spread: cursor - first };
}

function fuzzyMatch(
  lower: string,
  original: string,
  query: string,
  from: number,
  floor: number,
): Match | null {
  const found = subsequence(lower, original, query, from);
  if (!found) return null;
  const compact = Math.round((query.length / found.spread) * 60);
  return { score: floor + compact + Math.min(found.starts * 8, 39), ranges: found.ranges };
}

/** How one path scores against the query, or null when it does not match at all. */
function matchPath(path: string, lower: string, query: string, byPath: boolean): Match | null {
  const nameStart = lower.lastIndexOf('/') + 1;
  if (!byPath) {
    if (lower.length - nameStart === query.length && lower.endsWith(query)) {
      return { score: NAME_EXACT + 99, ranges: [[nameStart, lower.length]] };
    }
    const at = lower.indexOf(query, nameStart);
    if (at !== -1) {
      const floor = at === nameStart ? NAME_START : NAME_PART;
      return { score: floor + runBonus(path, at), ranges: [[at, at + query.length]] };
    }
  }
  const at = lower.indexOf(query);
  if (at !== -1) {
    return { score: PATH_PART + runBonus(path, at), ranges: [[at, at + query.length]] };
  }
  return (
    (byPath ? null : fuzzyMatch(lower, path, query, nameStart, NAME_FUZZY)) ??
    fuzzyMatch(lower, path, query, 0, PATH_FUZZY)
  );
}

/**
 * Lowercased copies of the paths, kept beside the index so a keystroke does not have to
 * lowercase the whole project again. A path whose lowercase form is a different length (a
 * handful of letters do that) keeps its original, and matches case-sensitively.
 */
export function loweredPaths(files: readonly string[]): string[] {
  return files.map((path) => {
    const lower = path.toLowerCase();
    return lower.length === path.length ? lower : path;
  });
}

/**
 * A path from the index, as a path on disk. The root comes from the main process, so its
 * separator is the one this system uses.
 */
export function toAbsolutePath(root: string, relative: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return `${trimmed}${separator}${separator === '/' ? relative : relative.replaceAll('/', separator)}`;
}

/** Whitespace is not useful inside a path, so "user store" reads as "userstore". */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, '').toLowerCase();
}

/** Every file a pattern lets through is as good as any other, so length and name decide. */
const PATTERN_SCORE = 0;

/** Something between two slashes: `/\.test\.tsx?$/`. */
const REGEX_QUERY = /^\/(.+)\/$/;
const GLOB_WILDCARD = /[*?]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * A glob as a regular expression. `*` stays inside a folder, `**` goes through them, `?` is one
 * character. The pattern has to line up with the end of the path and with the start of a folder
 * name, so `*.md` finds Markdown files anywhere and `docs/*.md` finds them in any `docs`. Each
 * run of fixed text is a capture group, which is what gets highlighted.
 */
function globToRegExp(glob: string): RegExp {
  let source = '';
  let fixed = '';
  const flush = (): void => {
    if (fixed) source += `(${escapeRegExp(fixed)})`;
    fixed = '';
  };
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at];
    if (char === '?') {
      flush();
      source += '[^/]';
    } else if (char === '*') {
      flush();
      let end = at;
      while (glob[end + 1] === '*') end += 1;
      if (end === at) {
        source += '[^/]*';
      } else if (glob[end + 1] === '/') {
        // `**/` also stands for no folder at all.
        source += '(?:.*/)?';
        end += 1;
      } else {
        source += '.*';
      }
      at = end;
    } else {
      fixed += char;
    }
  }
  flush();
  return new RegExp(`(?:^|/)${source}$`, 'id');
}

/**
 * The query as a pattern, when it is one: a `/regex/` or a glob with a `*` or `?` in it. Null
 * for an ordinary search, and 'invalid' for a regex that does not compile.
 */
function compilePattern(query: string): { regex: RegExp; glob: boolean } | 'invalid' | null {
  const literal = REGEX_QUERY.exec(query);
  if (literal) {
    try {
      return { regex: new RegExp(literal[1], 'i'), glob: false };
    } catch {
      return 'invalid';
    }
  }
  return GLOB_WILDCARD.test(query) ? { regex: globToRegExp(query), glob: true } : null;
}

function patternRanges(match: RegExpExecArray, glob: boolean): [number, number][] {
  if (!glob) {
    return match[0] ? [[match.index, match.index + match[0].length]] : [];
  }
  return (match.indices ?? []).slice(1).flatMap((range) => (range ? [[range[0], range[1]]] : []));
}

function matchPattern(
  files: readonly string[],
  pattern: { regex: RegExp; glob: boolean },
): FileHit[] {
  const hits: FileHit[] = [];
  for (const [index, path] of files.entries()) {
    const match = pattern.regex.exec(path);
    if (!match) continue;
    hits.push({
      index,
      path,
      nameStart: path.lastIndexOf('/') + 1,
      ranges: patternRanges(match, pattern.glob),
      score: PATTERN_SCORE,
    });
  }
  return hits;
}

function matchPlain(
  files: readonly string[],
  query: string,
  precomputed: readonly string[] | undefined,
): FileHit[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const lowered = precomputed ?? loweredPaths(files);
  const byPath = needle.includes('/');

  const hits: FileHit[] = [];
  for (const [index, path] of files.entries()) {
    const match = matchPath(path, lowered[index] ?? path, needle, byPath);
    if (!match) continue;
    hits.push({
      index,
      path,
      nameStart: path.lastIndexOf('/') + 1,
      ranges: match.ranges,
      score: match.score,
    });
  }
  return hits;
}

/**
 * `patterns` lets a query be a glob (`*.md`, `docs/*.ts`) or a regular expression between
 * slashes (`/\.test\.tsx?$/`). It is off by default because other callers search names that
 * are not paths, where a `*` or a slash is just a character.
 */
export function searchFiles(
  files: readonly string[],
  query: string,
  options: { limit?: number; lowered?: readonly string[]; patterns?: boolean } = {},
): FileSearchResult {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const pattern = options.patterns ? compilePattern(query.trim()) : null;
  if (pattern === 'invalid') return { hits: [], total: 0, invalid: true };
  const hits = pattern ? matchPattern(files, pattern) : matchPlain(files, query, options.lowered);
  const total = hits.length;
  // Same score: the shorter, then alphabetical path, so the order never wanders between runs.
  // Equal strings (two symbols with one name) keep the order they were given in.
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : a.index - b.index),
  );
  return { hits: hits.length > limit ? hits.slice(0, limit) : hits, total };
}
