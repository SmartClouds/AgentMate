/**
 * Keeping node-pty's macOS spawn-helper executable at runtime.
 *
 * node-pty starts every terminal on macOS through a small program, spawn-helper, that lives
 * next to its native binding. Version 1.1.0 publishes it without the execute bit, and then
 * every shell fails with the cryptic "posix_spawnp failed" no matter which shell or folder
 * was asked for.
 *
 * The desktop package's postinstall sets the bit for local development, but that only covers
 * the install it ran in. A packaged app whose copy lost the bit along the way fails at runtime
 * with no hint of the cause, so the pty host checks the helper before every spawn and repairs
 * it when it can (a fresh copy plus chmod, never a chmod in place, since pnpm hard links
 * package files to its shared store). When the bit cannot be restored the spawn fails fast
 * with the helper's path and the reason, instead of the cryptic posix_spawnp line.
 *
 * The same line also shows up when node-pty spawns through a helper path that does not exist.
 * Stock 1.1.0 did that in every packaged pty host, because it rewrote the app.asar.unpacked path
 * the host loads it from to app.asar.unpacked.unpacked. patches/node-pty@1.1.0.patch fixes that.
 *
 * Only macOS spawns through the helper (other platforms use forkpty or ConPTY), so everywhere
 * else this is a no-op. Pure apart from the default filesystem probes, which tests inject, the
 * same way resolveRipgrepPath takes its `resolve` and `exists`.
 */

import { accessSync, chmodSync, constants, copyFileSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface SpawnHelperCheck {
  ok: boolean;
  /** The helper that was checked; empty when this platform spawns another way. */
  path: string;
  /**
   * What happened, for the host log; the failure text for the terminal pane. Empty when there
   * is nothing to report, so a healthy spawn leaves no trace.
   */
  detail: string;
}

export interface SpawnHelperEnv {
  platform?: NodeJS.Platform;
  arch?: string;
  /** The node-pty package folder as the running app sees it. Defaults to resolving it. */
  nodePtyDir?: string | null;
  exists?: (path: string) => boolean;
  isExecutable?: (path: string) => boolean;
  /** Repairs a helper that lost its bit. Returns null on success, the reason on failure. */
  repair?: (path: string) => string | null;
}

function defaultExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRepair(path: string): string | null {
  try {
    const copy = `${path}.runova-tmp`;
    copyFileSync(path, copy);
    chmodSync(copy, 0o755);
    renameSync(copy, path);
    return defaultIsExecutable(path) ? null : 'still not executable after the repair';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function defaultNodePtyDir(): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return null;
  }
}

/**
 * The helpers node-pty could spawn through, in the order it prefers its bindings: a source
 * build first, then the prebuilt one for this platform. Every existing one is checked, since
 * whichever binding loads takes the helper beside it.
 */
export function spawnHelperCandidates(
  nodePtyDir: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  return [
    join(nodePtyDir, 'build', 'Release', 'spawn-helper'),
    join(nodePtyDir, 'build', 'Debug', 'spawn-helper'),
    join(nodePtyDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
  ];
}

/**
 * Makes sure a spawn-helper node-pty would use is executable, repairing the bit when it is
 * missing. Never throws: the check reports, and the spawn fails fast on the report.
 */
export function ensureSpawnHelper(env: SpawnHelperEnv = {}): SpawnHelperCheck {
  const platform = env.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { ok: true, path: '', detail: '' };
  }
  const arch = env.arch ?? process.arch;
  const exists = env.exists ?? defaultExists;
  const isExecutable = env.isExecutable ?? defaultIsExecutable;
  const repair = env.repair ?? defaultRepair;

  const nodePtyDir = env.nodePtyDir !== undefined ? env.nodePtyDir : defaultNodePtyDir();
  if (!nodePtyDir) {
    return { ok: false, path: '', detail: 'could not locate the node-pty package' };
  }
  // A helper cannot run from inside the archive, so packaging keeps a real copy beside it.
  const unpackedDir = nodePtyDir.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const dirs = unpackedDir === nodePtyDir ? [nodePtyDir] : [nodePtyDir, unpackedDir];
  const candidates = [
    ...new Set(dirs.flatMap((dir) => spawnHelperCandidates(dir, platform, arch))),
  ];
  const helpers = candidates.filter((candidate) => exists(candidate));
  if (helpers.length === 0) {
    return {
      ok: false,
      path: '',
      detail: `no node-pty spawn-helper found (looked in ${candidates.join(', ')})`,
    };
  }
  const repaired: string[] = [];
  for (const helper of helpers) {
    if (isExecutable(helper)) continue;
    const failure = repair(helper);
    if (failure) {
      return {
        ok: false,
        path: helper,
        detail:
          `node-pty spawn-helper at ${helper} is not executable and could not be repaired ` +
          `(${failure}); terminals cannot start until it is executable`,
      };
    }
    repaired.push(helper);
  }
  return {
    ok: true,
    path: helpers[0],
    detail:
      repaired.length > 0 ? `spawn-helper execute bit repaired at ${repaired.join(', ')}` : '',
  };
}
