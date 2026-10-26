import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ExplorerDeleteResult,
  ExplorerGitignoreResult,
  ExplorerTransferResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { initGitRepo, tempDir, withPlatform } from '../../test/main/fixtures';
import {
  electronState,
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The file explorer's write side. Everything here takes a path the renderer chose, so each handler
 * has to re-derive the project folder from the project id and refuse anything that does not land
 * inside it. Real files in a real git repository, because the gitignore and untrack paths are
 * only meaningful against git's own idea of what is tracked.
 */

const userData = useTempUserData();
const repo = { dir: '', git: (..._args: string[]) => '' };
const PROJECT_ID = 'p1';

expectChannelsCovered(IPC.explorer);

/** A path inside the project folder. */
function at(...segments: string[]): string {
  return join(repo.dir, ...segments);
}

beforeEach(async () => {
  const created = initGitRepo({
    'README.md': '# demo\n',
    'src/index.ts': 'export const a = 1;\n',
    'src/nested/keep.txt': 'keep\n',
    'sub/a.txt': 'in sub\n',
    'a.txt': 'at root\n',
  });
  repo.dir = created.dir;
  repo.git = created.git;
  userData.writeData('projects.json', [
    { id: PROJECT_ID, name: 'Demo', folderPath: created.dir, createdAt: '2026-01-01T00:00:00Z' },
  ]);
  await loadIpc(
    () => import('./explorer'),
    (module) => module.registerExplorerHandlers(),
  );
});

describe('explorer path guards', () => {
  it('refuses a project id it does not know', async () => {
    await expect(invoke(IPC.explorer.createFile, 'nope', repo.dir, 'x.txt')).rejects.toThrow(
      'That project no longer exists.',
    );
  });

  it('refuses a parent folder outside the project', async () => {
    const outside = tempDir('runova-explorer-outside-');
    await expect(
      invoke(IPC.explorer.createFile, PROJECT_ID, outside, 'planted.txt'),
    ).rejects.toThrow('outside of the allowed directories');
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
  });

  it('refuses a name that walks up out of the parent folder', async () => {
    await expect(
      invoke(IPC.explorer.createFile, PROJECT_ID, repo.dir, '../escaped.txt'),
    ).rejects.toThrow('".." is not a valid name.');
  });

  it('refuses an absolute name', async () => {
    await expect(
      invoke(IPC.explorer.createFolder, PROJECT_ID, repo.dir, '/etc/cron.d'),
    ).rejects.toThrow('cannot start with a slash');
  });

  it('refuses a path containing a NUL byte', async () => {
    await expect(
      invoke(IPC.explorer.rename, PROJECT_ID, `${at('a.txt')}\0.png`, 'b.txt'),
    ).rejects.toThrow('That path is not valid.');
  });

  it('refuses a parent that is a file rather than a folder', async () => {
    await expect(invoke(IPC.explorer.createFile, PROJECT_ID, at('a.txt'), 'x.txt')).rejects.toThrow(
      'The target is not a folder.',
    );
  });

  it('will not rename or delete the project folder itself', async () => {
    await expect(invoke(IPC.explorer.rename, PROJECT_ID, repo.dir, 'renamed')).rejects.toThrow(
      'The project folder itself cannot be changed from here.',
    );
    await expect(invoke(IPC.explorer.delete, PROJECT_ID, [repo.dir])).rejects.toThrow(
      'The project folder itself cannot be changed from here.',
    );
  });

  it('refuses an entry outside the project even when its parent exists', async () => {
    const outside = tempDir('runova-explorer-outside-entry-');
    writeFileSync(join(outside, 'victim.txt'), 'x', 'utf-8');
    await expect(
      invoke(IPC.explorer.delete, PROJECT_ID, [join(outside, 'victim.txt')], { permanent: true }),
    ).rejects.toThrow('outside of the allowed directories');
    expect(existsSync(join(outside, 'victim.txt'))).toBe(true);
  });

  it('refuses an empty list and a list too long to have come from the explorer', async () => {
    await expect(invoke(IPC.explorer.delete, PROJECT_ID, [])).rejects.toThrow(
      'No files were given.',
    );
    await expect(invoke(IPC.explorer.delete, PROJECT_ID, 'a.txt')).rejects.toThrow(
      'No files were given.',
    );
    const tooMany = Array.from({ length: 5001 }, (_, index) => at(`f${index}.txt`));
    await expect(invoke(IPC.explorer.delete, PROJECT_ID, tooMany)).rejects.toThrow(
      'No files were given.',
    );
  });

  it('reports a missing entry instead of failing further in', async () => {
    await expect(invoke(IPC.explorer.rename, PROJECT_ID, at('ghost.txt'), 'x.txt')).rejects.toThrow(
      '"ghost.txt" no longer exists.',
    );
  });
});

describe('explorer:createFile and explorer:createFolder', () => {
  it('creates an empty file', async () => {
    const created = await invoke<string>(IPC.explorer.createFile, PROJECT_ID, repo.dir, 'new.ts');
    expect(created).toBe(at('new.ts'));
    expect(readFileSync(created, 'utf-8')).toBe('');
  });

  it('creates the folders a nested name asks for', async () => {
    const created = await invoke<string>(
      IPC.explorer.createFile,
      PROJECT_ID,
      repo.dir,
      'docs/guide/intro.md',
    );
    expect(created).toBe(at('docs', 'guide', 'intro.md'));
    expect(existsSync(created)).toBe(true);
  });

  it('reads a trailing slash as a folder, the way VS Code does', async () => {
    const created = await invoke<string>(IPC.explorer.createFile, PROJECT_ID, repo.dir, 'assets/');
    expect(existsSync(created)).toBe(true);
    expect(readFileSync(at('a.txt'), 'utf-8')).toBe('at root\n');
  });

  it('refuses to overwrite something already there', async () => {
    await expect(
      invoke(IPC.explorer.createFile, PROJECT_ID, repo.dir, 'README.md'),
    ).rejects.toThrow('already exists at this location');
    expect(readFileSync(at('README.md'), 'utf-8')).toBe('# demo\n');
  });

  it('creates a folder, and refuses a second one by the same name', async () => {
    const created = await invoke<string>(
      IPC.explorer.createFolder,
      PROJECT_ID,
      at('src'),
      'components',
    );
    expect(created).toBe(at('src', 'components'));
    await expect(
      invoke(IPC.explorer.createFolder, PROJECT_ID, at('src'), 'components'),
    ).rejects.toThrow('already exists at this location');
  });
});

describe('explorer:rename', () => {
  it('renames a file in place', async () => {
    const target = await invoke<string>(
      IPC.explorer.rename,
      PROJECT_ID,
      at('a.txt'),
      'renamed.txt',
    );
    expect(target).toBe(at('renamed.txt'));
    expect(existsSync(at('a.txt'))).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('at root\n');
  });

  it('accepts a rename to the same name as a no-op', async () => {
    expect(await invoke<string>(IPC.explorer.rename, PROJECT_ID, at('a.txt'), 'a.txt')).toBe(
      at('a.txt'),
    );
  });

  it('refuses a name that would clash with another entry', async () => {
    await expect(invoke(IPC.explorer.rename, PROJECT_ID, at('a.txt'), 'README.md')).rejects.toThrow(
      'already exists at this location',
    );
  });

  it('refuses a new name with a slash in it', async () => {
    await expect(invoke(IPC.explorer.rename, PROJECT_ID, at('a.txt'), 'sub/a.txt')).rejects.toThrow(
      'cannot contain slashes',
    );
  });

  it('allows a case-only rename, which finds itself on Windows and macOS', async () => {
    const target = await invoke<string>(
      IPC.explorer.rename,
      PROJECT_ID,
      at('README.md'),
      'readme.MD',
    );
    expect(target).toBe(at('readme.MD'));
    expect(readFileSync(target, 'utf-8')).toBe('# demo\n');
  });
});

describe('explorer:delete', () => {
  it('removes an entry outright when the caller asked for permanent', async () => {
    const result = await invoke<ExplorerDeleteResult>(
      IPC.explorer.delete,
      PROJECT_ID,
      [at('src')],
      { permanent: true },
    );
    expect(result.failed).toEqual([]);
    expect(existsSync(at('src'))).toBe(false);
  });

  it('collapses a selection to its top-level entries before deleting', async () => {
    // The renderer can send a folder and things inside it; deleting the children afterwards
    // would fail, so only the outermost paths are acted on.
    const result = await invoke<ExplorerDeleteResult>(
      IPC.explorer.delete,
      PROJECT_ID,
      [at('src'), at('src', 'index.ts'), at('src', 'nested')],
      { permanent: true },
    );
    expect(result.failed).toEqual([]);
    expect(existsSync(at('src'))).toBe(false);
  });

  it('goes through the OS trash by default', async () => {
    // The electron stand-in accepts trashItem without removing anything, which is exactly what
    // this asserts: nothing was force-removed behind the trash call.
    const result = await invoke<ExplorerDeleteResult>(IPC.explorer.delete, PROJECT_ID, [
      at('a.txt'),
    ]);
    expect(result.failed).toEqual([]);
    expect(existsSync(at('a.txt'))).toBe(true);
  });
});

describe('explorer:copy', () => {
  it('copies into a folder and renames the copy when the name is taken', async () => {
    const result = await invoke<ExplorerTransferResult>(
      IPC.explorer.copy,
      PROJECT_ID,
      [at('a.txt')],
      repo.dir,
    );
    expect(result.conflicts).toEqual([]);
    expect(result.moves).toEqual([{ from: at('a.txt'), to: at('a copy.txt') }]);
    expect(readFileSync(at('a copy.txt'), 'utf-8')).toBe('at root\n');
  });

  it('copies a folder tree into another folder', async () => {
    const result = await invoke<ExplorerTransferResult>(
      IPC.explorer.copy,
      PROJECT_ID,
      [at('src', 'nested')],
      at('sub'),
    );
    expect(result.moves).toEqual([{ from: at('src', 'nested'), to: at('sub', 'nested') }]);
    expect(readFileSync(at('sub', 'nested', 'keep.txt'), 'utf-8')).toBe('keep\n');
  });

  it('refuses to copy a folder into itself', async () => {
    await expect(
      invoke(IPC.explorer.copy, PROJECT_ID, [at('src')], at('src', 'nested')),
    ).rejects.toThrow('Cannot copy "src" into itself.');
  });
});

describe('explorer:move', () => {
  it('moves an entry into another folder', async () => {
    const result = await invoke<ExplorerTransferResult>(
      IPC.explorer.move,
      PROJECT_ID,
      [at('src', 'index.ts')],
      at('sub'),
    );
    expect(result.moves).toEqual([{ from: at('src', 'index.ts'), to: at('sub', 'index.ts') }]);
    expect(existsSync(at('src', 'index.ts'))).toBe(false);
    expect(readFileSync(at('sub', 'index.ts'), 'utf-8')).toBe('export const a = 1;\n');
  });

  it('reports a clash instead of overwriting, then overwrites when told to', async () => {
    const asked = await invoke<ExplorerTransferResult>(
      IPC.explorer.move,
      PROJECT_ID,
      [at('a.txt')],
      at('sub'),
    );
    expect(asked).toEqual({ moves: [], conflicts: ['a.txt'] });
    expect(readFileSync(at('sub', 'a.txt'), 'utf-8')).toBe('in sub\n');

    const forced = await invoke<ExplorerTransferResult>(
      IPC.explorer.move,
      PROJECT_ID,
      [at('a.txt')],
      at('sub'),
      { overwrite: true },
    );
    expect(forced.moves).toEqual([{ from: at('a.txt'), to: at('sub', 'a.txt') }]);
    expect(readFileSync(at('sub', 'a.txt'), 'utf-8')).toBe('at root\n');
  });

  it('does nothing when the entry is dropped back into the folder it is already in', async () => {
    const result = await invoke<ExplorerTransferResult>(
      IPC.explorer.move,
      PROJECT_ID,
      [at('a.txt')],
      repo.dir,
    );
    expect(result).toEqual({ moves: [], conflicts: [] });
    expect(existsSync(at('a.txt'))).toBe(true);
  });

  it('refuses to move a folder inside itself', async () => {
    await expect(
      invoke(IPC.explorer.move, PROJECT_ID, [at('src')], at('src', 'nested')),
    ).rejects.toThrow('Cannot move "src" into itself.');
  });
});

describe('explorer:pasteExternal', () => {
  it('copies an external file into the target folder and reports it in `moves`', async () => {
    const outside = tempDir('runova-explorer-external-');
    const source = join(outside, 'brought-in.txt');
    writeFileSync(source, 'from outside\n', 'utf-8');

    const result = await invoke<ExplorerTransferResult>(
      IPC.explorer.pasteExternal,
      PROJECT_ID,
      [source],
      repo.dir,
    );
    expect(result.conflicts).toEqual([]);
    expect(result.moves).toEqual([{ from: source, to: at('brought-in.txt') }]);
    expect(readFileSync(at('brought-in.txt'), 'utf-8')).toBe('from outside\n');
  });

  it("auto-renames when the external file's name is already taken, the same as an internal copy", async () => {
    const outside = tempDir('runova-explorer-external-');
    const source = join(outside, 'a.txt');
    writeFileSync(source, 'outside a\n', 'utf-8');

    const result = await invoke<ExplorerTransferResult>(
      IPC.explorer.pasteExternal,
      PROJECT_ID,
      [source],
      repo.dir,
    );
    expect(result.moves).toEqual([{ from: source, to: at('a copy.txt') }]);
    expect(readFileSync(at('a.txt'), 'utf-8')).toBe('at root\n');
    expect(readFileSync(at('a copy.txt'), 'utf-8')).toBe('outside a\n');
  });

  it('copies an external folder tree into the project', async () => {
    const outside = tempDir('runova-explorer-external-');
    mkdirSync(join(outside, 'nested'), { recursive: true });
    writeFileSync(join(outside, 'nested', 'keep.txt'), 'keep\n', 'utf-8');

    const result = await invoke<ExplorerTransferResult>(
      IPC.explorer.pasteExternal,
      PROJECT_ID,
      [join(outside, 'nested')],
      at('sub'),
    );
    expect(result.moves).toEqual([{ from: join(outside, 'nested'), to: at('sub', 'nested') }]);
    expect(readFileSync(at('sub', 'nested', 'keep.txt'), 'utf-8')).toBe('keep\n');
  });

  it('refuses when the target folder is outside the project', async () => {
    const outside = tempDir('runova-explorer-external-');
    const source = join(outside, 'x.txt');
    writeFileSync(source, 'x', 'utf-8');
    const elsewhere = tempDir('runova-explorer-external-target-');

    await expect(
      invoke(IPC.explorer.pasteExternal, PROJECT_ID, [source], elsewhere),
    ).rejects.toThrow('outside of the allowed directories');
  });

  it('refuses a source that no longer exists', async () => {
    const outside = tempDir('runova-explorer-external-');

    await expect(
      invoke(IPC.explorer.pasteExternal, PROJECT_ID, [join(outside, 'ghost.txt')], repo.dir),
    ).rejects.toThrow('no longer exists.');
  });
});

describe('explorer:osClipboardPaths', () => {
  it('returns the paths the OS clipboard currently holds', async () => {
    const electron = (await import('electron')) as unknown as {
      clipboard: { read: (format: string) => string };
    };
    electron.clipboard.read = (format) =>
      format === 'text/uri-list' ? 'file:///tmp/copied.txt' : '';

    const paths = await withPlatform('linux', () =>
      invoke<string[]>(IPC.explorer.osClipboardPaths),
    );
    expect(paths).toEqual(['/tmp/copied.txt']);
  });

  it('returns an empty list when the OS clipboard holds no files', async () => {
    const electron = (await import('electron')) as unknown as {
      clipboard: { read: (format: string) => string };
    };
    electron.clipboard.read = () => '';

    const paths = await withPlatform('linux', () =>
      invoke<string[]>(IPC.explorer.osClipboardPaths),
    );
    expect(paths).toEqual([]);
  });
});

describe('explorer:revealInOs', () => {
  it('shows the entry in the OS file manager', async () => {
    await invoke(IPC.explorer.revealInOs, PROJECT_ID, at('src', 'index.ts'));
    expect(electronState.openedPaths).toEqual([at('src', 'index.ts')]);
  });

  it('refuses a path outside the project', async () => {
    const outside = tempDir('runova-explorer-reveal-');
    await expect(invoke(IPC.explorer.revealInOs, PROJECT_ID, outside)).rejects.toThrow(
      'outside of the allowed directories',
    );
    expect(electronState.openedPaths).toEqual([]);
  });
});

describe('explorer:addToGitignore', () => {
  it('anchors a file to the repo root and reports that git tracks it', async () => {
    const result = await invoke<ExplorerGitignoreResult>(
      IPC.explorer.addToGitignore,
      PROJECT_ID,
      at('src', 'index.ts'),
      'path',
    );
    expect(result).toEqual({ line: '/src/index.ts', added: true, tracked: true });
    expect(readFileSync(at('.gitignore'), 'utf-8')).toBe('/src/index.ts\n');
  });

  it('adds a trailing slash for a folder, and says so only once', async () => {
    const first = await invoke<ExplorerGitignoreResult>(
      IPC.explorer.addToGitignore,
      PROJECT_ID,
      at('src', 'nested'),
      'path',
    );
    expect(first).toMatchObject({ line: '/src/nested/', added: true });
    const again = await invoke<ExplorerGitignoreResult>(
      IPC.explorer.addToGitignore,
      PROJECT_ID,
      at('src', 'nested'),
      'path',
    );
    expect(again.added).toBe(false);
    expect(readFileSync(at('.gitignore'), 'utf-8')).toBe('/src/nested/\n');
  });

  it('ignores every file with the same extension when asked for the extension pattern', async () => {
    const result = await invoke<ExplorerGitignoreResult>(
      IPC.explorer.addToGitignore,
      PROJECT_ID,
      at('a.txt'),
      'extension',
    );
    expect(result.line).toBe('*.txt');
  });

  it('explains that a folder has no extension to ignore', async () => {
    await expect(
      invoke(IPC.explorer.addToGitignore, PROJECT_ID, at('src'), 'extension'),
    ).rejects.toThrow('This file has no extension to ignore.');
  });
});

describe('explorer:untrack', () => {
  it('drops the entry from the index but leaves it on disk', async () => {
    await invoke(IPC.explorer.untrack, PROJECT_ID, at('src', 'index.ts'));
    expect(repo.git('ls-files')).not.toContain('src/index.ts');
    expect(existsSync(at('src', 'index.ts'))).toBe(true);
  });
});

describe('explorer:listFiles', () => {
  it('lists the project files for the search box', async () => {
    const index = await invoke<{ root: string; files: string[] }>(
      IPC.explorer.listFiles,
      PROJECT_ID,
    );
    expect(index.root).toBe(repo.dir);
    expect(index.files).toContain('src/nested/keep.txt');
  });

  it('refuses a project id it does not know', async () => {
    await expect(invoke(IPC.explorer.listFiles, 'nope')).rejects.toThrow(
      'That project no longer exists.',
    );
  });
});

describe('explorer:ignoredPaths', () => {
  it('reports which of the given paths git ignores', async () => {
    mkdirSync(at('build'), { recursive: true });
    writeFileSync(at('build', 'out.js'), 'x', 'utf-8');
    writeFileSync(at('.gitignore'), '/build/\n', 'utf-8');

    const ignored = await invoke<string[]>(IPC.explorer.ignoredPaths, PROJECT_ID, [
      at('build'),
      at('build', 'out.js'),
      at('README.md'),
    ]);
    expect(ignored).toContain(at('build'));
    expect(ignored).not.toContain(at('README.md'));
  });

  it('returns nothing for an empty list, without touching git', async () => {
    expect(await invoke<string[]>(IPC.explorer.ignoredPaths, PROJECT_ID, [])).toEqual([]);
  });

  it('skips paths that are not inside the project folder', async () => {
    const outside = tempDir('runova-explorer-ignored-');
    expect(
      await invoke<string[]>(IPC.explorer.ignoredPaths, PROJECT_ID, [join(outside, 'x.js')]),
    ).toEqual([]);
  });
});

describe('explorer in a worktree workspace', () => {
  function addWorktree(): { scope: string; dir: string } {
    const dir = join(tempDir('runova-explorer-wt-'), 'feat');
    repo.git('worktree', 'add', '-b', 'feat', dir);
    userData.writeData('worktrees.json', [
      {
        id: 'wt-1',
        projectId: PROJECT_ID,
        path: dir,
        branch: 'feat',
        baseBranch: 'main',
        createdAt: '2026-09-25T00:00:00.000Z',
        createdByApp: true,
      },
    ]);
    return { scope: `${PROJECT_ID}~wt-1`, dir };
  }

  it('writes inside the worktree when given its scope id', async () => {
    const { scope, dir } = addWorktree();
    await invoke(IPC.explorer.createFile, scope, dir, 'made-here.txt');
    expect(existsSync(join(dir, 'made-here.txt'))).toBe(true);
  });

  it('keeps a worktree workspace out of the main checkout', async () => {
    const { scope } = addWorktree();
    await expect(invoke(IPC.explorer.createFile, scope, repo.dir, 'stray.txt')).rejects.toThrow(
      'outside of the allowed directories',
    );
    expect(existsSync(join(repo.dir, 'stray.txt'))).toBe(false);
  });
});
