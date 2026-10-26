import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tempDir.js';
import { checkStorageRoot, isWithin, type RootProblem, syncServiceOf } from './storageRoot.js';

const tempDir = useTempDirs();
const codes = (problems: RootProblem[]) => problems.map((p) => p.code);
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

describe('checkStorageRoot', () => {
  it('accepts a writable folder outside the project, even one that does not exist yet', async () => {
    const base = await tempDir();
    const project = join(base, 'project');
    await mkdir(project);
    const result = await checkStorageRoot(join(base, 'Studio', 'My project'), {
      projectFolder: project,
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('refuses a relative path', async () => {
    const result = await checkStorageRoot('studio/videos', {});
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(['relative']);
  });

  it('refuses the project folder itself and anything inside it', async () => {
    const project = await tempDir();
    for (const root of [project, join(project, 'videos'), join(project, 'a', 'b')]) {
      const result = await checkStorageRoot(root, { projectFolder: project });
      expect(result.ok, root).toBe(false);
      expect(codes(result.problems)).toContain('inside-project');
    }
  });

  it('sees through a symlink or junction that points into the project', async () => {
    const base = await tempDir();
    const project = join(base, 'project');
    await mkdir(join(project, 'media'), { recursive: true });
    const link = join(base, 'looks-outside');
    await symlink(join(project, 'media'), link, LINK_TYPE);
    const result = await checkStorageRoot(join(link, 'videos'), { projectFolder: project });
    expect(codes(result.problems)).toContain('inside-project');
  });

  it('warns, without refusing, when the project sits inside the storage folder', async () => {
    const base = await tempDir();
    const project = join(base, 'code', 'project');
    await mkdir(project, { recursive: true });
    const result = await checkStorageRoot(base, { projectFolder: project });
    expect(result.ok).toBe(true);
    expect(codes(result.problems)).toEqual(['contains-project']);
  });

  it('refuses the app install folder', async () => {
    const appDir = await tempDir();
    const result = await checkStorageRoot(join(appDir, 'resources'), { appDir });
    expect(codes(result.problems)).toContain('app-folder');
  });

  it('refuses a folder it cannot write to', async () => {
    const base = await tempDir();
    const result = await checkStorageRoot(join(base, 'x'), {
      probeWrite: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    expect(codes(result.problems)).toEqual(['not-writable']);
  });

  it('warns about a cloud-synced folder', async () => {
    const base = await tempDir();
    const synced = join(base, 'OneDrive', 'Videos');
    const result = await checkStorageRoot(synced, {});
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([
      expect.objectContaining({
        code: 'synced',
        level: 'warning',
        message: expect.stringContaining('OneDrive'),
      }),
    ]);
  });

  it('warns when free space is low', async () => {
    const base = await tempDir();
    const result = await checkStorageRoot(base, { freeBytes: async () => 100 * 1024 * 1024 });
    expect(codes(result.problems)).toEqual(['low-space']);
  });

  it('gives the folder as it really is on disk', async () => {
    const base = await tempDir();
    const real = join(base, 'real');
    await mkdir(real);
    const link = join(base, 'link');
    await symlink(real, link, LINK_TYPE);
    const result = await checkStorageRoot(join(link, 'new'), {});
    expect(result.resolved.toLowerCase()).toBe(join(real, 'new').toLowerCase());
  });
});

describe('checkStorageRoot system folders', () => {
  it('refuses Windows system folders', async () => {
    const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
    for (const root of ['C:\\Windows\\Studio', 'c:\\program files\\Studio']) {
      const result = await checkStorageRoot(root, {
        platform: 'win32',
        env,
        probeWrite: async () => undefined,
      });
      expect(codes(result.problems), root).toContain('system-folder');
    }
  });

  it('refuses POSIX system folders, but not a home folder', async () => {
    for (const root of ['/', '/usr/local/studio', '/etc/studio', '/System/Library/x']) {
      const result = await checkStorageRoot(root, {
        platform: 'darwin',
        probeWrite: async () => undefined,
      });
      expect(codes(result.problems), root).toContain('system-folder');
    }
    const home = await checkStorageRoot('/Users/me/Movies/Studio', {
      platform: 'darwin',
      probeWrite: async () => undefined,
    });
    expect(codes(home.problems)).not.toContain('system-folder');
  });

  it("treats the user's own temp folder as theirs, though macOS keeps it under /private", async () => {
    const tempDir = '/private/var/folders/ab/xyz/T';
    const inTemp = await checkStorageRoot(`${tempDir}/runova-e2e-1/Videos`, {
      platform: 'darwin',
      tempDir,
      probeWrite: async () => undefined,
    });
    expect(codes(inTemp.problems)).not.toContain('system-folder');
    for (const root of ['/private/var/db/studio', '/private/etc/studio', '/var/log/studio']) {
      const result = await checkStorageRoot(root, {
        platform: 'darwin',
        tempDir,
        probeWrite: async () => undefined,
      });
      expect(codes(result.problems), root).toContain('system-folder');
    }
  });

  it('warns about a network share', async () => {
    const result = await checkStorageRoot('\\\\nas\\media\\studio', {
      platform: 'win32',
      probeWrite: async () => undefined,
    });
    expect(codes(result.problems)).toContain('network');
  });
});

describe('isWithin', () => {
  it('compares paths case-insensitively on Windows only', () => {
    expect(isWithin('C:\\Code\\App\\x', 'c:\\code\\app', 'win32')).toBe(true);
    expect(isWithin('/code/App/x', '/code/app', 'linux')).toBe(false);
    expect(isWithin('/code/app', '/code/app', 'linux')).toBe(true);
    expect(isWithin('/code/apple', '/code/app', 'linux')).toBe(false);
    expect(isWithin('D:\\x', 'C:\\x', 'win32')).toBe(false);
  });
});

describe('syncServiceOf', () => {
  it('names the sync service a folder belongs to', () => {
    expect(syncServiceOf('C:\\Users\\me\\OneDrive\\Documents', 'win32', {})).toBe('OneDrive');
    expect(syncServiceOf('C:\\Users\\me\\OneDrive - Contoso\\x', 'win32', {})).toBe('OneDrive');
    expect(syncServiceOf('/Users/me/Dropbox/x', 'darwin', {})).toBe('Dropbox');
    expect(
      syncServiceOf('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/x', 'darwin', {}),
    ).toBe('iCloud Drive');
    expect(syncServiceOf('G:\\My Drive\\x', 'win32', {})).toBe('Google Drive');
    expect(syncServiceOf('D:\\Sync\\x', 'win32', { OneDrive: 'D:\\Sync' })).toBe('OneDrive');
    expect(
      syncServiceOf('C:\\Users\\me\\Videos', 'win32', { OneDrive: 'C:\\Users\\me\\OneDrive' }),
    ).toBeNull();
  });
});
