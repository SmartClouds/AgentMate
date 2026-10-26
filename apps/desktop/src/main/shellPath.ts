import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { posix } from 'node:path';
import { killProcessTree } from './process/spawnStreaming';
import { pathKey, refreshWindowsPath } from './windowsPath';

/**
 * A Mac app opened from Finder or the Dock does not get the PATH a terminal has. launchd hands it
 * `/usr/bin:/bin:/usr/sbin:/sbin`, and everything the user's shell profile adds (Homebrew, nvm,
 * `~/.local/bin` where Claude Code's installer puts it, npm's global prefix) is missing. So the
 * CLI Manager and the workspace showed Claude Code as not installed while every terminal ran it.
 *
 * The fix is the one a terminal does itself: start the user's login shell, let it read its
 * profile and rc files, and take the PATH it ends up with. Linux desktop launchers have the same
 * gap for anything set up in `.bashrc` (nvm most of all), so it runs there too. Windows keeps its
 * own answer, reading PATH back from the registry.
 *
 * New folders go on the end of PATH, never the front, so whatever launched the app with a
 * deliberate PATH (a dev shell, the e2e harness) still decides which copy wins.
 */

const SHELL_TIMEOUT_MS = 5000;
/** Starting a login shell costs a few hundred ms, and PATH rarely changes. */
const REFRESH_THROTTLE_MS = 30_000;
/** Shell startup files can print banners, so the PATH is fenced off from whatever else comes out. */
const MARKER = '__RUNOVA_PATH__';
/** Only ever runs on macOS and Linux, so POSIX paths, also when the tests run on Windows. */
const { delimiter, isAbsolute, join } = posix;

/**
 * Where CLI installers put things on macOS and Linux. Checked even when the shell answers, since
 * Claude Code's older local install lives in `~/.claude/local` and is reached through a shell
 * alias, which never shows up in PATH.
 */
export function wellKnownCliDirs(platform: NodeJS.Platform, home: string): string[] {
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    '/usr/local/bin',
  ];
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/opt/local/bin');
  return dirs;
}

/** The PATH between the markers, or null when the shell never got as far as printing it. */
export function parseShellPathOutput(stdout: string): string | null {
  const start = stdout.indexOf(MARKER);
  if (start < 0) return null;
  const end = stdout.indexOf(MARKER, start + MARKER.length);
  if (end < 0) return null;
  const value = stdout.slice(start + MARKER.length, end).trim();
  return value || null;
}

function loginShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.SHELL && isAbsolute(env.SHELL)) return env.SHELL;
  try {
    const { shell } = userInfo();
    if (shell && isAbsolute(shell)) return shell;
  } catch {
    // No passwd entry for this user, which happens in some containers.
  }
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

/**
 * The PATH the user's interactive login shell sets up. Interactive as well as login, because
 * installers (Claude Code's among them) append their PATH line to `.zshrc` or `.bashrc`, which a
 * login shell alone does not read.
 */
export function readLoginShellPath(
  shell: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Detached, so the shell has no terminal to wait on and the timeout can stop it and
      // anything its rc files started. oh-my-zsh would otherwise ask about updating.
      // The markers are separate printf arguments: glued to `$PATH` they would read as part of
      // the variable's name, and fish has no `${PATH}` to fence it with.
      child = spawn(shell, ['-ilc', `printf '%s%s%s' ${MARKER} "$PATH" ${MARKER}`], {
        env: { ...env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false' },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(parseShellPathOutput(stdout));
    }, SHELL_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(parseShellPathOutput(stdout)));
  });
}

export interface ShellPathOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  readShellPath: (shell: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  exists: (dir: string) => boolean;
}

/**
 * `env`'s PATH with the login shell's folders and the well-known CLI folders appended, or null
 * when there is nothing to add.
 */
export async function extendedPosixPath(options: ShellPathOptions): Promise<string | null> {
  const { env, platform } = options;
  const key = pathKey(env);
  const current = (env[key] ?? '').split(delimiter).filter(Boolean);
  const fromShell = (await options.readShellPath(loginShell(env, platform), env)) ?? '';
  const known = new Set(current.map(normalize));
  const added: string[] = [];
  const add = (dir: string): void => {
    const normalized = normalize(dir);
    if (!normalized || known.has(normalized)) return;
    known.add(normalized);
    added.push(dir);
  };
  for (const dir of fromShell.split(delimiter)) add(dir);
  for (const dir of wellKnownCliDirs(platform, options.home)) {
    if (options.exists(dir)) add(dir);
  }
  return added.length > 0 ? [...current, ...added].join(delimiter) : null;
}

function normalize(dir: string): string {
  return dir.trim().replace(/\/+$/, '');
}

let lastRefreshAt = 0;
let refreshing: Promise<void> | null = null;

/**
 * Brings this process's PATH up to what a terminal would have, so CLI detection finds what the
 * user installed and everything started from the app afterwards can run it.
 */
export async function refreshShellPath({ force = false } = {}): Promise<void> {
  if (process.platform === 'win32') return refreshWindowsPath({ force });
  if (refreshing) return refreshing;
  if (!force && Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return;
  refreshing = extendedPosixPath({
    platform: process.platform,
    env: process.env,
    home: homedir(),
    readShellPath: readLoginShellPath,
    exists: existsSync,
  })
    .then((path) => {
      if (path !== null) process.env[pathKey(process.env)] = path;
    })
    .catch(() => {
      // Keep the PATH the app has; detection then reports what it can find with it.
    })
    .finally(() => {
      lastRefreshAt = Date.now();
      refreshing = null;
    });
  return refreshing;
}
