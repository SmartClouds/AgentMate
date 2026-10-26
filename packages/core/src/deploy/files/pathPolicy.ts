import { LEGACY_IGNORE_FILE, LEGACY_PROJECT_DIR } from '../../legacyNames.js';
import { createIgnoreRules, type IgnoreLayer, type IgnoreRulesResult } from '../ignoreRules.js';
import {
  validateWpItemPath,
  WP_AGENT_PREFIXES,
  WP_DEFAULT_IGNORE,
  WP_HARD_DENY_DIRS,
  WP_HARD_DENY_FILES,
  WP_HARD_DENY_PREFIXES,
  WP_HARD_DENY_SUFFIXES,
} from '../wordpress/pathPolicy.js';
import type { WpPathRejectReason } from '../wordpress/protocol.js';

/**
 * Which paths inside an FTP or SFTP site's deploy folder may be sent to the server (E23). The
 * rules are the WordPress ones (E19, see wordpress/pathPolicy.ts), so both features keep agent
 * files, secrets and version control on this computer the same way:
 * 1. The same path checks, in the same order, as validateWpItemPath.
 * 2. The same hard deny list, matched against every segment, without exceptions, except that
 *    `php.ini` and `.user.ini` are allowed: a plain site on a shared host is often configured
 *    through them, while a WordPress theme or plugin never carries one.
 * 3. Ignore rules (see createFileSiteIgnoreRules): the WordPress default list without
 *    `.distignore` (a WordPress packaging file, plain data on any other site), plus the folder's
 *    `.runovaignore` and the site's own patterns.
 *
 * The lists are imported from the WordPress module and filtered here, so a name added there is
 * denied here too.
 */

export type SyncPathRejectReason = WpPathRejectReason;

/** Names a shared host reads its PHP settings from. Allowed on a file site. */
const HOST_CONFIG_FILES: ReadonlySet<string> = new Set(['php.ini', '.user.ini']);

/** The WordPress deny list by exact file name, without the host config files. */
export const FILE_SITE_HARD_DENY_FILES: readonly string[] = WP_HARD_DENY_FILES.filter(
  (name) => !HOST_CONFIG_FILES.has(name),
);

const DENY_NAMES: ReadonlySet<string> = new Set([
  ...WP_HARD_DENY_DIRS,
  ...FILE_SITE_HARD_DENY_FILES,
]);

/**
 * Agent settings, skills and Runova's own files among the deny list, so a walker can tell the
 * user these were left out on purpose. The same split as `deniedReason` in the desktop's
 * WordPress walker (localManifest.ts).
 */
export const FILE_SITE_AGENT_DIRS: readonly string[] = [
  '.runova',
  LEGACY_PROJECT_DIR,
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
];

export const FILE_SITE_AGENT_FILES: readonly string[] = [
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
];

const AGENT_NAMES: ReadonlySet<string> = new Set([
  ...FILE_SITE_AGENT_DIRS,
  ...FILE_SITE_AGENT_FILES,
]);

/** NFKC first, so lookalikes a case-insensitive disk may fold together are judged as what they become. */
function fold(segment: string): string {
  return segment.normalize('NFKC').toLowerCase();
}

function segmentDenied(segment: string): boolean {
  const name = fold(segment);
  if (DENY_NAMES.has(name)) return true;
  if (WP_HARD_DENY_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return WP_HARD_DENY_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** True when any segment of the path (or the one segment given) is on the file-site deny list. */
export function isFileSiteHardDenied(path: string): boolean {
  return path.split('/').some(segmentDenied);
}

/**
 * Checks a path relative to the site root, with the checks and reasons of validateWpItemPath:
 * empty, tooLong, controlChar, backslash, absolute, driveLetter, colon; then for each segment
 * emptySegment, traversal, segmentTooLong, trailingDotOrSpace, reservedName; and last,
 * hardDenied against the file-site list.
 *
 * It asks the WordPress check first. Since hardDenied is that check's last step, a `hardDenied`
 * answer means every shape check passed, and only the deny list is judged again here.
 */
export function validateSyncPath(
  path: string,
): { ok: true } | { ok: false; reason: SyncPathRejectReason } {
  const checked = validateWpItemPath(path);
  if (checked.ok || checked.reason !== 'hardDenied') return checked;
  return isFileSiteHardDenied(path) ? checked : { ok: true };
}

/** `agentFiles` for the agent and Runova entries of the deny list, else `hardDenied`. */
export function deniedReasonForSync(path: string): 'agentFiles' | 'hardDenied' {
  for (const segment of path.split('/')) {
    if (!segmentDenied(segment)) continue;
    const name = fold(segment);
    return AGENT_NAMES.has(name) || WP_AGENT_PREFIXES.some((prefix) => name.startsWith(prefix))
      ? 'agentFiles'
      : 'hardDenied';
  }
  return 'hardDenied';
}

/**
 * Left out by default, until the server has them: the WordPress list without `.distignore`.
 * A `!` line in a `.runovaignore` or the site's patterns puts any of these back.
 */
export const FILE_DEFAULT_IGNORE: readonly string[] = WP_DEFAULT_IGNORE.filter(
  (line) => line !== '.distignore',
);

/**
 * The ignore rules for one site, from its layers in order: the deploy folder's
 * `.runovaignore`, then the site's own patterns. They match paths relative to the site root.
 */
export function createFileSiteIgnoreRules(layers: readonly IgnoreLayer[]): IgnoreRulesResult {
  return createIgnoreRules(layers, FILE_DEFAULT_IGNORE);
}

/** The folder a path sits in, relative to the site root: `''` for a file at the root. */
export function syncPathFolder(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
