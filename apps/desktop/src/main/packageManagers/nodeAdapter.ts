import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type {
  PackageInfo,
  PackageManagerKind,
  PackageManagerSection,
  PackageUpdateItemResult,
  PackageUpdateRequest,
  PackageUpdateResult,
} from '../../shared/apiTypes';
import { stripAnsi } from '../process/spawnStreaming';
import { CliNotFoundError, mapWithConcurrency, runCli, tryParseJson } from './execUtils';
import type { PackageManagerAdapter, UpdateProgressTick } from './types';

const REGISTRY_TIMEOUT_MS = 8000;
const REGISTRY_CONCURRENCY = 5;
const MAX_SCAN_DEPTH = 4;
const PRUNED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'coverage',
]);

interface PackageJsonShape {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

interface DeclaredDep {
  name: string;
  isDev: boolean;
}

/** Recursively finds every package.json under root, skipping node_modules and other noisy dirs. */
async function findPackageJsonFiles(root: string, dir = root, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
    found.push(join(dir, 'package.json'));
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !PRUNED_DIRS.has(entry.name)) {
      found.push(...(await findPackageJsonFiles(root, join(dir, entry.name), depth + 1)));
    }
  }
  return found;
}

/** Yields folderPath and each parent up to and including rootFolder. */
function* foldersUpTo(folderPath: string, rootFolder: string): Generator<string> {
  let dir = folderPath;
  while (true) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir || relative(rootFolder, parent).startsWith('..')) return;
    dir = parent;
  }
}

function lockfileManager(dir: string): PackageManagerKind | null {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  return null;
}

/**
 * Workspace members have no lockfile of their own (it sits at the workspace root), so the
 * nearest lockfile between the manifest folder and the scanned project root decides.
 */
function detectManager(folderPath: string, rootFolder = folderPath): PackageManagerKind {
  for (const dir of foldersUpTo(folderPath, rootFolder)) {
    const manager = lockfileManager(dir);
    if (manager) return manager;
  }
  return 'npm';
}

async function readPackageJson(manifestPath: string): Promise<PackageJsonShape | null> {
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    return JSON.parse(raw) as PackageJsonShape;
  } catch {
    return null;
  }
}

/** Resolves the way Node does, so a dependency hoisted to the workspace root still counts. */
async function readInstalledVersion(
  folderPath: string,
  rootFolder: string,
  name: string,
): Promise<string | null> {
  for (const dir of foldersUpTo(folderPath, rootFolder)) {
    try {
      const raw = await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version ?? null;
    } catch {
      // Not installed at this level, keep walking up.
    }
  }
  return null;
}

interface OutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
}

/**
 * `bun outdated` has no JSON mode, so this reads its table. Recent versions draw it with `|`,
 * older ones with box characters, and dev/peer/optional rows carry a suffix like "(dev)".
 * Bun lists only outdated packages and prints no table at all when everything is current,
 * so a clean exit without a table means nothing is outdated. A failed run without a table
 * (no lockfile yet, for example) returns null so the registry fallback takes over.
 */
export function parseBunOutdated(
  stdout: string,
  code: number,
): Record<string, OutdatedEntry> | null {
  let nameIdx = -1;
  let currentIdx = -1;
  let latestIdx = -1;
  const map: Record<string, OutdatedEntry> = {};
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    if (!/[|│]/.test(line)) continue;
    const cells = line
      .split(/[|│]/)
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^[-─┼]*$/.test(cell))) continue;
    if (nameIdx === -1) {
      if (cells.includes('Package') && cells.includes('Latest')) {
        nameIdx = cells.indexOf('Package');
        currentIdx = cells.indexOf('Current');
        latestIdx = cells.indexOf('Latest');
      }
      continue;
    }
    const name = cells[nameIdx]?.replace(/\s+\((dev|peer|optional)\)$/, '');
    if (!name) continue;
    map[name] = { current: cells[currentIdx], latest: cells[latestIdx] };
  }
  if (nameIdx === -1) return code === 0 ? {} : null;
  return map;
}

