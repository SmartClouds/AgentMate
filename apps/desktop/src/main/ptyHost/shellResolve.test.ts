import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import {
  defaultShellName,
  resolveShellFile,
  resolveSpawnCwd,
  resolveSpawnTarget,
  shellFallbackChain,
} from './shellResolve';

/**
 * The lookups that stand between a terminal tab and "Could not start this terminal." A Mac app
 * started from the Finder inherits a minimal environment (sometimes no SHELL at all), and users
 * uninstall shells or delete project folders out from under their tabs. Each case below is one
 * such report that must degrade to a working terminal instead of a blank pane.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('defaultShellName', () => {
  it('always starts PowerShell on Windows, whatever SHELL says', () => {
    expect(defaultShellName('win32', { SHELL: '/bin/zsh' })).toBe('powershell.exe');
    expect(defaultShellName('win32', {})).toBe('powershell.exe');
  });

  it('trusts SHELL only when it names a shell the app can start', () => {
    expect(defaultShellName('darwin', { SHELL: '/bin/zsh' })).toBe('zsh');
    expect(defaultShellName('linux', { SHELL: '/usr/bin/fish' })).toBe('fish');
    expect(defaultShellName('linux', { SHELL: '/usr/local/bin/bash' })).toBe('bash');
  });

  it('falls back to the platform shell when SHELL is missing, empty or exotic', () => {
    // A GUI launch on macOS leaves SHELL unset; a stripped environment can leave it empty.
    expect(defaultShellName('darwin', {})).toBe('zsh');
    expect(defaultShellName('darwin', { SHELL: '' })).toBe('zsh');
    expect(defaultShellName('linux', {})).toBe('bash');
    expect(defaultShellName('linux', { SHELL: '' })).toBe('bash');
    // Anything outside the allowlist (sh, dash, nu, tcsh) used to be handed to the pty as-is,
    // which failed to start when that binary was not there.
    expect(defaultShellName('darwin', { SHELL: '/bin/sh' })).toBe('zsh');
    expect(defaultShellName('linux', { SHELL: '/bin/sh' })).toBe('bash');
    expect(defaultShellName('linux', { SHELL: '/usr/local/bin/nu' })).toBe('bash');
  });
});

describe('shellFallbackChain', () => {
  it('tries what was asked for first, then the platform shells without duplicates', () => {
    expect(shellFallbackChain('fish', 'darwin')).toEqual(['fish', 'zsh', 'bash', 'sh']);
    expect(shellFallbackChain('zsh', 'darwin')).toEqual(['zsh', 'bash', 'sh']);
    expect(shellFallbackChain('bash', 'linux')).toEqual(['bash', 'sh']);
    expect(shellFallbackChain('powershell.exe', 'win32')).toEqual([
      'powershell.exe',
      'pwsh.exe',
      'cmd.exe',
    ]);
  });

  it('is just the platform shells when nothing usable was asked for', () => {
    expect(shellFallbackChain('', 'darwin')).toEqual(['zsh', 'bash', 'sh']);
    expect(shellFallbackChain('   ', 'linux')).toEqual(['bash', 'sh']);
  });
});

describe('resolveShellFile', () => {
  it('returns an existing absolute path as-is', () => {
    expect(resolveShellFile(process.execPath, process.platform, {})).toBe(process.execPath);
  });

  it('rejects an absolute path that is not there', () => {
    expect(resolveShellFile(join(tmpdir(), 'runova-no-such-shell-xyz'), 'linux', {})).toBeNull();
  });

  it('finds a bare name through PATH', () => {
    const dir = dirname(process.execPath);
    const name = basename(process.execPath);
    expect(resolveShellFile(name, process.platform, { PATH: dir })).toBe(join(dir, name));
  });

  it('finds a fake shell in a controlled PATH, on any OS', () => {
    const dir = tempDir('runova-shell-');
    writeFileSync(join(dir, 'mysh'), '#!/bin/sh\n', 'utf-8');
    expect(resolveShellFile('mysh', 'linux', { PATH: dir })).toBe(join(dir, 'mysh'));
    expect(resolveShellFile('mysh', 'darwin', { PATH: dir })).toBe(join(dir, 'mysh'));
  });

  it('returns null for a missing bare name on POSIX, so the chain moves on', () => {
    expect(resolveShellFile('runova-no-such-shell-xyz', 'linux', { PATH: '' })).toBeNull();
    expect(resolveShellFile('runova-no-such-shell-xyz', 'darwin', { PATH: '' })).toBeNull();
  });

  it('prefers a real hit over the bare name on Windows, else the bare name itself', () => {
    // Well-known folders are consulted even with an empty PATH, so on a real Windows machine
    // this resolves to the absolute PowerShell; the OS-level fallback below only matters when
    // even those are gone (or on a machine without them, like CI running another OS).
    const hit = resolveShellFile('powershell.exe', 'win32', { PATH: '' });
    expect(hit?.toLowerCase().endsWith('powershell.exe')).toBe(true);
    expect(resolveShellFile('runova-no-such-shell-xyz', 'win32', { PATH: '' })).toBe(
      'runova-no-such-shell-xyz',
    );
  });

  it('rejects blank input', () => {
    expect(resolveShellFile('', 'linux', {})).toBeNull();
    expect(resolveShellFile('   ', 'darwin', {})).toBeNull();
  });
});

describe('resolveSpawnCwd', () => {
  it('keeps a folder that exists', () => {
    const dir = tempDir('runova-cwd-');
    expect(resolveSpawnCwd(dir, { HOME: tmpdir() })).toBe(dir);
  });

  it('starts in the home folder when the tab folder was deleted, and says so', () => {
    const home = tempDir('runova-home-');
    const notes: string[] = [];
    const cwd = resolveSpawnCwd(join(home, 'deleted-project'), { HOME: home }, notes);
    expect(cwd).toBe(home);
    expect(notes.join('\n')).toContain('deleted-project');
  });

  it('uses HOME when the tab named no folder', () => {
    const home = tempDir('runova-home-');
    expect(resolveSpawnCwd(undefined, { HOME: home })).toBe(home);
  });

  it('falls back to the temp folder when HOME is unusable too', () => {
    const notes: string[] = [];
    const cwd = resolveSpawnCwd(join(tmpdir(), 'runova-no-such-dir-xyz'), { HOME: '' }, notes);
    expect(cwd).toBe(tmpdir());
    expect(notes.length).toBeGreaterThan(0);
  });

  it('rejects a path that is a file, not a folder', () => {
    const dir = tempDir('runova-cwdfile-');
    const file = join(dir, 'note.txt');
    writeFileSync(file, 'x', 'utf-8');
    expect(resolveSpawnCwd(file, { HOME: dir })).toBe(dir);
  });
});

describe('resolveSpawnTarget', () => {
  /** A controlled world: PATH holds a fake `bash`, HOME is a temp folder. */
  function hermetic() {
    const dir = tempDir('runova-spawn-');
    writeFileSync(join(dir, 'bash'), '#!/bin/sh\n', 'utf-8');
    const env = { PATH: dir, HOME: dir };
    return { dir, env };
  }

  it('passes a working shell and folder straight through, with no notes', () => {
    const { dir, env } = hermetic();
    const target = resolveSpawnTarget({ shell: 'bash', cwd: dir, platform: 'linux', env });
    expect(target).toMatchObject({ shell: 'bash', file: join(dir, 'bash'), cwd: dir });
    expect(target.notes).toEqual([]);
  });

  it('falls back to an installed shell when the requested one is gone', () => {
    const { env } = hermetic();
    const target = resolveSpawnTarget({
      shell: 'runova-no-such-shell-xyz',
      platform: 'linux',
      env,
    });
    expect(target.shell).toBe('bash');
    expect(target.file).toBe(join(env.PATH, 'bash'));
    expect(target.notes.join('\n')).toContain('runova-no-such-shell-xyz');
  });

  it('never hands a traversal or an empty shell to the pty', () => {
    const { env } = hermetic();
    for (const shell of ['../../etc/passwd', '', '   ']) {
      const target = resolveSpawnTarget({ shell, platform: 'linux', env });
      expect(target.file).not.toContain('..');
      expect(target.shell.length).toBeGreaterThan(0);
    }
  });

  it('starts in HOME when the project folder is gone, keeping the working shell', () => {
    const { dir, env } = hermetic();
    const target = resolveSpawnTarget({
      shell: 'bash',
      cwd: join(dir, 'deleted-project'),
      platform: 'linux',
      env,
    });
    expect(target).toMatchObject({ shell: 'bash', cwd: dir });
    expect(target.notes.join('\n')).toContain('deleted-project');
  });

  it('never throws, even with nothing to go on', () => {
    const target = resolveSpawnTarget({
      shell: '',
      cwd: join(tmpdir(), 'runova-no-such-dir-xyz'),
      platform: 'linux',
      env: { PATH: '', HOME: '' },
    });
    expect(target.shell.length).toBeGreaterThan(0);
    expect(target.cwd.length).toBeGreaterThan(0);
  });
});
