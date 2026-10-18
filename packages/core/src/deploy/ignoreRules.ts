import { type DockerignoreMatcher, parseDockerignore } from './dockerignore.js';

/**
 * Ignore rules for a folder that is synced with a server (WordPress items in E19, FTP and SFTP
 * sites in E23), written in gitignore-like syntax and matched with the dockerignore matcher.
 *
 * Two kinds of layers meet here:
 * - the defaults each feature passes in: files that never belong on a server unless the server
 *   already has them (build output, editor folders, logs made on this computer);
 * - the user's own layers (an `.agentmateignore`, a site's own patterns), which leave things out
 *   both ways and can put a default back with a `!` line.
 *
 * Every path is relative to the synced folder's root, with `/` separators.
 */

/**
 * Turns one gitignore-like line into dockerignore syntax: a pattern with no slash before its end
 * matches at any depth (so `*.log` also catches `logs/debug.log`), a leading slash anchors it to
 * the root, and a trailing slash is dropped (dockerignore has no folders-only form). Blank lines and
 * comments become blank lines, so line numbers in errors stay the user's.
 */
function toDockerignoreLine(raw: string, negations: boolean): string {
  const line = raw.replace(/\r$/, '').trim();
  if (line === '' || line.startsWith('#')) return '';
  const exception = line.startsWith('!');
  if (exception && !negations) return '';
  let pattern = exception ? line.slice(1).trim() : line;
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.replace(/^\/+/, '');
  pattern = pattern.replace(/\/+$/, '');
  if (pattern === '') return '';
  if (!anchored && !pattern.includes('/')) pattern = `**/${pattern}`;
  return `${exception ? '!' : ''}${pattern}`;
}

export interface IgnoreLayer {
  /** Where the text came from, for error messages: `default`, `.distignore`, `.agentmateignore`. */
  source: string;
  text: string;
  /**
   * Whether `!` lines count. False for a file that can come from the server (a WordPress item's
   * `.distignore` is pulled with the theme or plugin), so the server can only leave more out,
   * never put a default-ignored local file back into a deploy. Defaults to true.
   */
  negations?: boolean;
}

export interface IgnoreRules {
  /** Left out both ways, whatever the server has: the user's own layers. */
  excluded(path: string): boolean;
  /**
   * Left out only while neither the server nor the last sync has the file: the defaults, with
   * the user's layers able to put things back with `!`.
   */
  excludedUnlessTracked(path: string): boolean;
  /** For a walker: true when nothing inside this folder can be put back by a `!` line. */
  canSkipFolder(path: string): boolean;
}

export type IgnoreRulesResult =
  | { ok: true; rules: IgnoreRules }
  | { ok: false; source: string; line: number; reason: string };

function compileLayers(
  layers: readonly IgnoreLayer[],
):
  | { ok: true; matcher: DockerignoreMatcher }
  | { ok: false; source: string; line: number; reason: string } {
  const lines: string[] = [];
  for (const layer of layers) {
    const negations = layer.negations !== false;
    const converted = layer.text.split('\n').map((line) => toDockerignoreLine(line, negations));
    const parsed = parseDockerignore(converted.join('\n'));
    if (!parsed.ok)
      return { ok: false, source: layer.source, line: parsed.line, reason: parsed.reason };
    lines.push(...converted);
  }
  const parsed = parseDockerignore(lines.join('\n'));
  // Every layer parsed on its own, so the joined text cannot fail; kept as a guard.
  if (!parsed.ok)
    return { ok: false, source: 'combined', line: parsed.line, reason: parsed.reason };
  return { ok: true, matcher: parsed.matcher };
}

/**
 * Builds the ignore rules from the user's layers, in order, on top of the given defaults (a layer
 * named `default`). The last matching line wins, so a later layer can override an earlier one.
 */
export function createIgnoreRules(
  userLayers: readonly IgnoreLayer[],
  defaults: readonly string[],
): IgnoreRulesResult {
  const user = compileLayers(userLayers);
  if (!user.ok) return user;
  const combined = compileLayers([{ source: 'default', text: defaults.join('\n') }, ...userLayers]);
  if (!combined.ok) return combined;
  const userMatcher = user.matcher;
  const combinedMatcher = combined.matcher;
  return {
    ok: true,
    rules: {
      excluded: (path) => userMatcher.excludes(path),
      excludedUnlessTracked: (path) => combinedMatcher.excludes(path),
      canSkipFolder: (path) =>
        combinedMatcher.excludes(path) && combinedMatcher.canSkipFolder(path),
    },
  };
}
