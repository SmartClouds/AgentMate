import { LEGACY_IGNORE_FILE, LEGACY_PROJECT_DIR } from '../../legacyNames.js';
import type { ProjectWordPressItemKind } from '../../types/index.js';
import {
  createIgnoreRules,
  type IgnoreLayer,
  type IgnoreRules,
  type IgnoreRulesResult,
} from '../ignoreRules.js';
import {
  WP_MAX_PATH_BYTES,
  WP_MAX_SEGMENT_BYTES,
  type WpItemRef,
  type WpPathRejectReason,
} from './protocol.js';

/**
 * Which paths inside a theme, plugin or mu-plugin may travel between this computer and a site
 * (E19), the same on both sides: the desktop never sends or writes anything this refuses, and the
 * plugin refuses it again on its own. The order of the checks in validateWpItemPath is part of the
 * contract, since the shared vectors pin the reason for every case.
 *
 * Three layers keep agent and Runova files on this computer:
 * 1. Only the folders of linked items are walked, so anything at the project root (`.claude/`,
 *    `AGENTS.md`, `.runova/`) is never even looked at.
 * 2. The hard deny list below, matched against every path segment, without exceptions.
 * 3. Ignore rules (see createWpIgnoreRules): a default list for files that never belong on a site
 *    unless the site already has them, plus the user's own `.distignore` and `.runovaignore`.
 */

/** Folders that hold agent settings, skills, Runova's own files, or version control. */
export const WP_HARD_DENY_DIRS: readonly string[] = [
  '.runova',
  // The same folder in projects made before the rename.
  LEGACY_PROJECT_DIR,
  // KNOWN_AGENT_DIRS in skills/installPaths.ts, and a few more assistants' folders.
  '.claude',
  '.agents',
  '.codex',
  '.cursor',
  '.windsurf',
  '.continue',
  '.factory',
  '.gemini',
  '.opencode',
  '.roo',
  '.kiro',
  '.amazonq',
  '.junie',
  '.clinerules',
  '.github',
  '.git',
  '.svn',
  '.hg',
  '.worktrees',
];

/** Files by exact name: agent instructions, MCP config, secrets, PHP config, OS clutter. */
export const WP_HARD_DENY_FILES: readonly string[] = [
  'agents.md',
  'claude.md',
  'claude.local.md',
  'gemini.md',
  '.mcp.json',
  'opencode.json',
  '.cursorrules',
  '.windsurfrules',
  '.roomodes',
  '.runovaignore',
  LEGACY_IGNORE_FILE,
  '.env',
  '.envrc',
  // Package manager and network credentials.
  '.npmrc',
  'auth.json',
  '.netrc',
  '.git-credentials',
  '.user.ini',
  'php.ini',
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
];

/**
 * Name prefixes of an agent's or Runova's own files: Aider's, and any dot folder or file that
 * starts with `.claude` or `.runova` (`.claude-plugin/`, `.runova-cache/`), so a name an
 * agent or Runova invents later is kept here too.
 */
export const WP_AGENT_PREFIXES: readonly string[] = [
  '.aider',
  '.claude',
  '.runova',
  LEGACY_PROJECT_DIR,
];

/** Name prefixes: the agent ones above, `.env.local` and friends, SSH private keys. */
export const WP_HARD_DENY_PREFIXES: readonly string[] = [
  ...WP_AGENT_PREFIXES,
  '.env.',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
];

/** Name suffixes: private keys and certificates. */
export const WP_HARD_DENY_SUFFIXES: readonly string[] = ['.pem', '.ppk'];

const DENY_NAMES: ReadonlySet<string> = new Set([...WP_HARD_DENY_DIRS, ...WP_HARD_DENY_FILES]);

/**
 * Left out by default, in gitignore-like syntax, but only while the site does not have them:
 * build output, editor folders and logs made on this computer stay here, while a plugin that
 * really ships a `skills/` or `node_modules/` folder is still pulled and kept in step. A `!` line
 * in an `.runovaignore` puts any of these back.
 */
