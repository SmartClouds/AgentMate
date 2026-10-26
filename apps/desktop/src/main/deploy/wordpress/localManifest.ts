import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createWpIgnoreRules,
  findWpCaseCollisions,
  isWpHardDenied,
  LEGACY_IGNORE_FILE,
  LEGACY_PROJECT_DIR,
  validateWpItemPath,
  WP_AGENT_PREFIXES,
  WP_MAX_FILE_BYTES,
  WP_MAX_FILES_PER_ITEM,
  type WpFileMap,
  type WpIgnoreLayer,
  type WpIgnoreRules,
  type WpItemRef,
  wpItemRoot,
} from '@runova/core';
import type {
  DeployWordPressLeftOut,
  DeployWordPressLeftOutReason,
} from '../../../shared/deployWordPressTypes';
import { wordPressError } from '../../../shared/wordpressErrors';
import { type HashCache, hashFile } from '../hashFile';

export { hashFile };

/**
 * What a WordPress project holds on this computer, item by item (E19). Only the folder of each
 * linked item is walked (`wp-content/themes/<slug>`, `wp-content/plugins/<slug>`,
 * `wp-content/mu-plugins/<slug>`), so nothing at the project root can ever be sent. Inside it:
 * - the hard deny list (validateWpItemPath) leaves agent settings, Runova's files, version
 *   control, secrets and OS clutter out, whatever any ignore file says;
 * - the ignore layers (the item's `.distignore`, the project's `.runovaignore`, the item's
 *   `.runovaignore`) leave out what the user said, both ways;
 * - the default list leaves out build output and editor folders, unless the site or the last
 *   sync already has the file;
 * - links (symlinks, junctions) are never followed or sent, and files too large, names that are
 *   not UTF-8, and names that differ only by case are left out.
 * Every path left out is reported, so the review can say so.
 */

/** The shared size and time hash cache (hashFile.ts), keyed here by absolute path. */
export type WpHashCache = HashCache;

export interface WpLocalWalk {
  item: WpItemRef;
  isFile: boolean;
  /** False when the item's folder (or file) is not in the project. */
  exists: boolean;
  files: WpFileMap;
  leftOut: DeployWordPressLeftOut[];
  rules: WpIgnoreRules;
}

export interface WpWalkOptions {
  projectRoot: string;
  item: WpItemRef;
  isFile: boolean;
  /** Paths the site or the last sync has: the default ignore list does not apply to them. */
  tracked?: ReadonlySet<string>;
  /** The lines the user saved for this item (and for every item): left out both ways. */
  savedIgnore?: readonly string[];
  hashes?: WpHashCache;
  maxFiles?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

/** Agent settings, skills and Runova's own files, among the hard deny list. */
const AGENT_DIRS: ReadonlySet<string> = new Set([
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
]);
const AGENT_FILES: ReadonlySet<string> = new Set([
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
]);
/** A denied folder with more files than this is reported once, as `folder/`. */
const DENIED_LIST_MAX = 100;
const MAX_IGNORE_FILE_BYTES = 256 * 1024;

/** `agentFiles` for the agent and Runova entries of the hard deny list, else `hardDenied`. */
export function deniedReason(path: string): 'agentFiles' | 'hardDenied' {
  for (const segment of path.split('/')) {
    if (!isWpHardDenied(segment)) continue;
    // Folded the way the deny check folds it, so a lookalike name is classed as what it becomes.
    const name = segment.normalize('NFKC').toLowerCase();
    return AGENT_DIRS.has(name) ||
      AGENT_FILES.has(name) ||
      WP_AGENT_PREFIXES.some((prefix) => name.startsWith(prefix))
      ? 'agentFiles'
      : 'hardDenied';
  }
  return 'hardDenied';
}

function linkError(path: string): Error {
  return wordPressError(
    'pathRejected',
    `${path} is a link (a symlink or junction). Runova only syncs real folders inside the project; move the files into the project instead.`,
  );
}

/**
 * Checks each folder from the project root down to the item's root: none may be a link. Null
 * when one of them is missing; otherwise whether the item root is a file or a folder.
 */
export async function itemRootKind(
  projectRoot: string,
  item: WpItemRef,
): Promise<'file' | 'folder' | 'other' | null> {
  const segments = wpItemRoot(item).split('/');
  let current = projectRoot;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!info) return null;
    if (info.isSymbolicLink()) linkErrorThrow(segments.slice(0, index + 1).join('/'));
    const last = index === segments.length - 1;
    if (!last && !info.isDirectory()) return null;
    if (last) return info.isDirectory() ? 'folder' : info.isFile() ? 'file' : 'other';
  }
  return null;
}

