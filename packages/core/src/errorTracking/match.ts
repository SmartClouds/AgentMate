import type { LinkCandidateProject, RemoteProject } from './types.js';

/**
 * Which provider projects belong to an AgentMate project, guessed from names. A project called
 * "Storefront" in a folder `storefront` usually reports to `storefront-web` and `storefront-api`,
 * so the words that only say what kind of app it is (web, api, worker) are left out of the main
 * score and only break ties: with the folder `storefront-api`, that one comes first.
 */

/** Words that say what kind of app something is, not which one. */
const GENERIC_WORDS = new Set([
  'app',
  'apps',
  'web',
  'www',
  'site',
  'api',
  'server',
  'client',
  'frontend',
  'backend',
  'service',
  'services',
  'svc',
  'ui',
  'worker',
  'mobile',
]);

/** A suggestion needs at least this score: half its distinctive words in common. */
const THRESHOLD = 0.5;
/** One compact name holding another, as `storefront2` holds `storefront`. */
const CONTAINS_SCORE = 0.6;
const MIN_CONTAINED = 4;

interface Name {
  /** Every word. */
  all: string[];
  /** The distinctive words, or every word when there are no distinctive ones. */
  core: string[];
}

function nameOf(text: string): Name {
  const all = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const core = all.filter((word) => !GENERIC_WORDS.has(word));
  return { all, core: core.length > 0 ? core : all };
}

/** The last path segment, for both `E:\code\shop` and `/home/me/shop/`. */
function lastSegment(path: string): string {
  return (
    path
      .split(/[\\/:]+/)
      .filter(Boolean)
      .at(-1) ?? ''
  );
}

/** The repository's name from `https://host/org/name.git` or `git@host:org/name.git`. */
function repoName(url: string): string {
  return lastSegment(url).replace(/\.git$/i, '');
}

/** Shared words over the longer name's words. */
function overlap(a: readonly string[], b: readonly string[]): number {
  const shared = a.filter((word) => b.includes(word)).length;
  return shared / Math.max(a.length, b.length);
}

/** How well two names match on their distinctive words, 0 to 1. */
function primaryScore(source: Name, target: Name): number {
  const sourceCompact = source.core.join('');
  const targetCompact = target.core.join('');
  if (sourceCompact === targetCompact || source.all.join('') === target.all.join('')) return 1;
  const [shorter, longer] =
    sourceCompact.length <= targetCompact.length
      ? [sourceCompact, targetCompact]
      : [targetCompact, sourceCompact];
  const contains = shorter.length >= MIN_CONTAINED && longer.includes(shorter) ? CONTAINS_SCORE : 0;
  return Math.max(overlap(source.core, target.core), contains);
}

/** The provider projects that look like this project, best first. Empty when nothing fits. */
export function suggestRemoteProjects(
  project: LinkCandidateProject,
  remote: readonly RemoteProject[],
): RemoteProject[] {
  const sources = [
    project.name,
    project.folderPath ? lastSegment(project.folderPath) : '',
    project.repoUrl ? repoName(project.repoUrl) : '',
  ]
    .map(nameOf)
    .filter((name) => name.all.length > 0);

  const scored = remote.map((candidate) => {
    const targets = [nameOf(candidate.slug), nameOf(candidate.name)];
    let primary = 0;
    let tie = 0;
    for (const source of sources) {
      for (const target of targets) {
        primary = Math.max(primary, primaryScore(source, target));
        tie = Math.max(tie, overlap(source.all, target.all));
      }
    }
    return { candidate, primary, tie };
  });

  return scored
    .filter((entry) => entry.primary >= THRESHOLD)
    .sort((a, b) => b.primary - a.primary || b.tie - a.tie)
    .map((entry) => entry.candidate);
}
