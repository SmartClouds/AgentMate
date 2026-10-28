// Helpers for main.mjs and post.mjs. Plain Node, no dependencies: the runner runs these with its
// own Node before (and after) anything is installed.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

/**
 * Whether node_modules stays in the workspace between jobs. The Mac mini runs on a hard disk,
 * where deleting node_modules after every job and linking ~1,400 packages back in at the start of
 * the next took minutes. Its checkouts set `clean: false` for the same reason, and main.mjs
 * clears everything else at the start of the job instead. better-sqlite3 loads its prebuilt
 * binary before the one the end-to-end jobs rebuild for Electron, so a node_modules an e2e job
 * left behind still works under Node.
 */
export function keepsDependencies() {
  return process.platform === 'darwin';
}

/**
 * Deletes the untracked and ignored files in the workspace: builds, reports, caches, and
 * node_modules unless `keepDependencies`. Tracked files stay, and so does .git, which the next
 * checkout fetches into.
 */
export function cleanWorkspace({ keepDependencies = false } = {}) {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace || !existsSync(join(workspace, '.git'))) {
    console.log('No checkout here.');
    return;
  }
  // -x ignores .gitignore, but still honours an -e pattern. One without a slash matches the
  // node_modules of every package, not only the root's.
  const args = [
    '-C',
    workspace,
    'clean',
    '-ffdx',
    ...(keepDependencies ? ['-e', 'node_modules'] : []),
  ];
  const kept = keepDependencies ? ', node_modules kept' : '';
  const result = run('git', [...args, '--quiet']);
  if (result.status === 0) {
    console.log(`Cleaned ${workspace}${kept}.`);
    return;
  }
  // Files a container wrote as root. git cannot delete them, removeTree can.
  const left = run('git', [...args, '-n']).stdout.split('\n');
  for (const line of left) {
    const path = line.replace(/^Would remove /, '').trim();
    if (path && path !== line.trim()) removeTree(join(workspace, path));
  }
  const after = run('git', [...args, '-n']).stdout.trim();
  if (after) throw new Error(`Still in the workspace:\n${after}`);
  console.log(`Cleaned ${workspace}${kept}.`);
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...options });
}

export function warn(message) {
  console.log(`::warning title=Runner cleanup::${message}`);
}

/**
 * How many jobs other than this one `ps -A -o pid=,ppid=,command=` shows running. A runner runs
 * each job in a Runner.Worker process, and this step is one of its descendants, so any other
 * worker is another runner's job on the same machine.
 */
export function otherJobsIn(psOutput, self) {
  const processes = new Map();
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) processes.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
  }
  const ancestors = new Set();
  for (let pid = self; processes.has(pid) && !ancestors.has(pid); pid = processes.get(pid).ppid) {
    ancestors.add(pid);
  }
  let others = 0;
  for (const [pid, { command }] of processes) {
    if (/\bRunner\.Worker\b/.test(command) && !ancestors.has(pid)) others++;
  }
  return others;
}

/** The jobs other runners are running on this machine, or null when `ps` could not tell. */
export function otherJobs() {
  const result = run('ps', ['-A', '-o', 'pid=,ppid=,command='], { timeout: 30_000 });
  return result.status === 0 ? otherJobsIn(result.stdout, process.pid) : null;
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
