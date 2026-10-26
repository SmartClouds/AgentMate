import { writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/main/fixtures';
import {
  extendedPosixPath,
  parseShellPathOutput,
  readLoginShellPath,
  type ShellPathOptions,
  wellKnownCliDirs,
} from './shellPath';

/**
 * A Mac app opened from Finder starts with launchd's bare PATH, so Claude Code in ~/.local/bin
 * (put there through .zshrc) read as not installed. These pin how the app gets back the PATH a
 * terminal would have. Paths are written POSIX style because this only runs on macOS and Linux.
 */

/** What launchd gives an app opened from Finder or the Dock. */
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const HOME = '/Users/sam';

function options(overrides: Partial<ShellPathOptions> = {}): ShellPathOptions {
  return {
    platform: 'darwin',
    env: { PATH: FINDER_PATH, SHELL: '/bin/zsh', HOME },
    home: HOME,
    readShellPath: async () => null,
    exists: () => false,
    ...overrides,
  };
}

describe('extendedPosixPath', () => {
  it("adds the login shell's folders to a Finder-launched app's PATH, after what it had", async () => {
    const readShellPath = vi.fn(
      async () =>
        `${HOME}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:${HOME}/.nvm/versions/node/v22.0.0/bin`,
    );

    const path = await extendedPosixPath(options({ readShellPath }));

    expect(readShellPath).toHaveBeenCalledWith('/bin/zsh', expect.objectContaining({ HOME }));
    expect(path?.split(':')).toEqual([
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      `${HOME}/.local/bin`,
      '/opt/homebrew/bin',
      `${HOME}/.nvm/versions/node/v22.0.0/bin`,
    ]);
  });

  it('falls back to the folders CLI installers use when the shell does not answer', async () => {
    const present = new Set([`${HOME}/.local/bin`, `${HOME}/.claude/local`, '/opt/homebrew/bin']);

    const path = await extendedPosixPath(options({ exists: (dir) => present.has(dir) }));

    expect(path?.split(':')).toEqual([
      ...FINDER_PATH.split(':'),
      `${HOME}/.local/bin`,
      `${HOME}/.claude/local`,
      '/opt/homebrew/bin',
    ]);
  });

  it("adds Claude Code's older local install even when the shell answered, since it is only an alias", async () => {
    const path = await extendedPosixPath(
      options({
        readShellPath: async () => '/opt/homebrew/bin:/usr/bin',
        exists: (dir) => dir === `${HOME}/.claude/local`,
      }),
    );

    expect(path?.split(':')).toEqual([
      ...FINDER_PATH.split(':'),
      '/opt/homebrew/bin',
      `${HOME}/.claude/local`,
    ]);
  });

  it('changes nothing when the app already has the shell PATH, as when started from a terminal', async () => {
    const full = `${HOME}/.local/bin:/opt/homebrew/bin:${FINDER_PATH}`;

    const path = await extendedPosixPath(
      options({
        env: { PATH: full, SHELL: '/bin/zsh' },
        readShellPath: async () => `${full}:/opt/homebrew/bin/`,
        exists: (dir) => dir === `${HOME}/.local/bin`,
      }),
    );

    expect(path).toBeNull();
  });

  it('asks zsh on a Mac with no SHELL set', async () => {
    const readShellPath = vi.fn(async () => null);

    await extendedPosixPath(options({ env: { PATH: FINDER_PATH }, readShellPath }));

    const [shell] = readShellPath.mock.calls[0] as unknown as [string];
    expect(shell.startsWith('/')).toBe(true);
  });

  it('lists Homebrew among the fallback folders only on macOS', () => {
    expect(wellKnownCliDirs('darwin', HOME)).toContain('/opt/homebrew/bin');
    expect(wellKnownCliDirs('linux', HOME)).not.toContain('/opt/homebrew/bin');
    expect(wellKnownCliDirs('linux', HOME)).toContain(posix.join(HOME, '.local', 'bin'));
  });
});

describe('parseShellPathOutput', () => {
  it('takes the PATH from between the markers, ignoring what rc files print around it', () => {
    const stdout =
      'Last login: Fri\nWelcome back!\n__RUNOVA_PATH__/a/bin:/b/bin__RUNOVA_PATH__bye\n';

    expect(parseShellPathOutput(stdout)).toBe('/a/bin:/b/bin');
  });

  it('answers null when the shell stopped before printing the PATH', () => {
    expect(parseShellPathOutput('')).toBeNull();
    expect(parseShellPathOutput('__RUNOVA_PATH__/a/bin')).toBeNull();
    expect(parseShellPathOutput('__RUNOVA_PATH____RUNOVA_PATH__')).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('readLoginShellPath with a real shell', () => {
  it('reads the PATH an interactive shell sets up in its rc file', async () => {
    // `sh -i` reads the file named by $ENV, the closest POSIX sh has to .zshrc, which is where
    // Claude Code's installer adds ~/.local/bin.
    const home = tempDir('runova-shell-home-');
    const rc = join(home, '.shrc');
    writeFileSync(rc, `echo "hello from rc"\nPATH="$PATH:${home}/.local/bin"\n`);

    const path = await readLoginShellPath('/bin/sh', {
      PATH: '/usr/bin:/bin',
      HOME: home,
      ENV: rc,
    });

    expect(path?.split(':')).toContain(`${home}/.local/bin`);
    expect(path?.split(':')).toContain('/usr/bin');
  });

  it('answers null for a shell that is not there', async () => {
    await expect(readLoginShellPath('/no/such/shell', { PATH: '/usr/bin' })).resolves.toBeNull();
  });
});
