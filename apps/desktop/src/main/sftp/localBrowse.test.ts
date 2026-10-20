import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { tempDir } from '../../test/main/fixtures';
import { LOCAL_BROWSE_MAX_DIRS, LocalBrowseRegistry } from './localBrowse';

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return filesErrorCode(error);
  }
}

describe('LocalBrowseRegistry', () => {
  it('lets a write land inside a folder the owner listed, new files included', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'sub'));
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);

    await expect(registry.assertWritable(1, join(root, 'sub'))).resolves.toBe(join(root, 'sub'));
    await expect(registry.assertWritable(1, join(root, 'new.txt'))).resolves.toBe(
      join(root, 'new.txt'),
    );
    await expect(registry.assertWritable(1, join(root, 'a', 'b', 'c.txt'))).resolves.toBe(
      join(root, 'a', 'b', 'c.txt'),
    );
    await expect(registry.assertWritable(1, root)).resolves.toBe(resolve(root));
  });

  it('refuses ../ out of a listed folder, without echoing the path', async () => {
    const parent = tempDir();
    const root = join(parent, 'listed');
    mkdirSync(root);
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);

    const outsidePath = join(root, '..', 'secret-target.txt');
    const attempt = registry.assertWritable(1, outsidePath);
    await expect(attempt).rejects.toThrow(/\[files:invalidInput\]/);
    await expect(registry.assertWritable(1, outsidePath)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-target') }),
    );
    expect(await codeOf(registry.assertWritable(1, parent))).toBe('invalidInput');
  });

  it('refuses a junction or link inside a listed folder that leads outside it', async () => {
    const root = tempDir();
    const outside = tempDir();
    const link = join(root, 'escape');
    symlinkSync(outside, link, 'junction');
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);

    expect(await codeOf(registry.assertWritable(1, link))).toBe('invalidInput');
    expect(await codeOf(registry.assertWritable(1, join(link, 'new.txt')))).toBe('invalidInput');
    expect(await codeOf(registry.assertWritable(1, join(link, 'a', 'b.txt')))).toBe('invalidInput');
  });

  it('lets a listed folder reached through a link be written by its real path', async () => {
    const real = tempDir();
    const holder = tempDir();
    const link = join(holder, 'shortcut');
    symlinkSync(real, link, 'junction');
    const registry = new LocalBrowseRegistry();
    registry.record(1, link);

    await expect(registry.assertWritable(1, join(real, 'x.txt'))).resolves.toBe(
      join(real, 'x.txt'),
    );
    await expect(registry.assertWritable(1, join(link, 'x.txt'))).resolves.toBe(
      join(link, 'x.txt'),
    );
  });

  it('keeps each owner to its own folders', async () => {
    const root = tempDir();
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);

    expect(await codeOf(registry.assertWritable(2, join(root, 'x.txt')))).toBe('invalidInput');
  });

  it('refuses everything for an owner that listed nothing', async () => {
    const registry = new LocalBrowseRegistry();
    expect(await codeOf(registry.assertWritable(7, tempDir()))).toBe('invalidInput');
  });

  it('keeps only the last 32 folders, refreshing one listed again', async () => {
    const parent = tempDir();
    const dirs = Array.from({ length: LOCAL_BROWSE_MAX_DIRS + 1 }, (_unused, index) => {
      const dir = join(parent, `d${index}`);
      mkdirSync(dir);
      return dir;
    });
    const registry = new LocalBrowseRegistry();
    for (const dir of dirs.slice(0, LOCAL_BROWSE_MAX_DIRS)) registry.record(1, dir);
    // d0 is listed again, so d1 is now the oldest and the 33rd folder pushes it out.
    registry.record(1, dirs[0]);
    registry.record(1, dirs[LOCAL_BROWSE_MAX_DIRS]);

    expect(LOCAL_BROWSE_MAX_DIRS).toBe(32);
    expect(registry.dirsOf(1)).toHaveLength(32);
    await expect(registry.assertWritable(1, join(dirs[0], 'a'))).resolves.toBeTruthy();
    expect(await codeOf(registry.assertWritable(1, join(dirs[1], 'a')))).toBe('invalidInput');
    await expect(registry.assertWritable(1, join(dirs[2], 'a'))).resolves.toBeTruthy();
    await expect(
      registry.assertWritable(1, join(dirs[LOCAL_BROWSE_MAX_DIRS], 'a')),
    ).resolves.toBeTruthy();
  });

  it('records the same folder once however it is written', () => {
    const root = tempDir();
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);
    registry.record(1, join(root, '.'));
    registry.record(1, `${root}${process.platform === 'win32' ? '\\' : '/'}`);
    expect(registry.dirsOf(1)).toEqual([resolve(root)]);
  });

  it('forgets an owner on dropOwner', async () => {
    const root = tempDir();
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);
    registry.record(2, root);
    registry.dropOwner(1);

    expect(registry.dirsOf(1)).toEqual([]);
    expect(await codeOf(registry.assertWritable(1, join(root, 'x')))).toBe('invalidInput');
    await expect(registry.assertWritable(2, join(root, 'x'))).resolves.toBeTruthy();
  });
});

