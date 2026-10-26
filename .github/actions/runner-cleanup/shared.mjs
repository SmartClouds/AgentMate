// Helpers for main.mjs and post.mjs. Plain Node, no dependencies: the runner runs these with its
// own Node before (and after) anything is installed.

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Every job's temp folder is <TEMP_ROOT>/runova-ci-XXXXXX. */
export const TEMP_PREFIX = 'runova-ci-';
/** Folders left by jobs from before the rename to Runova. */
export const LEGACY_TEMP_PREFIX = 'agentmate-ci-'; // legacy-name

/**
 * Directly under /tmp rather than in the runner's own temp folder: macOS caps Unix socket paths at
 * 104 bytes, and the tests make sockets in their temp folders. /tmp itself is a symlink on macOS,
 * so the real path, which is what a process's working directory reports anyway.
 */
export const TEMP_ROOT = '/tmp';

/** Why this job gets no cleanup, or null when it does. */
export function skipReason() {
  if (process.env.RUNNER_ENVIRONMENT !== 'self-hosted') {
    return 'GitHub-hosted runners start clean every job.';
  }
  if (process.platform === 'win32') return 'There is no Windows version of this cleanup.';
  return null;
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...options });
}

export function warn(message) {
  console.log(`::warning title=Runner cleanup::${message}`);
}

let dockerChecked;

/** True on Linux when this user can reach the Docker daemon. The Mac runs no Docker jobs. */
export function dockerWorks() {
  if (dockerChecked === undefined) {
    dockerChecked =
      process.platform === 'linux' &&
      run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 }).status === 0;
  }
  return dockerChecked;
}

/**
 * Deletes a folder and everything in it. Test containers write into bind-mounted temp folders as
 * root, and the runner's user cannot delete those files, so whatever is left goes from a throwaway
 * container (the busybox image the system tests already use).
 */
export function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch (error) {
    if (!dockerWorks()) {
      warn(`Could not delete ${path}: ${error.message}`);
      return false;
    }
    const result = run('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--mount',
      `type=bind,source=${dirname(path)},target=/clean`,
      'busybox:1.37',
      'rm',
      '-rf',
      `/clean/${basename(path)}`,
    ]);
    if (result.status !== 0) {
      warn(`Could not delete ${path}: ${error.message}; as root: ${result.stderr.trim()}`);
      return false;
    }
    return true;
  }
}
