// Runs after every other step of the job, passed, failed or cancelled, and removes what the job
// left on a self-hosted runner's disk.
//
// Every job: the test containers, networks and volumes a failed or cancelled test never removed,
// the workspace, node_modules and build output included, and the job's temp folder (main.mjs).
// The next job's checkout would wipe the workspace anyway, so deleting it now costs nothing. The
// Mac is the exception: it keeps node_modules, and main.mjs clears the rest of the workspace at
// the start of the next job (keepsDependencies in shared.mjs says why).
//
// Once a day, since these take longer and only grow slowly: packages nothing uses any more in
// the pnpm store, NuGet's packages folder and the native-module header caches, the .NET and Node
// versions setup-dotnet and setup-node have replaced in the tool cache, and dangling Docker images
// and old build cache. What is still in use stays, so the next job does not download it again.
//
// A machine can have more than one runner (smartvpn has two). The test containers carry no mark
// of the job that made them, so they are only removed when no other job is running there: one
// job's cleanup used to delete the containers another job's tests were still using. What a busy
// machine leaves goes with the next job that ends alone. The daily steps are safe either way: each
// runner has its own pnpm store and tool cache, and Docker's prune leaves what is in use.
//
// Nothing here fails the job. A step that goes wrong prints a warning and the rest still run.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cleanWorkspace,
  dockerWorks,
  keepsDependencies,
  otherJobs,
  removeTree,
  run,
  skipReason,
  TEMP_PREFIX,
  TEMP_ROOT,
  warn,
} from './shared.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A cache entry nothing has read for this long goes. */
const UNUSED_AFTER_MS = 30 * DAY_MS;

const workspace = process.env.GITHUB_WORKSPACE;
const toolCache = process.env.RUNNER_TOOL_CACHE;

// Container, network and volume names the tests give the Docker objects they make on the host.
// Runs from before the app was renamed to Runova left some under the old prefix.
const TEST_NAMES =
  /^((runova|agentmate)-(test|e2e|pebble|challtestsrv|wpc|acme|nginx)-|am-files-|e28-)/; // legacy-name
// Images the tests build. A container of one of these is a test's, whatever its name.
const TEST_IMAGES =
  /^(runova|agentmate)-(test-server|backup-targets|nginx-harness|nginx-upstream)(:|$)/; // legacy-name
// Kept on purpose: Composer's download cache for the WordPress connector jobs.
const KEEP_VOLUMES = new Set(['runova-wpc-composer-cache']);

function step(title, work) {
  console.log(`::group::${title}`);
  try {
    work();
  } catch (error) {
    warn(`${title}: ${error.message}`);
  } finally {
    console.log('::endgroup::');
  }
}