export const WP_DEFAULT_IGNORE: readonly string[] = [
  'node_modules/',
  '.vscode/',
  '.idea/',
  '.cache/',
  '.sass-cache/',
  '.phpunit.cache/',
  '*.log',
  '*.swp',
  '*~',
  '*.orig',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.distignore',
  '.nvmrc',
  '.phpunit.result.cache',
  '/skills/',
  '/agents/',
];

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function segmentDenied(segment: string): boolean {
  // NFKC first, so lookalikes a case-insensitive disk may fold together (the long s in `.curſor`)
  // are judged as the name they become.
  const name = segment.normalize('NFKC').toLowerCase();
  if (DENY_NAMES.has(name)) return true;
  if (WP_HARD_DENY_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return WP_HARD_DENY_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** True when any segment of the path is on the hard deny list (case-insensitive). */
export function isWpHardDenied(path: string): boolean {
  return path.split('/').some(segmentDenied);
}

/**
 * Checks a path relative to an item root. In order: empty, tooLong, controlChar, backslash,
 * absolute, driveLetter, colon; then for each segment from the left: emptySegment, traversal,
 * segmentTooLong, trailingDotOrSpace, reservedName; and last, hardDenied.
 */
export function validateWpItemPath(
  path: string,
): { ok: true } | { ok: false; reason: WpPathRejectReason } {
  if (path.length === 0) return { ok: false, reason: 'empty' };
  if (utf8Length(path) > WP_MAX_PATH_BYTES) return { ok: false, reason: 'tooLong' };
  if (CONTROL.test(path)) return { ok: false, reason: 'controlChar' };
  if (path.includes('\\')) return { ok: false, reason: 'backslash' };
  if (path.startsWith('/')) return { ok: false, reason: 'absolute' };
  if (/^[A-Za-z]:/.test(path)) return { ok: false, reason: 'driveLetter' };
  if (path.includes(':')) return { ok: false, reason: 'colon' };
  for (const segment of path.split('/')) {
    if (segment.length === 0) return { ok: false, reason: 'emptySegment' };
    if (segment === '.' || segment === '..') return { ok: false, reason: 'traversal' };
    if (utf8Length(segment) > WP_MAX_SEGMENT_BYTES) return { ok: false, reason: 'segmentTooLong' };
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return { ok: false, reason: 'trailingDotOrSpace' };
    }
    const base = segment.split('.')[0].toLowerCase();
    if (RESERVED.test(base)) return { ok: false, reason: 'reservedName' };
  }
  if (isWpHardDenied(path)) return { ok: false, reason: 'hardDenied' };
  return { ok: true };
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A theme, plugin or mu-plugin name: a folder name, or for a single-file plugin or mu-plugin
 * its `.php` file name. Never a path, never on the deny list, never reserved on Windows.
 */
export function isValidWpSlug(slug: string): boolean {
  if (!SLUG.test(slug)) return false;
  return validateWpItemPath(slug).ok;
}

/** A single-file item's slug is its file name, which always ends in `.php`. */
export function isWpFileItemSlug(slug: string): boolean {
  return isValidWpSlug(slug) && slug.toLowerCase().endsWith('.php');
}

const ROOTS: Record<ProjectWordPressItemKind, string> = {
  theme: 'wp-content/themes',
  plugin: 'wp-content/plugins',
  'mu-plugin': 'wp-content/mu-plugins',
};

/** The item's root inside a project folder, `/`-separated: `wp-content/themes/<slug>`. */
export function wpItemRoot(item: WpItemRef): string {
  return `${ROOTS[item.kind]}/${item.slug}`;
}

/**
 * Where a file of an item lives inside the project folder. A single-file item has one path,
 * its slug, which maps to `wp-content/plugins/<slug>`.
 */
export function wpMirrorPath(item: WpItemRef, isFile: boolean, path: string): string {
  if (isFile) {
    if (path !== item.slug) throw new Error('A single-file item has only one path: its own name.');
    return wpItemRoot(item);
  }
  return `${wpItemRoot(item)}/${path}`;
}

/** A stable key for an item: `theme:twentytwentyfive`. */
export function wpItemKey(item: WpItemRef): string {
  return `${item.kind}:${item.slug}`;
}

/** Groups of paths that are the same file on a case-insensitive disk (Windows, macOS). */
export function findWpCaseCollisions(paths: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(path);
    else groups.set(key, [path]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/** The ignore layer and rules of E19, the shared ones in ignoreRules.ts. */
export type WpIgnoreLayer = IgnoreLayer;
export type WpIgnoreRules = IgnoreRules;

/** The text of the `.gitignore` files that apply to one item. */
export interface WpGitignores {
  /** The item's root in the project folder: `wp-content/themes/<slug>`. */
  itemRoot: string;
  /** The item folder's own `.gitignore`, which matches paths from the item root down. */
  item?: string;
  /** The project folder's `.gitignore`, which matches paths from the project root down. */
  project?: string;
}

/**
 * Builds the ignore rules for one item from its layers, in order: the user's `.distignore` (from
 * the item root), then `.runovaignore` from the project root, then `.runovaignore` from the
 * item root. All of them match paths relative to the item root. The last matching line wins.
 *
 * What git ignores is left out by default too: the project's and the item's `.gitignore` count
 * like the default list, so they leave a file out only until the site has it, a line that cannot
 * be read is skipped, and a `!` line in one can never put a built-in default back. The user's
 * layers still can. A project `.gitignore` that ignores the item's whole folder is not used.
 */
export function createWpIgnoreRules(
  userLayers: readonly WpIgnoreLayer[],
  git?: WpGitignores,
): IgnoreRulesResult {
  const defaultLayers: IgnoreLayer[] = [];
  if (git?.project !== undefined) {
    defaultLayers.push({
      source: '.gitignore',
      text: git.project,
      lenient: true,
      scope: 'ancestor',
    });
  }
  if (git?.item !== undefined) {
    defaultLayers.push({
      source: `${git.itemRoot}/.gitignore`,
      text: git.item,
      lenient: true,
    });
  }
  return createIgnoreRules(userLayers, WP_DEFAULT_IGNORE, {
    defaultLayers,
    ...(git ? { ancestorPath: git.itemRoot } : {}),
  });
}
