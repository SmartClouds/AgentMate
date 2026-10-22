import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isValidWpSlug,
  isWpFileItemSlug,
  normalizeProjectWordPressLink,
  normalizeWpIgnore,
  type Project,
  type ProjectWordPressLink,
  type WpItemRef,
  wpItemKey,
  wpItemRoot,
} from '@agentmat/core';
import type { CreateProjectInput } from '../../../shared/apiTypes';
import type { DeployWordPressLocalItem } from '../../../shared/deployWordPressTypes';
import { wordPressError } from '../../../shared/wordpressErrors';
import { itemRootKind } from './localManifest';

/**
 * A project's link to a WordPress site (E21), as the main process uses it: which site, which
 * items, and where each item's folder sits. Projects themselves are kept by the Projects store;
 * this only reads them and changes their link through the port the wiring hands in.
 */

export interface WpProjectsPort {
  get(projectId: string): Promise<Project | null>;
  /** projects.ts createProjectRecord: the only way a project is made with a link. */
  create(input: CreateProjectInput): Promise<Project>;
  /**
   * projects.ts setProjectWordPressLink; undefined removes the link. `changes` updates the prompt
   * and website along with it, for a project that turns into a WordPress project or back.
   */
  setLink(
    projectId: string,
    link: ProjectWordPressLink | undefined,
    changes?: WpProjectLinkChanges,
  ): Promise<Project>;
}

export interface WpProjectLinkChanges {
  prompt?: string;
  websiteUrl?: string;
}

export interface WpLinkedProject {
  project: Project;
  link: ProjectWordPressLink;
}

export async function requireLinkedProject(
  projects: WpProjectsPort,
  projectId: string,
): Promise<WpLinkedProject> {
  const project = await projects.get(projectId);
  if (!project) {
    throw wordPressError('projectNotLinked', 'That project no longer exists.');
  }
  const link = normalizeProjectWordPressLink(project.wordpress);
  if (!link) {
    throw wordPressError(
      'projectNotLinked',
      'This project is not linked to a WordPress site. Link it from the WordPress section first.',
    );
  }
  return { project, link };
}

/** The items asked for, which must all be linked; every linked item when none are named. */
export function selectItems(link: ProjectWordPressLink, requested?: readonly WpItemRef[]) {
  if (!requested) return link.items;
  const linked = new Set(link.items.map(wpItemKey));
  for (const item of requested) {
    if (!linked.has(wpItemKey(item))) {
      throw wordPressError(
        'badRequest',
        `${wpItemRoot(item)} is not linked to this project. Add it to the project first.`,
      );
    }
  }
  return [...requested];
}

export function newWpLink(
  siteId: string,
  items: readonly WpItemRef[],
  now: number,
  ignore?: ProjectWordPressLink['ignore'],
): ProjectWordPressLink {
  const kept = normalizeWpIgnore(ignore, items);
  return {
    siteId,
    items: items.map((item) => ({ kind: item.kind, slug: item.slug })),
    linkedAt: new Date(now).toISOString(),
    // What was ignored stays for the items that remain; a removed item's lines go with it.
    ...(kept ? { ignore: kept } : {}),
  };
}

/** The items whose folder (or file) is already in the project and is not an empty folder. */
export async function itemsWithFiles(
  projectRoot: string,
  items: readonly WpItemRef[],
): Promise<WpItemRef[]> {
  const taken: WpItemRef[] = [];
  for (const item of items) {
    const kind = await itemRootKind(projectRoot, item);
    if (kind === null) continue;
    if (kind === 'folder') {
      const entries = await readdir(join(projectRoot, wpItemRoot(item)));
      if (entries.length === 0) continue;
    }
    taken.push(item);
  }
  return taken;
}

const LOCAL_ROOTS: readonly { kind: WpItemRef['kind']; folder: string; files: boolean }[] = [
  { kind: 'theme', folder: 'themes', files: false },
  { kind: 'plugin', folder: 'plugins', files: true },
  { kind: 'mu-plugin', folder: 'mu-plugins', files: true },
];

/**
 * The themes, plugins and must-use plugins in a project's wp-content, each as a folder with files
 * in it or, for plugins, a `.php` file. Links are not followed, names the sync would refuse are
 * left out, and so is the `index.php` WordPress puts in each folder to keep it from being listed.
 */
export async function listLocalItems(
  projectRoot: string,
  linked: ReadonlySet<string>,
): Promise<DeployWordPressLocalItem[]> {
  const found: DeployWordPressLocalItem[] = [];
  for (const root of LOCAL_ROOTS) {
    const folder = join(projectRoot, 'wp-content', root.folder);
    const info = await lstat(folder).catch(() => null);
    if (!info?.isDirectory()) continue;
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !isValidWpSlug(entry.name)) continue;
      const item = { kind: root.kind, slug: entry.name };
      if (entry.isDirectory()) {
        const inside = await readdir(join(folder, entry.name)).catch(() => []);
        if (inside.length === 0) continue;
        found.push({ ...item, isFile: false, linked: linked.has(wpItemKey(item)) });
      } else if (root.files && entry.isFile() && isWpFileItemSlug(entry.name)) {
        if (entry.name.toLowerCase() === 'index.php') continue;
        found.push({ ...item, isFile: true, linked: linked.has(wpItemKey(item)) });
      }
    }
  }
  const order = LOCAL_ROOTS.map((root) => root.kind);
  return found.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.slug.localeCompare(b.slug, 'en'),
  );
}

/**
 * Checks the items a caller calls new: each must be one of the items asked for, not linked yet,
 * missing on the site, and already hold files in the project.
 */
export async function assertNewItems(options: {
  projectRoot: string;
  items: readonly WpItemRef[];
  newItems: readonly WpItemRef[];
  linked: ReadonlySet<string>;
  onSite: ReadonlySet<string>;
}): Promise<void> {
  const asked = new Set(options.items.map(wpItemKey));
  const withFiles = new Set(
    (await itemsWithFiles(options.projectRoot, options.newItems)).map(wpItemKey),
  );
  for (const item of options.newItems) {
    const key = wpItemKey(item);
    const root = wpItemRoot(item);
    if (!asked.has(key)) {
      throw wordPressError(
        'badRequest',
        `${root} is new, but it is not one of the items asked for.`,
      );
    }
    if (options.linked.has(key)) {
      throw wordPressError('badRequest', `${root} is already in this project.`);
    }
    if (options.onSite.has(key)) {
      throw wordPressError(
        'badRequest',
        `The site already has ${root}. Add it as an existing ${item.kind === 'theme' ? 'theme' : 'plugin'} instead.`,
      );
    }
    if (!withFiles.has(key)) {
      throw wordPressError(
        'badRequest',
        `${root} has no files yet. Put the files of the new ${item.kind === 'theme' ? 'theme' : 'plugin'} there first.`,
      );
    }
  }
}

/** Each item's folder (or file) in the project must be missing or an empty folder. */
export async function assertItemFoldersEmpty(
  projectRoot: string,
  items: readonly WpItemRef[],
): Promise<void> {
  const taken = (await itemsWithFiles(projectRoot, items)).map(wpItemRoot);
  if (taken.length > 0) {
    throw wordPressError(
      'folderNotEmpty',
      [
        taken.length === 1
          ? 'This folder already holds files, so AgentMate will not pull into it:'
          : 'These folders already hold files, so AgentMate will not pull into them:',
        ...taken,
      ].join('\n'),
    );
  }
}
