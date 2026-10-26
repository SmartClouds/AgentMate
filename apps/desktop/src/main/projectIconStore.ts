import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Project } from '@runova/core';
import { app } from 'electron';
import {
  iconExtensionForMime,
  iconMimeForFileName,
  parseIconDataUrl,
  prepareIconImage,
} from './projectIcons';

/**
 * Project logos live beside the rest of the app data rather than inside
 * projects.json. Keeping a 300 KB base64 blob per project in the file the app
 * reads on every list call made both the file and the reads bigger than they
 * had any reason to be.
 *
 * The renderer still works in data URLs, so reads hydrate `iconDataUrl` from the
 * file and writes put it back on disk. That also means a backup, which is built
 * from the same read path, carries every icon inline the way it always did.
 */
function iconsDir(): string {
  return join(app.getPath('userData'), 'data', 'project-icons');
}

/**
 * File name to data URL. Names are a fresh uuid per saved image and files are
 * never rewritten in place, so an entry here can't go stale.
 */
const cache = new Map<string, string>();

function iconPath(fileName: string): string {
  // basename keeps a doctored projects.json from pointing at anything outside the folder.
  return join(iconsDir(), basename(fileName));
}

async function readIcon(fileName: string): Promise<string | null> {
  const cached = cache.get(fileName);
  if (cached) return cached;
  try {
    const bytes = await readFile(iconPath(fileName));
    const dataUrl = `data:${iconMimeForFileName(fileName)};base64,${bytes.toString('base64')}`;
    cache.set(fileName, dataUrl);
    return dataUrl;
  } catch {
    // Missing or unreadable file: the project just falls back to the folder glyph.
    return null;
  }
}

async function writeIcon(dataUrl: string): Promise<string | null> {
  const parsed = parseIconDataUrl(dataUrl);
  // Not a data URL (an http icon from an older build, say). Leave it inline
  // rather than dropping the icon on the floor.
  if (!parsed) return null;

  let image = parsed;
  try {
    image = prepareIconImage(parsed);
  } catch {
    // Something the resizer refused. Store the bytes as they came in; they were
    // already accepted once by whichever handler produced this data URL.
  }
  const fileName = `${randomUUID()}${iconExtensionForMime(image.mime)}`;
  await mkdir(iconsDir(), { recursive: true });
  await writeFile(iconPath(fileName), image.bytes);
  cache.set(fileName, `data:${image.mime};base64,${image.bytes.toString('base64')}`);
  return fileName;
}

/** Drops icon files no project points at any more, e.g. after a delete or a replaced logo. */
async function removeOrphans(keep: Set<string>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(iconsDir());
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => !keep.has(name))
      .map(async (name) => {
        cache.delete(name);
        await unlink(iconPath(name)).catch(() => undefined);
      }),
  );
}

/** Fills in `iconDataUrl` from each project's stored icon file, for the renderer to display. */
export async function hydrateProjectIcons(projects: Project[]): Promise<Project[]> {
  return Promise.all(
    projects.map(async (project) => {
      if (!project.iconFile) return project;
      const dataUrl = await readIcon(project.iconFile);
      return dataUrl ? { ...project, iconDataUrl: dataUrl } : project;
    }),
  );
}

/**
 * Writes any new icon out to its own file and returns the projects in the shape
 * that belongs in projects.json: a file name, and no inlined image.
 */
export async function persistProjectIcons(projects: Project[]): Promise<Project[]> {
  const stored = await Promise.all(
    projects.map(async (project) => {
      const dataUrl = project.iconDataUrl;
      if (!dataUrl) return { ...project, iconDataUrl: null, iconFile: null };
      // Unchanged since it was read: the file on disk is already this image.
      if (project.iconFile && cache.get(project.iconFile) === dataUrl) {
        return { ...project, iconDataUrl: null };
      }
      const fileName = await writeIcon(dataUrl);
      return fileName
        ? { ...project, iconDataUrl: null, iconFile: fileName }
        : { ...project, iconFile: null };
    }),
  );

  await removeOrphans(new Set(stored.map((p) => p.iconFile).filter((n): n is string => !!n)));
  return stored;
}