describe('assertEntryWritable', () => {
  it('refuses the listed folder itself, so it cannot be deleted or renamed', async () => {
    const root = tempDir();
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);

    expect(await codeOf(registry.assertEntryWritable(1, root))).toBe('invalidInput');
    expect(await codeOf(registry.assertEntryWritable(1, join(root, '.')))).toBe('invalidInput');
  });

  it('lets an entry of a listed folder be changed, existing or not', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'sub'));
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);

    await expect(registry.assertEntryWritable(1, join(root, 'sub'))).resolves.toBe(
      join(root, 'sub'),
    );
    await expect(registry.assertEntryWritable(1, join(root, 'new'))).resolves.toBe(
      join(root, 'new'),
    );
    await expect(registry.assertEntryWritable(1, join(root, 'sub', 'deeper'))).resolves.toBe(
      join(root, 'sub', 'deeper'),
    );
  });

  it('lets the folder be changed once its own parent was listed too', async () => {
    const parent = tempDir();
    const root = join(parent, 'listed');
    mkdirSync(root);
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);
    expect(await codeOf(registry.assertEntryWritable(1, root))).toBe('invalidInput');

    registry.record(1, parent);
    await expect(registry.assertEntryWritable(1, root)).resolves.toBe(root);
  });

  it('refuses a .. that climbs out of the listed folder', async () => {
    const parent = tempDir();
    const root = join(parent, 'listed');
    mkdirSync(root);
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);

    expect(await codeOf(registry.assertEntryWritable(1, join(root, '..', 'sibling')))).toBe(
      'invalidInput',
    );
    expect(await codeOf(registry.assertEntryWritable(1, join(root, 'sub', '..', '..')))).toBe(
      'invalidInput',
    );
    expect(await codeOf(registry.assertEntryWritable(2, join(root, 'x')))).toBe('invalidInput');
  });

  it('judges a junction by the folder it is in, not by where it leads', async () => {
    const root = tempDir();
    const outside = tempDir();
    const link = join(root, 'escape');
    symlinkSync(outside, link, 'junction');
    const registry = new LocalBrowseRegistry();
    registry.record(1, root);

    // The junction itself is an entry of the listed folder; what is behind it is not.
    await expect(registry.assertEntryWritable(1, link)).resolves.toBe(link);
    expect(await codeOf(registry.assertEntryWritable(1, join(link, 'inside.txt')))).toBe(
      'invalidInput',
    );
  });

  it('refuses the top of a drive or of the file system', async () => {
    const registry = new LocalBrowseRegistry();
    const top = resolve('/');
    registry.record(1, top);

    expect(await codeOf(registry.assertEntryWritable(1, top))).toBe('invalidInput');
  });
});
