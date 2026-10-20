import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { listLocalRoots } from './localRoots';

describe('listLocalRoots', () => {
  it('offers only the drive letters that exist on Windows, in order', () => {
    const present = new Set(['C:\\', 'E:\\', 'Z:\\']);
    const checked: string[] = [];

    const roots = listLocalRoots({
      platform: 'win32',
      exists: (path) => {
        checked.push(path);
        return present.has(path);
      },
    });

    expect(roots).toEqual([
      { name: 'C:\\', path: 'C:\\', kind: 'drive' },
      { name: 'E:\\', path: 'E:\\', kind: 'drive' },
      { name: 'Z:\\', path: 'Z:\\', kind: 'drive' },
    ]);
    expect(checked).toHaveLength(26);
    expect(checked[0]).toBe('A:\\');
  });

  it('offers no roots on Windows when no drive answers', () => {
    expect(listLocalRoots({ platform: 'win32', exists: () => false })).toEqual([]);
  });

  it('offers Home and the filesystem root elsewhere', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(listLocalRoots({ platform, home: () => '/home/me' })).toEqual([
        { name: 'Home', path: '/home/me', kind: 'home' },
        { name: '/', path: '/', kind: 'root' },
      ]);
    }
  });

  it('reads the platform and home folder when it is called, not when it is loaded', () => {
    const roots = listLocalRoots({ platform: 'linux' });
    expect(roots[0]).toEqual({ name: 'Home', path: homedir(), kind: 'home' });
  });

  it.runIf(process.platform === 'win32')('finds the real system drive by default', () => {
    const roots = listLocalRoots();
    const system = `${(process.env.SystemDrive ?? 'C:').toUpperCase()}\\`;
    expect(roots.map((root) => root.path)).toContain(system);
  });
});