async function runOutdated(
  manager: PackageManagerKind,
  folderPath: string,
): Promise<Record<string, OutdatedEntry> | null> {
  try {
    if (manager === 'npm') {
      const { stdout } = await runCli('npm', ['outdated', '--json', '--long'], folderPath);
      return tryParseJson<Record<string, OutdatedEntry>>(stdout.trim() || '{}');
    }
    if (manager === 'pnpm') {
      const { stdout } = await runCli('pnpm', ['outdated', '--format', 'json'], folderPath);
      return tryParseJson<Record<string, OutdatedEntry>>(stdout.trim() || '{}');
    }
    if (manager === 'bun') {
      // npm can't follow bun's isolated node_modules layout and reports nothing as outdated.
      const { stdout, code } = await runCli('bun', ['outdated', '--no-progress'], folderPath);
      return parseBunOutdated(stdout, code);
    }
    // yarn classic: NDJSON, one line per event; the "table" line holds the data we want.
    const { stdout } = await runCli('yarn', ['outdated', '--json'], folderPath);
    const map: Record<string, OutdatedEntry> = {};
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const parsed = tryParseJson<{ type: string; data?: { head?: string[]; body?: string[][] } }>(
        line,
      );
      if (parsed?.type !== 'table' || !parsed.data?.body) continue;
      const head = parsed.data.head ?? [];
      const nameIdx = head.indexOf('Package');
      const currentIdx = head.indexOf('Current');
      const latestIdx = head.indexOf('Latest');
      for (const row of parsed.data.body) {
        const name = row[nameIdx];
        if (!name) continue;
        map[name] = { current: row[currentIdx], latest: row[latestIdx] };
      }
      return map;
    }
    return null; // yarn berry or unrecognized output, trigger registry fallback
  } catch (err) {
    if (err instanceof CliNotFoundError) throw err;
    return null;
  }
}