function linkErrorThrow(path: string): never {
  throw linkError(path);
}

async function readTextFile(path: string): Promise<string | null> {
  const info = await lstat(path).catch(() => null);
  // A linked or oversized ignore file is not read: rules come only from files in the project.
  if (!info?.isFile() || info.size > MAX_IGNORE_FILE_BYTES) return null;
  return readFile(path, 'utf-8');
}

async function readIgnoreFile(
  path: string,
  source: string,
  negations: boolean,
): Promise<WpIgnoreLayer | null> {
  const text = await readTextFile(path);
  return text === null ? null : { source, text, negations };
}

/**
 * A folder's `.runovaignore`, or its `.agentmateignore` from before the rename when that is the
 * only one there. The new name wins when both exist.
 */
async function readOwnIgnoreFile(folder: string, label: string): Promise<WpIgnoreLayer | null> {
  return (
    (await readIgnoreFile(join(folder, '.runovaignore'), `${label}.runovaignore`, true)) ??
    (await readIgnoreFile(join(folder, LEGACY_IGNORE_FILE), `${label}${LEGACY_IGNORE_FILE}`, true))
  );
}

/**
 * The item's ignore layers, in order: its .distignore, the project's and its .runovaignore,
 * then the list the user saved for the project. What git ignores (the project's and the item's
 * .gitignore) counts like the default list: left out until the site has it.
 */
export async function itemIgnoreRules(
  projectRoot: string,
  item: WpItemRef,
  isFile: boolean,
  savedIgnore: readonly string[] = [],
): Promise<WpIgnoreRules> {
  const itemRoot = wpItemRoot(item);
  const root = join(projectRoot, itemRoot);
  // An item's .distignore comes from the site with the theme or plugin, so its `!` lines are
  // dropped: a site can only leave more out, never put a default-ignored file back in a deploy.
  const layers = [
    isFile
      ? null
      : await readIgnoreFile(join(root, '.distignore'), `${itemRoot}/.distignore`, false),
    await readOwnIgnoreFile(projectRoot, ''),
    isFile ? null : await readOwnIgnoreFile(root, `${itemRoot}/`),
    savedIgnore.length > 0
      ? { source: 'the saved ignore list', text: savedIgnore.join('\n'), negations: true }
      : null,
  ].filter((layer): layer is WpIgnoreLayer => layer !== null);
  // A single-file plugin has no folder of its own, so only the project's .gitignore could apply,
  // and a file is not worth a rule set of its own.
  const git = isFile
    ? undefined
    : {
        itemRoot,
        item: (await readTextFile(join(root, '.gitignore'))) ?? undefined,
        project: (await readTextFile(join(projectRoot, '.gitignore'))) ?? undefined,
      };
  const compiled = createWpIgnoreRules(layers, git);
  if (!compiled.ok) {
    throw wordPressError(
      'badRequest',
      `Line ${compiled.line} of ${compiled.source} cannot be read: ${compiled.reason}. Fix it and try again.`,
    );
  }
  return compiled.rules;
}

/** Up to DENIED_LIST_MAX files under a denied folder, or the folder itself when there are more. */
async function deniedEntries(
  absolute: string,
  path: string,
  item: WpItemRef,
  reason: DeployWordPressLeftOutReason,
): Promise<DeployWordPressLeftOut[]> {
  const found: string[] = [];
  const visit = async (folder: string, prefix: string): Promise<boolean> => {
    const children = await readdir(folder, { withFileTypes: true }).catch(() => [] as Dirent[]);
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const childPath = `${prefix}/${child.name}`;
      if (child.isDirectory() && !child.isSymbolicLink()) {
        if (!(await visit(join(folder, child.name), childPath))) return false;
      } else {
        found.push(childPath);
        if (found.length > DENIED_LIST_MAX) return false;
      }
    }
    return true;
  };
  const complete = await visit(absolute, path);
  if (!complete || found.length === 0) return [{ item, path: `${path}/`, reason }];
  return found.map((entry) => ({ item, path: entry, reason }));
}

