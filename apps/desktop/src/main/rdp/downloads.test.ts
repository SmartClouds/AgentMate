import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import {
  abandonDownloads,
  beginDownload,
  downloadFolder,
  downloadRoots,
  finishFile,
  forgetDownload,
  prepareEntry,
  safeComponent,
  safeRelativePath,
  writeChunk,
} from './downloads';

/**
 * File names here come from the remote machine, over the clipboard channel, and are then joined
 * onto a folder the user picked. Anything that gets through lands as a real file on this disk, so
 * the name cleaning is the whole security boundary.
 *
 * Each test uses its own owner id, because the module keeps one registry of live downloads.
 */

let nextOwner = 100;
function owner(): number {
  nextOwner += 1;
  return nextOwner;
}

/** Every file and folder under `dir`, as relative paths, sorted. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replace(/\\/g, '/'),
    )
    .sort();
}

describe('safeComponent', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['Some File (final).txt', 'Some File (final).txt'],
    ['  padded.txt  ', 'padded.txt'],
    ['\u65e5\u672c\u8a9e.txt', '\u65e5\u672c\u8a9e.txt'],
  ])('keeps %s as is', (input, expected) => {
    expect(safeComponent(input)).toBe(expected);
  });

  it.each([['.'], ['..'], [''], ['   '], ['C:'], ['z:'], ['...'], ['. . .']])(
    'drops %s entirely',
    (input) => {
      // Dropping is right for a component that names a directory rather than a file: the
      // caller substitutes a name of its own.
      expect(safeComponent(input)).toBeNull();
    },
  );

  it('replaces every separator, so one component can never become two', () => {
    expect(safeComponent('a/b')).toBe('a_b');
    expect(safeComponent('a\\b')).toBe('a_b');
    expect(safeComponent('..\\..\\Windows\\System32\\drivers\\etc\\hosts')).toBe(
      '.._.._Windows_System32_drivers_etc_hosts',
    );
    expect(safeComponent('../../etc/passwd')).toBe('.._.._etc_passwd');
  });

  it('replaces the characters Windows refuses', () => {
    expect(safeComponent('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('replaces a NUL and other control characters', () => {
    // A NUL truncates the name inside some native calls, which would change where it lands.
    expect(safeComponent('evil\u0000.txt')).toBe('evil_.txt');
    expect(safeComponent('bell\u0007tab\tnewline\n.txt')).toBe('bell_tab_newline_.txt');
  });

  it('strips trailing dots and spaces that Windows would ignore', () => {
    // "report.txt." and "report.txt" are the same file to Windows, which would silently
    // overwrite the earlier download.
    expect(safeComponent('report.txt.')).toBe('report.txt');
    expect(safeComponent('report.txt   ')).toBe('report.txt');
    expect(safeComponent('report.txt. . ')).toBe('report.txt');
  });

  it.each([
    ['CON', '_CON'],
    ['con', '_con'],
    ['NUL', '_NUL'],
    ['aux.txt', '_aux.txt'],
    ['PRN.tar.gz', '_PRN.tar.gz'],
    ['com1', '_com1'],
    ['LPT9.log', '_LPT9.log'],
  ])('prefixes the reserved name %s', (input, expected) => {
    // Opening one of these on Windows talks to a device instead of creating a file.
    expect(safeComponent(input)).toBe(expected);
  });

  it('leaves a name that only looks reserved', () => {
    expect(safeComponent('console.log')).toBe('console.log');
    expect(safeComponent('com10')).toBe('com10');
    expect(safeComponent('nula')).toBe('nula');
  });
});

describe('safeRelativePath', () => {
  it('returns nothing for a missing or empty path', () => {
    expect(safeRelativePath(undefined)).toEqual([]);
    expect(safeRelativePath('')).toEqual([]);
  });

  it('splits on either separator', () => {
    expect(safeRelativePath('a\\b/c')).toEqual(['a', 'b', 'c']);
  });

  it('drops the components that cannot be used, keeping the rest', () => {
    expect(safeRelativePath('../../secrets')).toEqual(['secrets']);
    expect(safeRelativePath('C:\\Users\\bob\\Desktop')).toEqual(['Users', 'bob', 'Desktop']);
    expect(safeRelativePath('a//b')).toEqual(['a', 'b']);
    expect(safeRelativePath('/leading')).toEqual(['leading']);
  });
});

describe('a download in progress', () => {
  it('writes a file through a .part and renames it when the transfer succeeds', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);
    expect(downloadFolder(id, ownerId)).toBe(folder);

    const finalPath = await prepareEntry(id, ownerId, 0, {
      name: 'notes.txt',
      isDirectory: false,
    });
    expect(finalPath).toBe(join(folder, 'notes.txt'));
    // While it is still running only the .part exists, so a half-copied file is obvious.
    expect(await tree(folder)).toEqual(['notes.txt.part']);

    await writeChunk(id, ownerId, 0, Buffer.from('first ', 'utf-8'));
    await writeChunk(id, ownerId, 0, Buffer.from('second', 'utf-8'));
    await finishFile(id, ownerId, 0, true);

    expect(await tree(folder)).toEqual(['notes.txt']);
    expect(await readFile(finalPath, 'utf-8')).toBe('first second');
  });

  it('leaves nothing behind when the transfer fails', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);
    await prepareEntry(id, ownerId, 0, { name: 'broken.bin', isDirectory: false });
    await writeChunk(id, ownerId, 0, Buffer.from([1, 2, 3]));
    await finishFile(id, ownerId, 0, false);
    expect(await tree(folder)).toEqual([]);
  });

  it('creates a folder entry and the folders above a nested file', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);

    await prepareEntry(id, ownerId, 0, { name: 'project', isDirectory: true });
    await prepareEntry(id, ownerId, 1, {
      name: 'main.ts',
      path: 'project/src/deep',
      isDirectory: false,
    });
    await writeChunk(id, ownerId, 1, Buffer.from('export {};', 'utf-8'));
    await finishFile(id, ownerId, 1, true);

    expect(await tree(folder)).toEqual([
      'project',
      'project/src',
      'project/src/deep',
      'project/src/deep/main.ts',
    ]);
  });

  it('keeps a hostile path inside the chosen folder', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);

    const finalPath = await prepareEntry(id, ownerId, 0, {
      name: '..\\..\\owned.txt',
      path: '../../..',
      isDirectory: false,
    });
    await finishFile(id, ownerId, 0, true);

    expect(finalPath.startsWith(folder)).toBe(true);
    expect(await tree(folder)).toEqual(['.._.._owned.txt']);
  });

  it('names a file the server left unnamed', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);
    const finalPath = await prepareEntry(id, ownerId, 0, { name: '..', isDirectory: false });
    expect(finalPath).toBe(join(folder, 'unnamed'));
  });

  it('numbers a second file with the same name instead of overwriting', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);

    const first = await prepareEntry(id, ownerId, 0, { name: 'notes.txt', isDirectory: false });
    const second = await prepareEntry(id, ownerId, 1, { name: 'NOTES.txt', isDirectory: false });
    const third = await prepareEntry(id, ownerId, 2, { name: 'notes.txt', isDirectory: false });

    expect(first).toBe(join(folder, 'notes.txt'));
    // Case-insensitive, because that is how the filesystem underneath behaves on Windows.
    expect(second).toBe(join(folder, 'NOTES (1).txt'));
    // The same name twice in one transfer is the same entry, so it keeps the name it got.
    expect(third).toBe(first);
  });

  it('numbers around a file that was already in the folder', async () => {
    const folder = tempDir('agentmate-dl-');
    await writeFile(join(folder, 'report.pdf'), 'existing', 'utf-8');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);

    const target = await prepareEntry(id, ownerId, 0, { name: 'report.pdf', isDirectory: false });
    expect(target).toBe(join(folder, 'report (1).pdf'));
    await finishFile(id, ownerId, 0, true);
    expect(await readFile(join(folder, 'report.pdf'), 'utf-8')).toBe('existing');
  });

  it('renames only the top folder, so a tree keeps its shape', async () => {
    const folder = tempDir('agentmate-dl-');
    await writeFile(join(folder, 'src'), 'in the way', 'utf-8');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);

    await prepareEntry(id, ownerId, 0, { name: 'a.ts', path: 'src/lib', isDirectory: false });
    await prepareEntry(id, ownerId, 1, { name: 'b.ts', path: 'src/lib', isDirectory: false });
    await finishFile(id, ownerId, 0, true);
    await finishFile(id, ownerId, 1, true);

    expect(await tree(folder)).toEqual([
      'src',
      'src (1)',
      'src (1)/lib',
      'src (1)/lib/a.ts',
      'src (1)/lib/b.ts',
    ]);
  });
});

describe('download ownership', () => {
  it('refuses every call from a window that does not own the download', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const other = owner();
    const id = beginDownload(ownerId, folder);
    await prepareEntry(id, ownerId, 0, { name: 'notes.txt', isDirectory: false });

    await expect(prepareEntry(id, other, 1, { name: 'x.txt', isDirectory: false })).rejects.toThrow(
      /Unknown download/,
    );
    await expect(writeChunk(id, other, 0, Buffer.from('x'))).rejects.toThrow(/Unknown download/);
    await expect(finishFile(id, other, 0, true)).rejects.toThrow(/Unknown download/);
    expect(() => downloadFolder(id, other)).toThrow(/Unknown download/);
  });

  it('refuses an id that was never handed out', async () => {
    await expect(
      writeChunk('00000000-0000-4000-8000-000000000000', owner(), 0, Buffer.from('x')),
    ).rejects.toThrow(/Unknown download/);
  });

  it('refuses a chunk for a file that was never prepared', async () => {
    const ownerId = owner();
    const id = beginDownload(ownerId, tempDir('agentmate-dl-'));
    await expect(writeChunk(id, ownerId, 7, Buffer.from('x'))).rejects.toThrow(
      /not prepared for download/,
    );
  });

  it('ignores finishing a file twice', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);
    await prepareEntry(id, ownerId, 0, { name: 'notes.txt', isDirectory: false });
    await finishFile(id, ownerId, 0, true);
    // The window can send the completion twice; the second one must not throw on a closed handle.
    await expect(finishFile(id, ownerId, 0, true)).resolves.toBeUndefined();
    expect(await tree(folder)).toEqual(['notes.txt']);
  });
});

describe('downloadRoots', () => {
  it('lists the top-level files and folders under the names they got', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);
    await prepareEntry(id, ownerId, 0, { name: 'photos', isDirectory: true });
    await prepareEntry(id, ownerId, 1, { name: 'a.jpg', path: 'photos', isDirectory: false });
    await prepareEntry(id, ownerId, 2, { name: 'notes.txt', isDirectory: false });
    await finishFile(id, ownerId, 1, true);
    await finishFile(id, ownerId, 2, true);

    // The nested file is inside photos, so only the two things a person copied are roots.
    expect(downloadRoots(id, ownerId).sort()).toEqual(
      [join(folder, 'notes.txt'), join(folder, 'photos')].sort(),
    );
  });

  it('uses the collision-free name when the folder already holds one with that name', async () => {
    const folder = tempDir('agentmate-dl-');
    await writeFile(join(folder, 'report.txt'), 'older');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);
    await prepareEntry(id, ownerId, 0, { name: 'report.txt', isDirectory: false });

    expect(downloadRoots(id, ownerId)).toEqual([join(folder, 'report (1).txt')]);
  });

  it('refuses a download that belongs to another window', () => {
    const id = beginDownload(owner(), tempDir('agentmate-dl-'));
    expect(() => downloadRoots(id, owner())).toThrow(/Unknown download/);
  });
});

describe('forgetDownload', () => {
  it('drops the bookkeeping and keeps the files', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);
    await prepareEntry(id, ownerId, 0, { name: 'kept.txt', isDirectory: false });
    await writeChunk(id, ownerId, 0, Buffer.from('data', 'utf-8'));
    await finishFile(id, ownerId, 0, true);

    forgetDownload(id, ownerId);

    expect(() => downloadFolder(id, ownerId)).toThrow(/Unknown download/);
    expect(await readFile(join(folder, 'kept.txt'), 'utf-8')).toBe('data');
  });

  it('refuses a download that belongs to another window', () => {
    const mine = owner();
    const id = beginDownload(mine, tempDir('agentmate-dl-'));
    expect(() => forgetDownload(id, owner())).toThrow(/Unknown download/);
    expect(() => downloadFolder(id, mine)).not.toThrow();
  });
});

describe('abandonDownloads', () => {
  it('closes and deletes the unfinished files of a closed window', async () => {
    const folder = tempDir('agentmate-dl-');
    const ownerId = owner();
    const id = beginDownload(ownerId, folder);
    await prepareEntry(id, ownerId, 0, { name: 'done.txt', isDirectory: false });
    await prepareEntry(id, ownerId, 1, { name: 'half.txt', isDirectory: false });
    await writeChunk(id, ownerId, 1, Buffer.from('partial', 'utf-8'));
    await finishFile(id, ownerId, 0, true);

    await abandonDownloads(ownerId);

    // What finished stays; the .part of what did not is gone, not left as junk.
    expect(await tree(folder)).toEqual(['done.txt']);
    expect(() => downloadFolder(id, ownerId)).toThrow(/Unknown download/);
  });

  it('leaves the downloads of another window alone', async () => {
    const mine = tempDir('agentmate-dl-');
    const theirs = tempDir('agentmate-dl-');
    const myOwner = owner();
    const theirOwner = owner();
    const myId = beginDownload(myOwner, mine);
    const theirId = beginDownload(theirOwner, theirs);
    await prepareEntry(theirId, theirOwner, 0, { name: 'keep.txt', isDirectory: false });
    await writeChunk(theirId, theirOwner, 0, Buffer.from('still going', 'utf-8'));

    await abandonDownloads(myOwner);

    expect(() => downloadFolder(myId, myOwner)).toThrow(/Unknown download/);
    expect(downloadFolder(theirId, theirOwner)).toBe(theirs);
    await finishFile(theirId, theirOwner, 0, true);
    expect(await readFile(join(theirs, 'keep.txt'), 'utf-8')).toBe('still going');
  });

  it('does nothing for a window that never downloaded anything', async () => {
    await expect(abandonDownloads(owner())).resolves.toBeUndefined();
  });
});