function freeBytes() {
  try {
    const stats = statfsSync(workspace ?? homedir());
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function gigabytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function dockerLines(args) {
  const result = run('docker', args);
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function dockerLeftovers() {
  const containers = dockerLines(['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}'])
    .map((line) => line.split('\t'))
    .filter(([, name, image]) => TEST_NAMES.test(name) || TEST_IMAGES.test(image));
  if (containers.length > 0) {
    // -v takes their anonymous volumes along (the test servers keep Docker's layers in one).
    run('docker', ['rm', '--force', '--volumes', ...containers.map(([id]) => id)]);
  }
  const networks = dockerLines(['network', 'ls', '--format', '{{.Name}}']).filter((name) =>
    TEST_NAMES.test(name),
  );
  for (const name of networks) run('docker', ['network', 'rm', name]);
  const volumes = dockerLines(['volume', 'ls', '--quiet']).filter(
    (name) => TEST_NAMES.test(name) && !KEEP_VOLUMES.has(name),
  );
  if (volumes.length > 0) run('docker', ['volume', 'rm', '--force', ...volumes]);
  console.log(
    `Removed ${containers.length} containers, ${networks.length} networks and ${volumes.length} volumes.`,
  );
}

function dockerImages() {
  // Dangling only: the layers a rebuilt test server or a newer pull replaced. Tagged images stay,
  // they are what the next job uses.
  const images = run('docker', ['image', 'prune', '--force']);
  console.log(images.stdout.trim().split('\n').at(-1) ?? '');
  // Build cache the test server builds have not used for a week.
  const cache = run('docker', ['builder', 'prune', '--force', '--filter', 'until=168h']);
  console.log(cache.stdout.trim().split('\n').at(-1) ?? '');
}

function jobTemp() {
  const tmp = process.env.STATE_tmpdir;
  if (!tmp) {
    console.log('This job had no temp folder of its own.');
    return;
  }
  // Only ever the folder main.mjs made.
  const root = realpathSync(TEMP_ROOT);
  if (!tmp.startsWith(join(root, TEMP_PREFIX))) throw new Error(`Refusing to delete ${tmp}.`);
  if (removeTree(tmp)) console.log(`Deleted ${tmp}.`);
}

function pnpmStore() {
  // The runner's own store (main.mjs sets pnpm_config_store_dir), apart from the Mac user's.
  // Pruning while this job's node_modules is still there keeps what this commit uses.
  if (!workspace || !existsSync(join(workspace, 'node_modules'))) {
    console.log('This job installed no packages.');
    return;
  }
  const result = run('pnpm', ['store', 'prune'], { cwd: workspace });
  if (result.error || result.status !== 0) {
    throw new Error(`pnpm store prune failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  console.log(result.stdout.trim());
}

/** Reading a file updates its access time here, unless the disk is mounted with noatime. */
function accessTimesWork(dir) {
  const probe = join(dir, '.runova-cleanup-probe');
  try {
    writeFileSync(probe, 'probe');
    const old = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(probe, old, new Date());
    readFileSync(probe);
    return statSync(probe).atimeMs > old.getTime() + DAY_MS;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
}

/**
 * Whether any file under `path` was read since then. Only files count: listing a folder, which
 * this walk does itself, updates the folder's access time.
 */
function usedRecently(path, since) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return false;
  }
  if (!stats.isDirectory()) return stats.atimeMs > since;
  for (const name of readdirSync(path)) {
    if (usedRecently(join(path, name), since)) return true;
  }
  return false;
}

function subfolders(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Deletes every entry `depth` levels down in `dir` that nothing has read for a month. */
function pruneUnused(dir, depth) {
  if (!existsSync(dir)) return;
  if (!accessTimesWork(dir)) {
    console.log(`${dir}: this disk does not keep access times, so it is left alone.`);
    return;
  }
  const since = Date.now() - UNUSED_AFTER_MS;
  let entries = [dir];
  for (let level = 0; level < depth; level++) entries = entries.flatMap(subfolders);
  let removed = 0;
  for (const entry of entries) {
    if (!usedRecently(entry, since) && removeTree(entry)) removed++;
  }
  // A NuGet package with no version left.
  if (depth > 1) {
    for (const parent of subfolders(dir)) {
      if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
    }
  }
  console.log(`${dir}: removed ${removed} of ${entries.length} unused for 30 days.`);
}

function unusedCaches() {
  const home = homedir();
  // ~/.nuget/packages/<id>/<version>.
  pruneUnused(process.env.NUGET_PACKAGES || join(home, '.nuget', 'packages'), 2);
  // Headers for native module builds, one folder per Electron or Node version.
  pruneUnused(join(home, '.electron-gyp'), 1);
  pruneUnused(
    process.platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'node-gyp')
      : join(home, '.cache', 'node-gyp'),
    1,
  );
  // Package metadata from the feeds. A locked restore with the packages on disk needs none of it.
  const nuget = run('dotnet', ['nuget', 'locals', 'http-cache', '--clear']);
  if (nuget.status === 0) console.log("Cleared NuGet's HTTP cache.");
}

function parseVersion(name) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(name);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: match[4] ?? '' };
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

/**
 * In a folder of version-named folders, keeps the newest of each group and deletes the rest.
 * `groupOf` maps a version to its group, `keepable` says whether a folder may be the one kept.
 */
function keepNewest(dir, groupOf, keepable = () => true) {
  const newest = new Map();
  const all = [];
  for (const path of subfolders(dir)) {
    const version = parseVersion(path.slice(dir.length + 1));
    if (!version) continue;
    const entry = { path, version, group: groupOf(version) };
    all.push(entry);
    if (!keepable(path)) continue;
    const best = newest.get(entry.group);
    if (!best || compareVersions(entry.version, best.version) > 0) newest.set(entry.group, entry);
  }
  let removed = 0;
  for (const entry of all) {
    const best = newest.get(entry.group);
    if (!best || best === entry || compareVersions(entry.version, best.version) > 0) continue;
    if (removeTree(entry.path)) removed++;
  }
  return removed;
}

function toolCacheVersions() {
  if (!toolCache) return;
  const minor = ({ parts }) => `${parts[0]}.${parts[1]}`;

  // Our own .NET folder (DOTNET_INSTALL_DIR in the workflows). setup-dotnet adds each new patch of
  // the 10.0.4xx band next to the old ones, and global.json rolls forward to the newest.
  const dotnet = join(toolCache, 'dotnet');
  if (existsSync(dotnet)) {
    // The SDK by feature band (10.0.4xx), the rest by runtime version (10.0).
    const band = ({ parts }) => `${parts[0]}.${parts[1]}.${Math.floor(parts[2] / 100)}`;
    let removed = keepNewest(join(dotnet, 'sdk'), band);
    removed += keepNewest(join(dotnet, 'host', 'fxr'), minor);
    removed += keepNewest(join(dotnet, 'templates'), minor);
    for (const folder of ['shared', 'packs']) {
      for (const framework of subfolders(join(dotnet, folder))) {
        removed += keepNewest(framework, minor);
      }
    }
    console.log(`.NET: removed ${removed} replaced versions.`);
  }

  // setup-node's folders, node/<version>/<arch>, finished ones marked by <arch>.complete. The
  // newest finished one of each major version is the one a `node-version: "22"` picks.
  const node = join(toolCache, 'node');
  if (existsSync(node)) {
    const complete = (path) => readdirSync(path).some((name) => name.endsWith('.complete'));
    const removed = keepNewest(node, ({ parts }) => String(parts[0]), complete);
    console.log(`Node: removed ${removed} replaced versions.`);
  }
}

/** True once a day per machine, for the slower steps. */
function dailyDue() {
  if (!toolCache) return false;
  const dir = join(toolCache, 'runova-cleanup');
  const stamp = join(dir, 'last-daily');
  try {
    if (Date.now() - statSync(stamp).mtimeMs < DAY_MS) return false;
  } catch {
    // Never ran here.
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(stamp, new Date().toISOString());
  return true;
}

const skip = skipReason();
if (skip) {
  console.log(`Nothing to do: ${skip}`);
} else {
  const before = freeBytes();
  if (dockerWorks()) {
    step('Test containers, networks and volumes', () => {
      const others = otherJobs();
      if (others === null) {
        console.log('Could not tell whether other jobs are running here, so test containers stay.');
      } else if (others > 0) {
        const who = others === 1 ? 'Another job is' : `${others} other jobs are`;
        console.log(`${who} running on this machine, so test containers stay.`);
      } else {
        dockerLeftovers();
      }
    });
  }
  if (dailyDue()) {
    // Not on the Mac: a prune reads the whole store, slow on its hard disk, and deleting the
    // store's links folder there once took 12 minutes.
    if (!keepsDependencies()) step('pnpm store', pnpmStore);
    step('Unused NuGet packages and native headers', unusedCaches);
    step('Replaced .NET and Node versions', toolCacheVersions);
    if (dockerWorks()) step('Dangling Docker images and old build cache', dockerImages);
  }
  if (keepsDependencies()) {
    console.log(
      "The workspace stays: this runner keeps node_modules, and the next job's start clears the rest.",
    );
  } else {
    step('Workspace', cleanWorkspace);
  }
  // Last, since TMPDIR still points into it for everything above.
  step("The job's temp folder", jobTemp);
  const after = freeBytes();
  if (before !== null && after !== null) {
    console.log(`Freed ${gigabytes(Math.max(0, after - before))}, ${gigabytes(after)} free.`);
  }
}