export async function walkLocalItem(options: WpWalkOptions): Promise<WpLocalWalk> {
  const { projectRoot, item, isFile } = options;
  const tracked = options.tracked ?? new Set<string>();
  const maxFiles = options.maxFiles ?? WP_MAX_FILES_PER_ITEM;
  const maxFileBytes = options.maxFileBytes ?? WP_MAX_FILE_BYTES;
  const rules = await itemIgnoreRules(projectRoot, item, isFile, options.savedIgnore);
  const walk: WpLocalWalk = { item, isFile, exists: false, files: {}, leftOut: [], rules };
  const kind = await itemRootKind(projectRoot, item);
  const root = join(projectRoot, wpItemRoot(item));
  const leaveOut = (path: string, reason: DeployWordPressLeftOutReason) =>
    walk.leftOut.push({ item, path, reason });

  if (isFile) {
    if (kind !== 'file') return walk;
    walk.exists = true;
    const info = await lstat(root);
    if (rules.excluded(item.slug)) leaveOut(item.slug, 'ignored');
    else if (info.size > maxFileBytes) leaveOut(item.slug, 'tooLarge');
    else {
      walk.files[item.slug] = {
        size: info.size,
        sha256: await hashFile(root, info.size, info.mtimeMs, options.hashes),
      };
    }
    return walk;
  }
  if (kind !== 'folder') return walk;
  walk.exists = true;

  const trackedFolders = new Set<string>();
  for (const path of tracked) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      trackedFolders.add(parts.slice(0, index).join('/'));
    }
  }
  let count = 0;

  const visit = async (folder: string, prefix: string): Promise<void> => {
    if (options.signal?.aborted) throw options.signal.reason;
    const children = await readdir(folder, { withFileTypes: true });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = join(folder, child.name);
      const isFolder = child.isDirectory() && !child.isSymbolicLink();
      if (child.name.includes('\ufffd')) {
        leaveOut(isFolder ? `${path}/` : path, 'notUtf8');
        continue;
      }
      const check = validateWpItemPath(path);
      if (!check.ok) {
        if (check.reason === 'hardDenied') {
          const reason = deniedReason(path);
          if (isFolder) walk.leftOut.push(...(await deniedEntries(absolute, path, item, reason)));
          else leaveOut(path, reason);
        } else {
          leaveOut(isFolder ? `${path}/` : path, 'pathRejected');
        }
        continue;
      }
      if (child.isSymbolicLink()) {
        leaveOut(path, 'symlink');
        continue;
      }
      if (isFolder) {
        const userExcluded = rules.excluded(path);
        const defaultExcluded = !userExcluded && rules.excludedUnlessTracked(path);
        if (
          (userExcluded || (defaultExcluded && !trackedFolders.has(path))) &&
          rules.canSkipFolder(path)
        ) {
          leaveOut(`${path}/`, 'ignored');
          continue;
        }
        await visit(absolute, path);
        continue;
      }
      if (!child.isFile()) {
        leaveOut(path, 'pathRejected');
        continue;
      }
      if (rules.excluded(path) || (rules.excludedUnlessTracked(path) && !tracked.has(path))) {
        leaveOut(path, 'ignored');
        continue;
      }
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        leaveOut(path, 'symlink');
        continue;
      }
      if (info.size > maxFileBytes) {
        leaveOut(path, 'tooLarge');
        continue;
      }
      count += 1;
      if (count > maxFiles) {
        throw wordPressError(
          'tooLarge',
          `${wpItemRoot(item)} holds more than ${maxFiles} files, more than Runova syncs for one item. Leave folders the site does not need out with .runovaignore.`,
        );
      }
      walk.files[path] = {
        size: info.size,
        sha256: await hashFile(absolute, info.size, info.mtimeMs, options.hashes),
      };
    }
  };
  await visit(root, '');

  for (const group of findWpCaseCollisions(Object.keys(walk.files))) {
    for (const path of group) {
      delete walk.files[path];
      leaveOut(path, 'caseCollision');
    }
  }
  return walk;
}
