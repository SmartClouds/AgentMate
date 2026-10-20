import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { shell } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { filesErrorCode, filesErrorMessage } from '../../shared/deployFilesErrors';
import type { SftpLocalEntry } from '../../shared/sftpTypes';
import { setElectronPath } from '../../test/main/electronMock';
import { tempDir, writeTree } from '../../test/main/fixtures';
import { LocalBrowseRegistry } from './localBrowse';
import { localDelete, localList, localMkdir, localPlaces, localRename } from './localFs';

const WINDOWS = process.platform === 'win32';
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

/** Whether this machine lets an ordinary user make file symlinks (Windows needs developer mode). */
function canSymlinkFiles(): boolean {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'target'), 'x');
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return filesErrorCode(error);
  }
}

function entry(entries: SftpLocalEntry[], name: string): SftpLocalEntry {
  const found = entries.find((one) => one.name === name);
  if (!found) throw new Error(`no entry ${name} in ${entries.map((one) => one.name).join(', ')}`);
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('localPlaces', () => {
  it('offers Home, Desktop, Documents and Downloads that exist, then the drives', async () => {
    const home = tempDir();
    const desktop = join(home, 'Desktop');
    const documents = join(home, 'Documents');
    mkdirSync(desktop);
    mkdirSync(documents);
    setElectronPath('home', home);
    setElectronPath('desktop', desktop);
    setElectronPath('documents', documents);
    setElectronPath('downloads', join(home, 'Downloads-not-there'));

    const places = await localPlaces({
      platform: 'win32',
      exists: (path) => path === 'C:\\' || path === 'D:\\',
    });

    expect(places).toEqual([
      { id: 'home', label: 'Home', path: home, kind: 'home' },
      { id: 'desktop', label: 'Desktop', path: desktop, kind: 'desktop' },
      { id: 'documents', label: 'Documents', path: documents, kind: 'documents' },
      { id: 'drive:C', label: 'Drive (C:)', path: 'C:\\', kind: 'drive' },
      { id: 'drive:D', label: 'Drive (D:)', path: 'D:\\', kind: 'drive' },
    ]);
  });

  it('offers / instead of drives on macOS and Linux, and no folder twice', async () => {
    const home = tempDir();
    setElectronPath('home', home);
    // Some Linux desktops without XDG folders answer the home folder for these.
    setElectronPath('desktop', home);
    setElectronPath('documents', home);
    setElectronPath('downloads', join(home, 'nope'));

    const places = await localPlaces({ platform: 'linux' });

    expect(places).toEqual([
      { id: 'home', label: 'Home', path: home, kind: 'home' },
      { id: 'root', label: '/', path: '/', kind: 'root' },
    ]);
  });

  it('leaves out a place that is a file rather than a folder', async () => {
    const home = tempDir();
    writeFileSync(join(home, 'Desktop'), 'not a folder');
    setElectronPath('home', home);
    setElectronPath('desktop', join(home, 'Desktop'));
    setElectronPath('documents', join(home, 'nope'));
    setElectronPath('downloads', join(home, 'nope'));

    const places = await localPlaces({ platform: 'linux' });
    expect(places.map((place) => place.id)).toEqual(['home', 'root']);
  });
});

describe('localList', () => {
  it('lists files and folders with their size, time and hidden flag', async () => {
    const dir = writeTree(tempDir(), {
      'index.html': '<html></html>',
      '.env': 'SECRET=1',
      'desktop.ini': '[x]',
      'Thumbs.db': 'x',
      'assets/app.css': 'body{}',
    });
    mkdirSync(join(dir, '$RECYCLE.BIN'));
    mkdirSync(join(dir, 'System Volume Information'));
    utimesSync(join(dir, 'index.html'), 1_700_000_000, 1_700_000_000);

    const listing = await localList(dir);

    expect(listing.path).toBe(resolve(dir));
    expect(listing.parent).toBe(parse(resolve(dir)).dir);
    expect(listing.entries.map((one) => one.name).sort()).toEqual(
      [
        '$RECYCLE.BIN',
        '.env',
        'System Volume Information',
        'Thumbs.db',
        'assets',
        'desktop.ini',
        'index.html',
      ].sort(),
    );
    expect(entry(listing.entries, 'index.html')).toEqual({
      name: 'index.html',
      path: join(resolve(dir), 'index.html'),
      isDirectory: false,
      isSymlink: false,
      size: 13,
      mtimeMs: 1_700_000_000_000,
      mode: WINDOWS ? null : statSync(join(dir, 'index.html')).mode & 0o7777,
      hidden: false,
    });
    expect(entry(listing.entries, 'assets')).toMatchObject({
      isDirectory: true,
      isSymlink: false,
      size: 0,
      hidden: false,
    });
    for (const hidden of [
      '.env',
      'desktop.ini',
      'Thumbs.db',
      '$RECYCLE.BIN',
      'System Volume Information',
    ]) {
      expect(entry(listing.entries, hidden).hidden, hidden).toBe(true);
    }
  });

  it('gives the permission bits on macOS and Linux', async () => {
    if (WINDOWS) return;
    const dir = writeTree(tempDir(), { 'run.sh': '#!/bin/sh' });
    chmodSync(join(dir, 'run.sh'), 0o750);
    const listing = await localList(dir);
    expect(entry(listing.entries, 'run.sh').mode).toBe(0o750);
  });

  it('marks a junction or link to a folder as both a folder and a link', async () => {
    const dir = tempDir();
    const target = writeTree(tempDir(), { 'inside.txt': 'x' });
    symlinkSync(target, join(dir, 'linked'), 'junction');

    const listing = await localList(dir);

    expect(entry(listing.entries, 'linked')).toMatchObject({
      isDirectory: true,
      isSymlink: true,
      size: 0,
    });
  });

  it.skipIf(!canSymlinkFiles())(
    'follows a file link and lists a broken one as an empty file',
    async () => {
      const dir = writeTree(tempDir(), { 'real.txt': 'twelve bytes' });
      symlinkSync(join(dir, 'real.txt'), join(dir, 'good-link'), 'file');
      symlinkSync(join(dir, 'missing.txt'), join(dir, 'broken-link'), 'file');

      const listing = await localList(dir);

      expect(entry(listing.entries, 'good-link')).toMatchObject({
        isDirectory: false,
        isSymlink: true,
        size: 12,
      });
      expect(entry(listing.entries, 'broken-link')).toMatchObject({
        isDirectory: false,
        isSymlink: true,
        size: 0,
      });
    },
  );

  it('lists a broken junction as an empty file rather than failing the folder', async () => {
    const dir = tempDir();
    const target = tempDir();
    const gone = join(target, 'gone');
    mkdirSync(gone);
    symlinkSync(gone, join(dir, 'dangling'), 'junction');
    // Removing the target leaves the junction pointing nowhere.
    rmSync(gone, { recursive: true });

    const listing = await localList(dir);

    expect(entry(listing.entries, 'dangling')).toMatchObject({
      isDirectory: false,
      isSymlink: true,
      size: 0,
    });
  });

  it('has no parent at the top of a drive or of the file system', async () => {
    const root = parse(resolve(tempDir())).root;
    const listing = await localList(root);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBeNull();
  });

  it('answers folderMissing for a folder that is not there', async () => {
    const missing = join(tempDir(), 'nope');
    const error = await localList(missing).catch((caught: unknown) => caught as Error);
    expect(filesErrorCode(error)).toBe('folderMissing');
    expect((error as Error).message).toContain(missing);
  });

  it('answers invalidInput for a file', async () => {
    const dir = writeTree(tempDir(), { 'a.txt': 'x' });
    expect(await codeOf(localList(join(dir, 'a.txt')))).toBe('invalidInput');
  });

  it.skipIf(WINDOWS || ROOT_USER)(
    'answers permissionDenied for a folder it may not read',
    async () => {
      const dir = tempDir();
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        expect(await codeOf(localList(locked))).toBe('permissionDenied');
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe('localMkdir', () => {
  it('makes the folder and answers its path', async () => {
    const dir = tempDir();
    const made = await localMkdir(dir, 'new folder');
    expect(made).toBe(join(resolve(dir), 'new folder'));
    expect(statSync(made).isDirectory()).toBe(true);
  });

  it('answers exists when the name is taken, by a file or a folder', async () => {
    const dir = writeTree(tempDir(), { 'taken.txt': 'x', 'sub/a': 'x' });
    expect(await codeOf(localMkdir(dir, 'taken.txt'))).toBe('exists');
    expect(await codeOf(localMkdir(dir, 'sub'))).toBe('exists');
  });

  it('answers folderMissing when the parent is gone', async () => {
    expect(await codeOf(localMkdir(join(tempDir(), 'gone'), 'x'))).toBe('folderMissing');
  });

  it('refuses names that are not one entry, or that this computer cannot hold', async () => {
    const dir = tempDir();
    const bad = ['', '.', '..', 'a/b', 'a\\b', 'a\0b'];
    if (WINDOWS) bad.push('a:b', 'CON', 'trailing.', 'what?');
    for (const name of bad) {
      expect(await codeOf(localMkdir(dir, name)), JSON.stringify(name)).toBe('invalidInput');
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('localRename', () => {
  it('renames in place and answers the new path', async () => {
    const dir = writeTree(tempDir(), { 'old.txt': 'contents' });
    const renamed = await localRename(join(dir, 'old.txt'), 'new.txt');
    expect(renamed).toBe(join(resolve(dir), 'new.txt'));
    expect(readFileSync(renamed, 'utf-8')).toBe('contents');
    expect(existsSync(join(dir, 'old.txt'))).toBe(false);
  });

  it('answers exists and touches nothing when the name is taken', async () => {
    const dir = writeTree(tempDir(), { 'a.txt': 'a', 'b.txt': 'b', 'sub/x': 'x' });
    expect(await codeOf(localRename(join(dir, 'a.txt'), 'b.txt'))).toBe('exists');
    expect(await codeOf(localRename(join(dir, 'a.txt'), 'sub'))).toBe('exists');
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('a');
    expect(readFileSync(join(dir, 'b.txt'), 'utf-8')).toBe('b');
  });

  it('lets only the case of a name change, even where names ignore case', async () => {
    const dir = writeTree(tempDir(), { 'readme.md': 'x' });
    const renamed = await localRename(join(dir, 'readme.md'), 'README.md');
    expect(renamed).toBe(join(resolve(dir), 'README.md'));
    expect(readdirSync(dir)).toEqual(['README.md']);
  });

  it('answers folderMissing for a path that is gone', async () => {
    expect(await codeOf(localRename(join(tempDir(), 'gone.txt'), 'x.txt'))).toBe('folderMissing');
  });

  it('refuses a bad name and the top of a drive', async () => {
    const dir = writeTree(tempDir(), { 'a.txt': 'a' });
    expect(await codeOf(localRename(join(dir, 'a.txt'), '../a.txt'))).toBe('invalidInput');
    const root = parse(resolve(dir)).root;
    expect(await codeOf(localRename(root, 'x'))).toBe('invalidInput');
  });
});

describe('localDelete', () => {
  it('moves each path to the Trash by default', async () => {
    const dir = writeTree(tempDir(), { 'a.txt': 'a', 'sub/b.txt': 'b' });
    const trash = vi.spyOn(shell, 'trashItem');

    await localDelete([join(dir, 'a.txt'), join(dir, 'sub')], { permanent: false });

    expect(trash.mock.calls.map((call) => call[0])).toEqual([
      join(resolve(dir), 'a.txt'),
      join(resolve(dir), 'sub'),
    ]);
  });

  it('deletes for good, folders and all, when permanent', async () => {
    const dir = writeTree(tempDir(), { 'a.txt': 'a', 'sub/deep/b.txt': 'b', 'keep.txt': 'k' });
    const trash = vi.spyOn(shell, 'trashItem');

    await localDelete([join(dir, 'a.txt'), join(dir, 'sub')], { permanent: true });

    expect(trash).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(['keep.txt']);
  });

  it('skips a path that is already gone, so a retry of all of them is safe', async () => {
    const dir = writeTree(tempDir(), { 'a.txt': 'a' });
    const trash = vi.spyOn(shell, 'trashItem');

    await localDelete([join(dir, 'gone.txt'), join(dir, 'a.txt')], { permanent: true });
    await localDelete([join(dir, 'gone.txt')], { permanent: false });

    expect(readdirSync(dir)).toEqual([]);
    expect(trash).not.toHaveBeenCalled();
  });

  it('removes a junction itself and never what it points at', async () => {
    const dir = tempDir();
    const target = writeTree(tempDir(), { 'precious.txt': 'keep me' });
    symlinkSync(target, join(dir, 'linked'), 'junction');

    await localDelete([join(dir, 'linked')], { permanent: true });

    expect(readdirSync(dir)).toEqual([]);
    expect(readFileSync(join(target, 'precious.txt'), 'utf-8')).toBe('keep me');
  });

  it('stops at the first failure, with a coded error naming the path', async () => {
    const dir = writeTree(tempDir(), { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const trash = vi
      .spyOn(shell, 'trashItem')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Failed to move item to trash'));

    const error = await localDelete([join(dir, 'a.txt'), join(dir, 'b.txt'), join(dir, 'c.txt')], {
      permanent: false,
    }).catch((caught: unknown) => caught as Error);

    expect(trash).toHaveBeenCalledTimes(2);
    expect(filesErrorCode(error)).toBe('server');
    expect((error as Error).message).toContain(join(resolve(dir), 'b.txt'));
    expect((error as Error).message).toMatch(/Trash/);
    expect(filesErrorMessage(error)).not.toMatch(/server/i);
  });

  it('refuses the top of a drive or of the file system', async () => {
    const root = parse(resolve(tempDir())).root;
    const trash = vi.spyOn(shell, 'trashItem');
    expect(await codeOf(localDelete([root], { permanent: true }))).toBe('invalidInput');
    expect(trash).not.toHaveBeenCalled();
  });
});

describe('the write guard', () => {
  it('runs every write past the registry before it changes anything', async () => {
    const listed = writeTree(tempDir(), { 'a.txt': 'a' });
    const outside = writeTree(tempDir(), { 'b.txt': 'b' });
    const registry = new LocalBrowseRegistry();
    registry.record(1, listed);
    const guard = (path: string) => registry.assertWritable(1, path);
    const trash = vi.spyOn(shell, 'trashItem');

    await expect(localMkdir(listed, 'made', { guard })).resolves.toBe(
      join(resolve(listed), 'made'),
    );
    expect(await codeOf(localMkdir(outside, 'made', { guard }))).toBe('invalidInput');
    expect(existsSync(join(outside, 'made'))).toBe(false);

    expect(await codeOf(localRename(join(outside, 'b.txt'), 'c.txt', { guard }))).toBe(
      'invalidInput',
    );
    expect(existsSync(join(outside, 'b.txt'))).toBe(true);
    await expect(localRename(join(listed, 'a.txt'), 'z.txt', { guard })).resolves.toBe(
      join(resolve(listed), 'z.txt'),
    );

    // One path outside fails the whole call before anything is deleted.
    expect(
      await codeOf(
        localDelete([join(listed, 'z.txt'), join(outside, 'b.txt')], {
          permanent: true,
          guard,
        }),
      ),
    ).toBe('invalidInput');
    expect(existsSync(join(listed, 'z.txt'))).toBe(true);
    expect(existsSync(join(outside, 'b.txt'))).toBe(true);

    await localDelete([join(listed, 'z.txt')], { permanent: false, guard });
    expect(trash).toHaveBeenCalledWith(join(resolve(listed), 'z.txt'));
  });

  it('checks both the old and the new path of a rename', async () => {
    const listed = writeTree(tempDir(), { 'a.txt': 'a' });
    const seen: string[] = [];
    const guard = async (path: string) => {
      seen.push(path);
      return path;
    };

    await localRename(join(listed, 'a.txt'), 'b.txt', { guard });

    expect(seen).toEqual([join(resolve(listed), 'a.txt'), join(resolve(listed), 'b.txt')]);
  });

  it('with the entry guard, never deletes or renames a listed folder itself', async () => {
    const parent = tempDir();
    const listed = join(parent, 'listed');
    writeTree(listed, { 'child.txt': 'c' });
    const registry = new LocalBrowseRegistry();
    registry.record(1, listed);
    const guard = (path: string) => registry.assertEntryWritable(1, path);

    expect(await codeOf(localDelete([listed], { permanent: true, guard }))).toBe('invalidInput');
    expect(await codeOf(localRename(listed, 'moved', { guard }))).toBe('invalidInput');
    expect(existsSync(join(listed, 'child.txt'))).toBe(true);

    await expect(localRename(join(listed, 'child.txt'), 'kid.txt', { guard })).resolves.toBe(
      join(resolve(listed), 'kid.txt'),
    );
    await localDelete([join(listed, 'kid.txt')], { permanent: true, guard });
    expect(existsSync(join(listed, 'kid.txt'))).toBe(false);

    // Once the folder holding it is listed too (the user went back up), it can go.
    registry.record(1, parent);
    await localDelete([listed], { permanent: true, guard });
    expect(existsSync(listed)).toBe(false);
  });

  it('with the entry guard, deletes and renames a junction that leads outside, not its target', async () => {
    const listed = tempDir();
    const target = writeTree(tempDir(), { 'precious.txt': 'keep me' });
    symlinkSync(target, join(listed, 'linked'), 'junction');
    const registry = new LocalBrowseRegistry();
    registry.record(1, listed);
    const guard = (path: string) => registry.assertEntryWritable(1, path);

    await expect(localRename(join(listed, 'linked'), 'renamed', { guard })).resolves.toBe(
      join(resolve(listed), 'renamed'),
    );
    expect(await codeOf(localMkdir(join(listed, 'renamed'), 'sneaky', { guard }))).toBe(
      'invalidInput',
    );
    await localDelete([join(listed, 'renamed')], { permanent: true, guard });

    expect(readdirSync(listed)).toEqual([]);
    expect(readFileSync(join(target, 'precious.txt'), 'utf-8')).toBe('keep me');
    expect(existsSync(join(target, 'sneaky'))).toBe(false);
  });
});
