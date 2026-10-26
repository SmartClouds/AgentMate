import {
  emptyUsageTokens,
  estimateCost,
  type ProjectDaily,
  type ProjectDailyUsage,
  type UsageTokens,
} from '@runova/core';
import type { UsageEntry } from './shared';

// The per-project split behind the Token Usage chart "Projects by weekday": tokens and estimated
// cost for each project on each local day of the last 28. Pure, so it is tested without a scan.
//
// A project is a registered Runova project, or one of its git worktrees. Any other folder is
// its own row. Folders are compared as normalized paths, so the Windows and Git Bash spellings of
// one folder land on one row.

export const SPLIT_DAYS = 28;
/** Past this many rows the smallest folders fold into one, so a long history stays readable. */
export const MAX_SPLIT_PROJECTS = 60;

export const UNKNOWN_KEY = 'unknown';
export const TAIL_KEY = 'tail';

export interface KnownProject {
  id: string;
  name: string;
  folderPath: string;
}

export interface KnownWorktree {
  projectId: string;
  path: string;
}

export interface KnownProjects {
  projects: readonly KnownProject[];
  worktrees: readonly KnownWorktree[];
}

export interface PathRules {
  /** Compare folders without letter case, as Windows and macOS file systems do. */
  caseInsensitive: boolean;
  /** Read `\\?\` prefixes and Git Bash `/e/dir` paths as Windows paths. */
  windows: boolean;
}

function defaultRules(): PathRules {
  return { caseInsensitive: process.platform !== 'linux', windows: process.platform === 'win32' };
}

/** Slashes, a `\\?\` prefix and a trailing slash removed, so one folder has one spelling. */
export function normalizeFolder(folder: string, rules: PathRules = defaultRules()): string {
  let path = folder.trim();
  if (rules.windows) path = path.replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\/, '');
  path = path.replace(/\\/g, '/');
  const unc = path.startsWith('//') ? '//' : '';
  path = unc + path.slice(unc.length).replace(/\/+/g, '/');
  if (rules.windows) {
    const msys = /^\/([a-zA-Z])(\/|$)/.exec(path);
    if (msys) path = `${msys[1].toUpperCase()}:/${path.slice(msys[0].length)}`;
  }
  if (path.length > 1 && path.endsWith('/') && !/^[a-zA-Z]:\/$/.test(path)) {
    path = path.slice(0, -1);
  }
  return path;
}

/** A Claude Code worktree lives in `<repo>/.claude/worktrees/<name>`, and its sessions belong to the repo. */
export function foldWorktree(normalized: string): string {
  const match = /\/\.claude\/worktrees\//i.exec(normalized);
  return match && match.index > 0 ? normalized.slice(0, match.index) : normalized;
}

export interface ResolvedFolder {
  key: string;
  name: string;
  path: string | null;
}

interface Root {
  key: string;
  name: string;
  /** The folder as compared: normalized, and lower-cased where case does not count. */
  compare: string;
  path: string;
}

function basenameOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Maps a session's folder to its row. A folder inside a registered project (or one of its
 * worktrees) belongs to that project. Anything else is a row of its own, named after its last
 * segment. A missing folder is `unknown`.
 */
export function createProjectResolver(
  known: KnownProjects | undefined,
  rules: PathRules = defaultRules(),
): (folder: string | null | undefined) => ResolvedFolder {
  const compareOf = (path: string): string => (rules.caseInsensitive ? path.toLowerCase() : path);
  const projects = known?.projects ?? [];
  const byId = new Map(projects.map((project) => [project.id, project]));
  const roots: Root[] = [];
  const addRoot = (id: string, name: string, folder: string): void => {
    const path = normalizeFolder(folder, rules);
    if (path === '') return;
    roots.push({ key: `project:${id}`, name, compare: compareOf(path), path });
  };
  for (const project of projects) addRoot(project.id, project.name, project.folderPath);
  for (const worktree of known?.worktrees ?? []) {
    const project = byId.get(worktree.projectId);
    if (project) addRoot(project.id, project.name, worktree.path);
  }
  // Longest first, so a project nested inside another one wins the folder.
  roots.sort((a, b) => b.compare.length - a.compare.length);

  const memo = new Map<string, ResolvedFolder>();
  return (folder) => {
    if (!folder || folder.trim() === '')
      return { key: UNKNOWN_KEY, name: 'Unknown folder', path: null };
    const path = foldWorktree(normalizeFolder(folder, rules));
    const cached = memo.get(path);
    if (cached) return cached;
    const compare = compareOf(path);
    const root = roots.find(
      (candidate) =>
        compare === candidate.compare ||
        compare.startsWith(
          candidate.compare.endsWith('/') ? candidate.compare : `${candidate.compare}/`,
        ),
    );
    const resolved: ResolvedFolder = root
      ? { key: root.key, name: root.name, path: root.path }
      : { key: `folder:${compare}`, name: basenameOf(path), path };
    memo.set(path, resolved);
    return resolved;
  };
}

