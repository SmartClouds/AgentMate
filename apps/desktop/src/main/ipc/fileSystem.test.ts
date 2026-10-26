import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DirectoryEntry, ImageFileData } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { queueDialog } from '../../test/main/electronMock';
import { tempDir, writeTree } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The generic file IPC the renderer uses to read and write project files. Every path it takes
 * comes straight from the renderer, so the interesting half of these tests is the rejections:
 * anything outside userData or a registered project folder must never be touched.
 */

const userData = useTempUserData();
const project = { dir: '' };

expectChannelsCovered(IPC.fs);

beforeEach(async () => {
  project.dir = tempDir('runova-fs-project-');
  writeTree(project.dir, {
    'README.md': '# demo\n',
    'src/index.ts': 'export const a = 1;\n',
  });
  mkdirSync(join(project.dir, 'src', 'nested'), { recursive: true });
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Demo', folderPath: project.dir, createdAt: new Date().toISOString() },
  ]);
  await loadIpc(
    () => import('./fileSystem'),
    (module) => module.registerFileSystemHandlers(),
  );
});

describe('fs:readFile', () => {
  it('reads a file inside a registered project folder', async () => {
    expect(await invoke<string>(IPC.fs.readFile, join(project.dir, 'README.md'))).toBe('# demo\n');
  });

  it('refuses a path outside every allowed root', async () => {
    // A sibling temp folder: it exists and is readable, so only the guard stops this.
    const outside = writeTree(tempDir('runova-fs-outside-'), { 'secret.txt': 'do not read' });
    await expect(invoke(IPC.fs.readFile, join(outside, 'secret.txt'))).rejects.toThrow(
      'outside of the allowed directories',
    );
  });

  it('refuses a traversal that climbs out of the project folder', async () => {
    const climb = join(project.dir, 'src', '..', '..', 'etc-passwd-stand-in');
    writeFileSync(join(project.dir, '..', 'etc-passwd-stand-in'), 'nope', 'utf-8');
    await expect(invoke(IPC.fs.readFile, climb)).rejects.toThrow(
      'outside of the allowed directories',
    );
  });

  it('reads inside a worktree folder Runova knows about', async () => {
    // Worktrees live next to the repository, outside the project folder, by default.
    const worktree = writeTree(tempDir('runova-fs-worktree-'), { 'notes.md': 'in the tree' });
    userData.writeData('worktrees.json', [
      {
        id: 'wt-1',
        projectId: 'p1',
        path: worktree,
        branch: 'feat',
        baseBranch: 'main',
        createdAt: '2026-09-25T00:00:00.000Z',
        createdByApp: true,
      },
    ]);
    expect(await invoke<string>(IPC.fs.readFile, join(worktree, 'notes.md'))).toBe('in the tree');
  });

  it('reads the app data folder, which is an allowed root too', async () => {
    expect(await invoke<string>(IPC.fs.readFile, userData.dataFile('projects.json'))).toContain(
      'Demo',
    );
  });
});

describe('fs:readImage', () => {
  it('hands an image over as a data URL, with its size on disk', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    writeFileSync(join(project.dir, 'logo.png'), png);
    const image = await invoke<ImageFileData>(IPC.fs.readImage, join(project.dir, 'logo.png'));
    expect(image.dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(image.bytes).toBe(png.length);
  });

  it('refuses a file that is not an image', async () => {
    await expect(invoke(IPC.fs.readImage, join(project.dir, 'README.md'))).rejects.toThrow(
      'not an image',
    );
  });

  it('refuses an image past the size the viewer carries over', async () => {
    // 17 MB of zeros: over the 16 MB cap, and the guard reads the size rather than the file.
    writeFileSync(join(project.dir, 'huge.png'), Buffer.alloc(17 * 1024 * 1024));
    await expect(invoke(IPC.fs.readImage, join(project.dir, 'huge.png'))).rejects.toThrow(
      'too large to show here',
    );
  });

  it('refuses an image outside every allowed root', async () => {
    const outside = tempDir('runova-fs-outside-image-');
    writeFileSync(join(outside, 'secret.png'), Buffer.from([0]));
    await expect(invoke(IPC.fs.readImage, join(outside, 'secret.png'))).rejects.toThrow(
      'outside of the allowed directories',
    );
  });
});

describe('fs:writeFile', () => {
  it('writes inside the project and creates missing parent folders', async () => {
    const target = join(project.dir, 'docs', 'deep', 'notes.md');
    await invoke(IPC.fs.writeFile, target, 'hello');
    expect(readFileSync(target, 'utf-8')).toBe('hello');
  });

  it('refuses to write outside the allowed roots even though the parent exists', async () => {
    const outside = tempDir('runova-fs-outside-write-');
    await expect(invoke(IPC.fs.writeFile, join(outside, 'planted.txt'), 'x')).rejects.toThrow(
      'outside of the allowed directories',
    );
  });

  it('stops a write aimed at a file that does not exist yet outside the roots', async () => {
    // The guard resolves the nearest existing ancestor, so a brand new path is still checked.
    const outside = tempDir('runova-fs-outside-new-');
    await expect(invoke(IPC.fs.writeFile, join(outside, 'a', 'b', 'c.txt'), 'x')).rejects.toThrow(
      'outside of the allowed directories',
    );
  });
});

describe('fs:listDirectory', () => {
  it('lists folders before files, each alphabetically', async () => {
    const entries = await invoke<DirectoryEntry[]>(IPC.fs.listDirectory, project.dir);
    expect(entries.map((entry) => entry.name)).toEqual(['src', 'README.md']);
    expect(entries[0]).toMatchObject({ isDirectory: true, path: join(project.dir, 'src') });
    expect(entries[1].isDirectory).toBe(false);
  });

  it('refuses a directory outside the allowed roots', async () => {
    const outside = tempDir('runova-fs-outside-list-');
    await expect(invoke(IPC.fs.listDirectory, outside)).rejects.toThrow(
      'outside of the allowed directories',
    );
  });
});

describe('fs:writeScratchFile', () => {
  it('writes under userData/scratch and returns the path', async () => {
    const written = await invoke<string>(IPC.fs.writeScratchFile, 'note.txt', 'scratch body');
    expect(written).toBe(join(userData.dir, 'scratch', 'note.txt'));
    expect(readFileSync(written, 'utf-8')).toBe('scratch body');
  });

  it('flattens a traversal in the file name instead of escaping the scratch folder', async () => {
    // basename is the whole guard here, so it is worth pinning down.
    const written = await invoke<string>(
      IPC.fs.writeScratchFile,
      join('..', '..', 'escaped.txt'),
      'x',
    );
    expect(written).toBe(join(userData.dir, 'scratch', 'escaped.txt'));
  });
});

describe('fs:saveFileAs', () => {
  it('writes to the path the save dialog returned', async () => {
    const target = join(tempDir('runova-fs-save-'), 'export.json');
    queueDialog('showSaveDialog', { canceled: false, filePath: target });
    expect(await invoke<string | null>(IPC.fs.saveFileAs, 'export.json', '{"a":1}')).toBe(target);
    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}');
  });

  it('returns null and writes nothing when the dialog is cancelled', async () => {
    queueDialog('showSaveDialog', { canceled: true, filePath: undefined });
    expect(await invoke<string | null>(IPC.fs.saveFileAs, 'export.json', 'body')).toBeNull();
  });
});
