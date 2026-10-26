import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { wordPressError } from '../../../shared/wordpressErrors';

/**
 * Writes what a site sent into a project folder (E19). The site is untrusted, so every path is
 * checked again here, whatever checked it before: only plain relative segments, no folder on the
 * way may be a link (symlink or junction), the resolved folder must still be inside the project,
 * and a file is written to a temporary name beside its target and renamed over it, so a reader
 * never sees half a file. Folders it had to create are remembered, so a failed new project can
 * remove exactly those and nothing the user had.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const BAD_SEGMENT = /[\u0000-\u001f\u007f\\:]/;

function rejected(path: string, why: string): Error {
  return wordPressError('pathRejected', `Runova will not write ${path}: ${why}.`);
}

function segmentsOf(path: string): string[] {
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || BAD_SEGMENT.test(segment)) {
      throw rejected(path, 'the path is not a plain relative path');
    }
  }
  return segments;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !/^[A-Za-z]:/.test(rel));
}

export class WpLocalWriter {
  /** Absolute paths of the folders this writer created, in the order it made them. */
  readonly createdFolders: string[] = [];
  private realRoot: string | null = null;

  constructor(private readonly projectRoot: string) {}

  private async root(): Promise<string> {
    this.realRoot ??= await realpath(this.projectRoot);
    return this.realRoot;
  }

  /** Makes sure the folder exists as a real folder in the project, creating what is missing. */
  async ensureFolder(path: string): Promise<string> {
    const realRoot = await this.root();
    let current = this.projectRoot;
    let shown = '';
    for (const segment of path === '' ? [] : segmentsOf(path)) {
      current = join(current, segment);
      shown = shown ? `${shown}/${segment}` : segment;
      let info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) {
        await mkdir(current);
        this.createdFolders.push(current);
        info = await lstat(current);
      }
      if (info.isSymbolicLink()) throw rejected(shown, 'it is a link (symlink or junction)');
      if (!info.isDirectory()) throw rejected(shown, 'a file is in the way of that folder');
    }
    if (!isInside(realRoot, await realpath(current))) {
      throw rejected(path, 'it leads outside the project folder');
    }
    return current;
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const segments = segmentsOf(path);
    const name = segments.pop() as string;
    const folder = await this.ensureFolder(segments.join('/'));
    const target = join(folder, name);
    const existing = await lstat(target).catch(() => null);
    if (existing && !existing.isFile()) {
      throw rejected(path, existing.isSymbolicLink() ? 'it is a link' : 'a folder is in the way');
    }
    const temporary = join(folder, `.${name}.${randomBytes(6).toString('hex')}.runova-tmp`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Deletes a file; false when it was not there. A link or a folder is never removed. */
  async deleteFile(path: string): Promise<boolean> {
    const segments = segmentsOf(path);
    const name = segments.pop() as string;
    const folder = join(this.projectRoot, ...segments);
    // Only a real folder chain in the project is touched.
    const parent = await lstat(folder).catch(() => null);
    if (!parent) return false;
    await this.ensureFolder(segments.join('/'));
    const target = join(folder, name);
    const existing = await lstat(target).catch(() => null);
    if (!existing) return false;
    if (!existing.isFile()) throw rejected(path, 'it is not a plain file');
    await unlink(target);
    return true;
  }

  /** Removes the folders this writer created, outermost first (it removes what is inside). */
  async removeCreated(): Promise<void> {
    const outermost = this.createdFolders.filter(
      (folder) =>
        !this.createdFolders.some(
          (other) => other !== folder && folder.startsWith(`${other}${sep}`),
        ),
    );
    for (const folder of outermost.reverse()) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