async function fetchLatestFromRegistry(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

async function detect(folderPath: string): Promise<boolean> {
  const manifests = await findPackageJsonFiles(folderPath);
  return manifests.length > 0;
}

function labelForManifest(
  rootFolder: string,
  manifestPath: string,
  pkgJson: PackageJsonShape,
): string {
  if (pkgJson.name) return pkgJson.name;
  const rel = relative(rootFolder, dirname(manifestPath));
  return rel === '' ? basename(rootFolder) : rel;
}

interface ProjectScanOutcome {
  manager: PackageManagerKind;
  status: 'ok' | 'cli-missing' | 'error';
  message: string | null;
  packages: PackageInfo[];
}

async function listPackagesForManifest(
  rootFolder: string,
  manifestPath: string,
): Promise<ProjectScanOutcome> {
  const folderPath = dirname(manifestPath);
  const manager = detectManager(folderPath, rootFolder);
  const pkgJson = await readPackageJson(manifestPath);
  if (!pkgJson) {
    return { manager, status: 'error', message: `Failed to read ${manifestPath}`, packages: [] };
  }

  const declared: DeclaredDep[] = [
    ...Object.keys(pkgJson.dependencies ?? {}).map((name) => ({ name, isDev: false })),
    ...Object.keys(pkgJson.devDependencies ?? {}).map((name) => ({ name, isDev: true })),
  ];
  const projectLabel = labelForManifest(rootFolder, manifestPath, pkgJson);

  let outdated: Record<string, OutdatedEntry> | null;
  try {
    outdated = await runOutdated(manager, folderPath);
  } catch (err) {
    if (err instanceof CliNotFoundError) {
      return {
        manager,
        status: 'cli-missing',
        message: `Install ${manager} to manage packages for ${projectLabel}.`,
        packages: [],
      };
    }
    outdated = null;
  }

  const needsFallback = outdated === null;
  const packages: PackageInfo[] = await mapWithConcurrency(
    declared,
    REGISTRY_CONCURRENCY,
    async (dep) => {
      const installedVersion = await readInstalledVersion(folderPath, rootFolder, dep.name);
      const entry = outdated?.[dep.name];
      const declaredRange = pkgJson.dependencies?.[dep.name] ?? pkgJson.devDependencies?.[dep.name];
      const currentVersion = entry?.current ?? installedVersion ?? declaredRange ?? 'unknown';
      let latestVersion = entry?.latest ?? null;
      // A workspace sibling or local path isn't on the registry, and a public package that
      // happens to share its name would show up as a bogus update.
      const isLocal = /^(workspace|file|link|portal):/.test(declaredRange ?? '');
      if (latestVersion === null && needsFallback && !isLocal) {
        latestVersion = await fetchLatestFromRegistry(dep.name);
      }
      const isOutdated = latestVersion !== null && latestVersion !== currentVersion;
      return {
        name: dep.name,
        currentVersion,
        latestVersion: latestVersion ?? (isOutdated ? null : currentVersion),
        isOutdated,
        isDev: dep.isDev,
        isInstalled: installedVersion !== null,
        manifestPath,
        projectLabel,
      };
    },
  );

  return { manager, status: 'ok', message: null, packages };
}

function sectionFor(
  manager: PackageManagerKind,
  outcomes: ProjectScanOutcome[],
): PackageManagerSection {
  const packages = outcomes.flatMap((o) => o.packages);
  const errored = outcomes.filter((o) => o.status !== 'ok');

  if (packages.length === 0 && errored.length > 0) {
    const cliMissing = errored.find((o) => o.status === 'cli-missing');
    const first = cliMissing ?? errored[0];
    return {
      ecosystem: 'node',
      manager,
      status: first.status,
      message: first.message,
      packages: [],
    };
  }

  const message =
    errored.length > 0
      ? `${errored.length} of ${outcomes.length} sub-project${outcomes.length === 1 ? '' : 's'} failed to scan.`
      : null;

  return { ecosystem: 'node', manager, status: 'ok', message, packages };
}

/**
 * One section per package manager. A repo without a root lockfile can still have every
 * sub-project on bun (or a mix, say web/ on bun and docs/ on npm), and each section's label,
 * install hint and AI prompt have to name the manager its packages actually use.
 */
async function listPackages(folderPath: string): Promise<PackageManagerSection[]> {
  const manifests = await findPackageJsonFiles(folderPath);
  if (manifests.length === 0) {
    return [
      {
        ecosystem: 'node',
        manager: detectManager(folderPath),
        status: 'ok',
        message: null,
        packages: [],
      },
    ];
  }

  const outcomes = await Promise.all(manifests.map((m) => listPackagesForManifest(folderPath, m)));
  // Map keeps insertion order, so the root's manager (scanned first) leads.
  const byManager = new Map<PackageManagerKind, ProjectScanOutcome[]>();
  for (const outcome of outcomes) {
    byManager.set(outcome.manager, [...(byManager.get(outcome.manager) ?? []), outcome]);
  }
  return [...byManager].map(([manager, group]) => sectionFor(manager, group));
}

function updateArgsFor(
  manager: PackageManagerKind,
  updates: PackageUpdateRequest[],
): { command: string; args: string[] } {
  const targets = updates.map((u) => `${u.name}@${u.targetVersion}`);
  if (manager === 'yarn') return { command: 'yarn', args: ['upgrade', ...targets] };
  if (manager === 'pnpm') return { command: 'pnpm', args: ['update', ...targets] };
  // bun add keeps a dev dependency under devDependencies, so one call covers both kinds.
  if (manager === 'bun') return { command: 'bun', args: ['add', ...targets] };
  return { command: 'npm', args: ['install', ...targets] };
}

async function updatePackages(
  folderPath: string,
  updates: PackageUpdateRequest[],
  onProgress: (tick: UpdateProgressTick) => void,
): Promise<PackageUpdateResult> {
  if (updates.length === 0) return { ok: true, results: [] };
  const total = updates.length;

  const groups = new Map<string, PackageUpdateRequest[]>();
  for (const update of updates) {
    const dir = dirname(update.manifestPath);
    const group = groups.get(dir);
    if (group) group.push(update);
    else groups.set(dir, [update]);
  }

  updates.forEach((u) =>
    onProgress({ packageName: u.name, status: 'running', completed: 0, total }),
  );

  let completed = 0;
  const results: PackageUpdateItemResult[] = [];
  let ok = true;

  for (const [dir, groupUpdates] of groups) {
    const manager = detectManager(dir, folderPath);
    const { command, args } = updateArgsFor(manager, groupUpdates);
    const { code, stdout, stderr } = await runCli(command, args, dir, 5 * 60 * 1000);
    const groupOk = code === 0;
    const message = groupOk
      ? 'Updated'
      : (stderr || stdout).slice(-500) || `${command} exited with code ${code}`;
    ok = ok && groupOk;
    completed += groupUpdates.length;

    for (const u of groupUpdates) {
      results.push({ name: u.name, ok: groupOk, message });
      onProgress({
        packageName: u.name,
        status: groupOk ? 'done' : 'error',
        message: groupOk ? undefined : message,
        completed,
        total,
      });
    }
  }

  return { ok, results };
}

export const nodeAdapter: PackageManagerAdapter = {
  ecosystem: 'node',
  detect,
  listPackages,
  updatePackages,
};