/** `YYYY-MM-DD` for a moment, in the local time zone. */
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The local days ending with the one that holds `now`, oldest first. Stepped at noon, so a daylight
 * saving change never skips a day or counts one twice.
 */
export function lastDayKeys(now: number, days: number): string[] {
  const anchor = new Date(now);
  anchor.setHours(12, 0, 0, 0);
  const keys: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(anchor);
    day.setDate(anchor.getDate() - back);
    keys.push(localDayKey(day.getTime()));
  }
  return keys;
}

const count = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

function countsOf(tokens: UsageTokens): UsageTokens {
  const input = count(tokens.input);
  const output = count(tokens.output);
  const cacheRead = count(tokens.cacheRead);
  const cacheWrite = count(tokens.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function addCounts(target: UsageTokens, source: UsageTokens): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

export interface ProjectDailyOptions {
  now: number;
  known?: KnownProjects;
  /** Days in the window, ending today. Defaults to 28. */
  days?: number;
  rules?: PathRules;
  /** Rows kept before the rest fold into one. Defaults to 60. */
  maxProjects?: number;
}

interface Tally {
  key: string;
  name: string;
  path: string | null;
  /** Tokens by day index, then by model, so each model is priced once per day. */
  byDay: Map<number, Map<string, UsageTokens>>;
}

const sumOf = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * Tokens and estimated cost per project per local day. Entries outside the window (or dated in the
 * future) are left out, and so are placeholder entries with no tokens.
 */
export function buildProjectDaily(
  entries: readonly UsageEntry[],
  options: ProjectDailyOptions,
): ProjectDaily {
  const days = options.days ?? SPLIT_DAYS;
  const keys = lastDayKeys(options.now, days);
  const dayIndex = new Map(keys.map((key, index) => [key, index]));
  const resolve = createProjectResolver(options.known, options.rules);
  const tallies = new Map<string, Tally>();

  for (const entry of entries) {
    const at = entry.at.getTime();
    const index = Number.isFinite(at) ? dayIndex.get(localDayKey(at)) : undefined;
    if (index === undefined) continue;
    const tokens = countsOf(entry.tokens);
    if (tokens.total === 0) continue;

    const project = resolve(entry.folder);
    let tally = tallies.get(project.key);
    if (!tally) {
      tally = { key: project.key, name: project.name, path: project.path, byDay: new Map() };
      tallies.set(project.key, tally);
    }
    const models = tally.byDay.get(index) ?? new Map<string, UsageTokens>();
    tally.byDay.set(index, models);
    const sum = models.get(entry.model) ?? emptyUsageTokens();
    addCounts(sum, tokens);
    models.set(entry.model, sum);
  }

  const rows: ProjectDailyUsage[] = [];
  for (const tally of tallies.values()) {
    const row: ProjectDailyUsage = {
      key: tally.key,
      name: tally.name,
      path: tally.path,
      tokens: new Array<number>(days).fill(0),
      costUsd: new Array<number>(days).fill(0),
      unpricedTokens: new Array<number>(days).fill(0),
    };
    for (const [index, models] of tally.byDay) {
      for (const [model, counts] of models) {
        row.tokens[index] += counts.total;
        const cost = estimateCost(model, counts);
        if (cost === null) row.unpricedTokens[index] += counts.total;
        else row.costUsd[index] += cost;
      }
    }
    rows.push(row);
  }
  rows.sort((a, b) => sumOf(b.tokens) - sumOf(a.tokens) || a.key.localeCompare(b.key));

  const max = options.maxProjects ?? MAX_SPLIT_PROJECTS;
  if (rows.length > max) {
    const folded = rows.slice(max - 1);
    const tail: ProjectDailyUsage = {
      key: TAIL_KEY,
      name: 'Other folders',
      path: null,
      tokens: new Array<number>(days).fill(0),
      costUsd: new Array<number>(days).fill(0),
      unpricedTokens: new Array<number>(days).fill(0),
    };
    for (const row of folded) {
      row.tokens.forEach((value, i) => {
        tail.tokens[i] += value;
        tail.costUsd[i] += row.costUsd[i];
        tail.unpricedTokens[i] += row.unpricedTokens[i];
      });
    }
    rows.splice(max - 1, rows.length - (max - 1), tail);
  }

  return { endDay: keys[keys.length - 1], projects: rows };
}
