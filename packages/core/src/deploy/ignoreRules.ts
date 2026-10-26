import { type DockerignoreMatcher, parseDockerignore } from './dockerignore.js';

/**
 * Ignore rules for a folder that is synced with a server (WordPress items in E19, FTP and SFTP
 * sites in E23), written in gitignore-like syntax and matched with the dockerignore matcher.
 *
 * Two kinds of layers meet here:
 * - the defaults each feature passes in: files that never belong on a server unless the server
 *   already has them (build output, editor folders, logs made on this computer);
 * - the user's own layers (a `.runovaignore`, a site's own patterns), which leave things out
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
  /** Where the text came from, for error messages: `default`, `.distignore`, `.runovaignore`. */
  source: string;
  text: string;
  /**
   * Whether `!` lines count. False for a file that can come from the server (a WordPress item's
   * `.distignore` is pulled with the theme or plugin), so the server can only leave more out,
   * never put a default-ignored local file back into a deploy. Defaults to true.
   */
  negations?: boolean;
  /**
   * Skips a line that cannot be read instead of failing the whole set. For files the user keeps
   * for another tool, like a `.gitignore`, whose odd line should never stop a deploy.
   */
  lenient?: boolean;
  /**
   * `ancestor`: the lines were written for a folder above the synced one (the project's
   * `.gitignore`), so they match paths from there down. Only meaningful in `defaultLayers`.
   * Defaults to `folder`: the lines are relative to the synced folder.
   */
  scope?: 'folder' | 'ancestor';
}

export interface IgnoreRulesOptions {
  /**
   * Default layers read from files (a `.gitignore`). They leave paths out only until the server
   * has them, like `defaults`, but come before them, so a `!` line in one can never put a
   * built-in default back; the user's own layers still can.
   */
  defaultLayers?: readonly IgnoreLayer[];
  /**
   * The synced folder's path inside the folder its `ancestor` layers were written for, with `/`
   * separators (`wp-content/themes/foo`). Without it those layers are left out, and one that
   * ignores the synced folder itself is left out too: the user chose to sync that folder.
   */
  ancestorPath?: string;
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

type Compiled =
  | { ok: true; matcher: DockerignoreMatcher }
  | { ok: false; source: string; line: number; reason: string };

/** A converted line with the synced folder's path in front, for a matcher that starts above it. */
function rebase(line: string, base: string): string {
  if (line === '') return line;
  return line.startsWith('!') ? `!${base}/${line.slice(1)}` : `${base}/${line}`;
}

function compileLayers(layers: readonly IgnoreLayer[], base?: string): Compiled {
  const lines: string[] = [];
  for (const layer of layers) {
    const negations = layer.negations !== false;
    let converted = layer.text.split('\n').map((line) => toDockerignoreLine(line, negations));
    if (layer.lenient) {
      converted = converted.map((line) => (line === '' || parseDockerignore(line).ok ? line : ''));
    }
    const parsed = parseDockerignore(converted.join('\n'));
    if (!parsed.ok)
      return { ok: false, source: layer.source, line: parsed.line, reason: parsed.reason };
    const moved = base !== undefined && layer.scope !== 'ancestor';
    lines.push(...(moved ? converted.map((line) => rebase(line, base)) : converted));
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
 * Layers read from files can be added as `options.defaultLayers`, ahead of the defaults.
 */
export function createIgnoreRules(
  userLayers: readonly IgnoreLayer[],
  defaults: readonly string[],
  options: IgnoreRulesOptions = {},
): IgnoreRulesResult {
  const user = compileLayers(userLayers);
  if (!user.ok) return user;

  const { ancestorPath } = options;
  const fileLayers: IgnoreLayer[] = [];
  let moved = false;
  for (const layer of options.defaultLayers ?? []) {
    if (layer.scope === 'ancestor') {
      if (ancestorPath === undefined) continue;
      const alone = compileLayers([layer]);
      if (!alone.ok) return alone;
      if (alone.matcher.excludes(ancestorPath)) continue;
      moved = true;
    }
    fileLayers.push(layer);
  }
  const base = moved ? ancestorPath : undefined;

  const combined = compileLayers(
    [...fileLayers, { source: 'default', text: defaults.join('\n') }, ...userLayers],
    base,
  );
  if (!combined.ok) return combined;
  const userMatcher = user.matcher;
  const combinedMatcher = combined.matcher;
  const inCombined = (path: string): string => (base === undefined ? path : `${base}/${path}`);
  return {
    ok: true,
    rules: {
      excluded: (path) => userMatcher.excludes(path),
      excludedUnlessTracked: (path) => combinedMatcher.excludes(inCombined(path)),
      canSkipFolder: (path) =>
        combinedMatcher.excludes(inCombined(path)) &&
        combinedMatcher.canSkipFolder(inCombined(path)),
    },
  };
}
