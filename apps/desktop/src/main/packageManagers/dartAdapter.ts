import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type {
  PackageInfo,
  PackageManagerSection,
  PackageUpdateItemResult,
  PackageUpdateRequest,
  PackageUpdateResult,
  RuntimeTarget,
  RuntimeUpdateRequest,
  RuntimeUpdateResult,
} from '../../shared/apiTypes';
import { CliNotFoundError, mapWithConcurrency, runCli } from './execUtils';
import { runtimeFeeds } from './runtimeFeeds';
import {
  lowerBound,
  parseDartConstraint,
  readPubspecEnvironment,
  rewritePubspecEnvironment,
} from './runtimeTargets';
import {
  applyRuntimeUpdate,
  type RuntimeCandidate,
  type RuntimeUpdateDeps,
  runtimeCandidate,
} from './runtimeUpdate';
import type { PackageManagerAdapter, UpdateProgressTick } from './types';

const MAX_SCAN_DEPTH = 4;
/**
 * Flutter copies plugin sources into `ephemeral/.plugin_symlinks` and `.symlinks`,
 * and fvm keeps a whole SDK under `.fvm`, all full of pubspec.yaml files that
 * aren't part of the project.
 */
const PRUNED_DIRS = new Set([
  '.git',
  '.dart_tool',
  '.fvm',
  '.pub-cache',
  '.symlinks',
  '.plugin_symlinks',
  'ephemeral',
  'build',
  'node_modules',
  'Pods',
]);
const DEFAULT_PUB_HOST = 'https://pub.dev';
const REGISTRY_TIMEOUT_MS = 15000;
const REGISTRY_CONCURRENCY = 6;
/** Packages that must fail on the network, after their retry, before a host is given up on. */
const DEAD_HOST_FAILURES = 3;
/** `pub add` resolves the whole graph and may download the new versions, so give it room. */
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

async function findPubspecFiles(root: string, dir = root, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  if (entries.some((e) => e.isFile() && e.name === 'pubspec.yaml')) {
    found.push(join(dir, 'pubspec.yaml'));
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !PRUNED_DIRS.has(entry.name)) {
      found.push(...(await findPubspecFiles(root, join(dir, entry.name), depth + 1)));
    }
  }
  return found;
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

// --- pubspec.yaml / pubspec.lock parsing -------------------------------------
// Both files only need a few well-known keys, and pub writes the lock file in a
// fixed layout, so a line reader is enough and avoids pulling in a YAML parser.

interface YamlLine {
  indent: number;
  text: string;
}

/** Drops blank lines and comments. A `#` only starts a comment at the line start or after whitespace. */
function yamlLines(source: string): YamlLine[] {
  const lines: YamlLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const text = raw.replace(/(^|\s)#.*$/, '').trimEnd();
    if (!text.trim()) continue;
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim() });
  }
  return lines;
}

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, '$2');
}

const KEY_VALUE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

/** Returns the lines nested under a top-level key, e.g. everything under `dependencies:`. */
function sectionLines(lines: YamlLine[], key: string): YamlLine[] {
  const start = lines.findIndex((l) => l.indent === 0 && l.text.startsWith(`${key}:`));
  if (start === -1) return [];
  const body: YamlLine[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.indent === 0) break;
    body.push(line);
  }
  return body;
}

/** Splits a section into its direct children, each with the lines nested beneath it. */
function childEntries(body: YamlLine[]): { name: string; value: string; nested: YamlLine[] }[] {
  if (body.length === 0) return [];
  const childIndent = body[0].indent;
  const entries: { name: string; value: string; nested: YamlLine[] }[] = [];
  for (const line of body) {
    if (line.indent === childIndent) {
      const match = KEY_VALUE.exec(line.text);
      if (match) entries.push({ name: match[1], value: match[2].trim(), nested: [] });
    } else if (line.indent > childIndent) {
      entries.at(-1)?.nested.push(line);
    }
  }
  return entries;
}

type DependencySource = 'hosted' | 'sdk' | 'git' | 'path';

interface DeclaredDep {
  name: string;
  isDev: boolean;
  /** The version constraint as written, or null when the entry has none (`foo:` means any). */
  constraint: string | null;
  source: DependencySource;
  /** True when a hosted entry points at its own server instead of the default one. */
  customHost: boolean;
}

function describeDependency(
  name: string,
  value: string,
  nested: YamlLine[],
  isDev: boolean,
): DeclaredDep {
  // Plain form, `http: ^1.2.0`. Flow maps like `foo: {path: ../foo}` fall through below.
  if (value && !value.startsWith('{')) {
    return { name, isDev, constraint: unquote(value), source: 'hosted', customHost: false };
  }

  const fields = new Map<string, string>();
  if (value.startsWith('{')) {
    for (const part of value.replace(/^\{|\}$/g, '').split(',')) {
      const match = KEY_VALUE.exec(part.trim());
      if (match) fields.set(match[1], unquote(match[2]));
    }
  } else if (nested.length > 0) {
    const fieldIndent = nested[0].indent;
    for (const line of nested) {
      if (line.indent !== fieldIndent) continue;
      const match = KEY_VALUE.exec(line.text);
      if (match) fields.set(match[1], unquote(match[2]));
    }
  }

  const constraint = fields.get('version') || null;
  if (fields.has('sdk')) return { name, isDev, constraint, source: 'sdk', customHost: false };
  if (fields.has('git')) return { name, isDev, constraint, source: 'git', customHost: false };
  if (fields.has('path')) return { name, isDev, constraint, source: 'path', customHost: false };
  return { name, isDev, constraint, source: 'hosted', customHost: fields.has('hosted') };
}

interface Pubspec {
  name: string | null;
  usesFlutter: boolean;
  dependencies: DeclaredDep[];
}

function parsePubspec(source: string): Pubspec {
  const lines = yamlLines(source);
  const nameLine = lines.find((l) => l.indent === 0 && l.text.startsWith('name:'));
  const dependencies: DeclaredDep[] = [];
  for (const [section, isDev] of [
    ['dependencies', false],
    ['dev_dependencies', true],
  ] as const) {
    for (const entry of childEntries(sectionLines(lines, section))) {
      dependencies.push(describeDependency(entry.name, entry.value, entry.nested, isDev));
    }
  }
  return {
    name: nameLine ? unquote(nameLine.text.slice('name:'.length)) || null : null,
    usesFlutter: dependencies.some((d) => d.source === 'sdk' && d.name === 'flutter'),
    dependencies,
  };
}

interface LockedPackage {
  version: string | null;
  /** Server the package was resolved from, for hosted packages. */
  hostUrl: string | null;
}

function parsePubspecLock(source: string): Map<string, LockedPackage> {
  const locked = new Map<string, LockedPackage>();
  for (const entry of childEntries(sectionLines(yamlLines(source), 'packages'))) {
    let version: string | null = null;
    let hostUrl: string | null = null;
    for (const line of entry.nested) {
      const match = KEY_VALUE.exec(line.text);
      if (!match) continue;
      if (match[1] === 'version') version = unquote(match[2]) || null;
      if (match[1] === 'url') hostUrl = unquote(match[2]) || null;
    }
    locked.set(entry.name, { version, hostUrl });
  }
  return locked;
}

// --- Versions ----------------------------------------------------------------

interface ParsedVersion {
  core: number[];
  prerelease: string | null;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

/** Positive when `a` is newer than `b`. Build metadata is ignored, and a pre-release sorts before its release. */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function defaultPubHost(): string {
  return (process.env.PUB_HOSTED_URL || DEFAULT_PUB_HOST).replace(/\/+$/, '');
}

/** Tracks network failures per host across one scan. */
class HostHealth {
  private readonly failures = new Map<string, number>();

  isDead(host: string): boolean {
    return (this.failures.get(host) ?? 0) >= DEAD_HOST_FAILURES;
  }

  recordFailure(host: string): void {
    this.failures.set(host, (this.failures.get(host) ?? 0) + 1);
  }

  failedHosts(): string[] {
    return [...this.failures.keys()];
  }
}

/**
 * Looks up the latest version through the pub repository API, which pub.dev and
 * its mirrors all serve. A request that fails on the network is retried once,
 * since a single dropped connection is common on a slow link. Once a host has
 * failed for several packages it is skipped for the rest of the scan, so an
 * unreachable pub.dev costs a few timeouts instead of one per package.
 */
async function fetchLatestFromHost(
  host: string,
  name: string,
  health: HostHealth,
  attempt = 0,
): Promise<string | null> {
  if (health.isDead(host) || !/^https?:\/\//i.test(host)) return null;
  try {
    const res = await fetch(`${host}/api/packages/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/vnd.pub.v2+json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) return null; // 404 for a private or unpublished package
    const data = (await res.json()) as { latest?: { version?: string } };
    return data.latest?.version ?? null;
  } catch {
    if (attempt === 0) return fetchLatestFromHost(host, name, health, attempt + 1);
    health.recordFailure(host);
    return null;
  }
}

// --- Runtime targets ---------------------------------------------------------

/**
 * pubspec's `environment.sdk` and `environment.flutter`. A Flutter app's Dart constraint moves to
 * the Dart that ships inside the newest Flutter stable, never to a Dart no Flutter has yet, so
 * the one upgrade (Flutter) covers both rows.
 */
async function dartRuntimeCandidates(
  pubspecPath: string,
  source: string,
  projectLabel: string,
): Promise<RuntimeCandidate[]> {
  const { usesFlutter } = parsePubspec(source);
  const environment = readPubspecEnvironment(source);
  const candidates: RuntimeCandidate[] = [];

  function add(
    key: 'sdk' | 'flutter',
    kind: 'dart' | 'flutter',
    latestVersion: string | null,
    requires: ((latest: string) => { toolchain: string; minVersion: string }) | null,
  ): void {
    const raw = environment[key];
    if (!raw) return;
    const constraint = parseDartConstraint(raw);
    const currentVersion = constraint?.lower ?? lowerBound(raw);
    if (!currentVersion) return;
    candidates.push(
      runtimeCandidate({
        kind,
        source: key === 'sdk' ? 'pubspec-sdk' : 'pubspec-flutter',
        declared: raw,
        currentVersion,
        latestVersion,
        next: constraint ? constraint.next : null,
        requires,
        manifestPath: pubspecPath,
        projectLabel,
        rewrite: (text, value) => rewritePubspecEnvironment(text, key, value),
      }),
    );
  }

  if (usesFlutter) {
    const flutter = await runtimeFeeds.flutter();
    const needsFlutter = flutter
      ? () => ({ toolchain: 'flutter', minVersion: flutter.version })
      : null;
    add('sdk', 'dart', flutter?.dartVersion ?? null, needsFlutter);
    add('flutter', 'flutter', flutter?.version ?? null, needsFlutter);
  } else {
    add('sdk', 'dart', await runtimeFeeds.dart(), (latest) => ({
      toolchain: 'dart',
      minVersion: latest,
    }));
  }
  return candidates;
}

// --- Listing -----------------------------------------------------------------

interface ProjectScanOutcome {
  projectLabel: string;
  packages: PackageInfo[];
  /** Hosted packages whose latest version could not be looked up. */
  unresolvedCount: number;
  hasLockFile: boolean;
  usesFlutter: boolean;
  runtimes: RuntimeTarget[];
}

async function listPackagesForPubspec(
  rootFolder: string,
  pubspecPath: string,
  health: HostHealth,
): Promise<ProjectScanOutcome | null> {
  const projectDir = dirname(pubspecPath);
  const [pubspecSource, lockSource] = await Promise.all([
    readFileSafe(pubspecPath),
    readFileSafe(join(projectDir, 'pubspec.lock')),
  ]);
  if (pubspecSource === null) return null;

  const pubspec = parsePubspec(pubspecSource);
  const locked = lockSource ? parsePubspecLock(lockSource) : new Map<string, LockedPackage>();
  const projectLabel = labelForPubspec(rootFolder, pubspecPath, pubspec.name);
  let unresolvedCount = 0;

  // SDK packages (flutter, flutter_test, ...) ship with the SDK and can't be updated on their own.
  const listed = pubspec.dependencies.filter((d) => d.source !== 'sdk');
  const packages = await mapWithConcurrency(listed, REGISTRY_CONCURRENCY, async (dep) => {
    const lock = locked.get(dep.name);
    const currentVersion = lock?.version ?? dep.constraint ?? 'unknown';
    const base = {
      name: dep.name,
      currentVersion,
      isDev: dep.isDev,
      isInstalled: lock?.version != null,
      manifestPath: pubspecPath,
      projectLabel,
    };

    // Git and path packages have no registry to compare against, and custom-hosted
    // ones can't be moved with a plain `pub add name:^x` without changing their source.
    const current = parseVersion(currentVersion);
    if (dep.source !== 'hosted' || dep.customHost || !current) {
      return { ...base, latestVersion: currentVersion, isOutdated: false } satisfies PackageInfo;
    }

    const host = (lock?.hostUrl ?? defaultPubHost()).replace(/\/+$/, '');
    const latestVersion = await fetchLatestFromHost(host, dep.name, health);
    const latest = latestVersion ? parseVersion(latestVersion) : null;
    if (!latestVersion || !latest) {
      unresolvedCount++;
      return { ...base, latestVersion: null, isOutdated: false } satisfies PackageInfo;
    }
    const isOutdated = compareVersions(latest, current) > 0;
    return {
      ...base,
      latestVersion: isOutdated ? latestVersion : currentVersion,
      isOutdated,
    } satisfies PackageInfo;
  });

  packages.sort((a, b) => a.name.localeCompare(b.name));
  const runtimes = await dartRuntimeCandidates(pubspecPath, pubspecSource, projectLabel);
  return {
    projectLabel,
    packages,
    unresolvedCount,
    hasLockFile: lockSource !== null,
    usesFlutter: pubspec.usesFlutter,
    runtimes: runtimes.map((c) => c.target),
  };
}

function labelForPubspec(rootFolder: string, pubspecPath: string, name: string | null): string {
  const rel = relative(rootFolder, dirname(pubspecPath));
  return name ?? (rel === '' ? basename(rootFolder) : rel);
}

async function detect(folderPath: string): Promise<boolean> {
  const files = await findPubspecFiles(folderPath);
  return files.length > 0;
}

async function listSection(folderPath: string): Promise<PackageManagerSection> {
  const pubspecs = await findPubspecFiles(folderPath);
  const health = new HostHealth();

  const outcomes = (
    await Promise.all(pubspecs.map((p) => listPackagesForPubspec(folderPath, p, health)))
  ).filter((o): o is ProjectScanOutcome => o !== null);

  const base = {
    ecosystem: 'dart',
    manager: 'pub',
    runtimes: outcomes.flatMap((o) => o.runtimes),
    // Flutter carries its own Dart, so one Flutter project makes Flutter the tool to keep current.
    toolchain: outcomes.some((o) => o.usesFlutter) ? 'flutter' : 'dart',
  } as const;

  if (pubspecs.length > 0 && outcomes.length === 0) {
    return { ...base, status: 'error', message: 'Failed to read pubspec.yaml.', packages: [] };
  }

  const notes: string[] = [];
  const unresolved = outcomes.reduce((sum, o) => sum + o.unresolvedCount, 0);
  if (unresolved > 0) {
    const count = `${unresolved} package${unresolved === 1 ? '' : 's'}`;
    const failedHosts = health.failedHosts();
    notes.push(
      failedHosts.length > 0
        ? `Could not reach ${failedHosts.join(', ')}, so the latest version of ${count} is unknown. Refresh to try again.`
        : `The latest version of ${count} could not be looked up.`,
    );
  }
  const unlocked = outcomes.filter((o) => !o.hasLockFile && o.packages.length > 0);
  if (unlocked.length > 0) {
    notes.push(
      `${unlocked.map((o) => o.projectLabel).join(', ')} ${unlocked.length === 1 ? 'has' : 'have'} no pubspec.lock, so ${unlocked.length === 1 ? 'its' : 'their'} versions are the declared constraints. Run pub get there to resolve them.`,
    );
  }

  return {
    ...base,
    status: 'ok',
    message: notes.length > 0 ? notes.join(' ') : null,
    packages: outcomes.flatMap((o) => o.packages),
  };
}

// --- Updating ----------------------------------------------------------------

/**
 * Builds the `pub add` descriptor for one package. An exact pin stays exact,
 * everything else becomes a caret constraint, which is what pub itself writes.
 */
function addDescriptor(update: PackageUpdateRequest, declared: DeclaredDep | undefined): string {
  const pinned = declared?.constraint != null && parseVersion(declared.constraint) !== null;
  const constraint = pinned ? update.targetVersion : `^${update.targetVersion}`;
  return `${declared?.isDev ? 'dev:' : ''}${update.name}:${constraint}`;
}

async function updatePackages(
  _folderPath: string,
  updates: PackageUpdateRequest[],
  onProgress: (tick: UpdateProgressTick) => void,
): Promise<PackageUpdateResult> {
  if (updates.length === 0) return { ok: true, results: [] };
  const total = updates.length;

  const groups = new Map<string, PackageUpdateRequest[]>();
  for (const update of updates) {
    const group = groups.get(update.manifestPath);
    if (group) group.push(update);
    else groups.set(update.manifestPath, [update]);
  }

  updates.forEach((u) =>
    onProgress({ packageName: u.name, status: 'running', completed: 0, total }),
  );

  let completed = 0;
  const results: PackageUpdateItemResult[] = [];

  // One `pub add` per pubspec, so the dependency graph is resolved once for the
  // whole batch rather than once per package.
  for (const [pubspecPath, groupUpdates] of groups) {
    const source = await readFileSafe(pubspecPath);
    const pubspec = source ? parsePubspec(source) : null;
    const command = pubspec?.usesFlutter === false ? 'dart' : 'flutter';
    const declaredByName = new Map(pubspec?.dependencies.map((d) => [d.name, d]) ?? []);
    const args = [
      'pub',
      'add',
      ...groupUpdates.map((u) => addDescriptor(u, declaredByName.get(u.name))),
    ];

    let groupOk: boolean;
    let message: string;
    try {
      const { code, stdout, stderr } = await runCli(
        command,
        args,
        dirname(pubspecPath),
        UPDATE_TIMEOUT_MS,
      );
      groupOk = code === 0;
      message = groupOk
        ? 'Updated'
        : (stderr || stdout).slice(-500) || `${command} exited with code ${code}`;
    } catch (err) {
      groupOk = false;
      message =
        err instanceof CliNotFoundError
          ? `Install the ${command === 'flutter' ? 'Flutter' : 'Dart'} SDK and add it to PATH to update these packages.`
          : err instanceof Error
            ? err.message
            : `${command} pub add failed.`;
    }

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

  return { ok: results.every((r) => r.ok), results };
}

/**
 * Writes the new constraint, then resolves the project once with it so a constraint that no
 * dependency can live with shows up here rather than on the next build. The new constraint stays
 * in the file either way, as a failed `pub add` leaves its own.
 */
async function updateRuntime(
  folderPath: string,
  request: RuntimeUpdateRequest,
  deps: RuntimeUpdateDeps,
): Promise<RuntimeUpdateResult> {
  const source = await readFileSafe(request.manifestPath);
  if (source === null) return { ok: false, message: `Failed to read ${request.manifestPath}.` };
  const pubspec = parsePubspec(source);
  const label = labelForPubspec(folderPath, request.manifestPath, pubspec.name);
  const result = await applyRuntimeUpdate(
    request,
    await dartRuntimeCandidates(request.manifestPath, source, label),
    deps,
  );
  if (!result.ok) return result;

  const command = pubspec.usesFlutter ? 'flutter' : 'dart';
  try {
    const { code, stdout, stderr } = await runCli(
      command,
      ['pub', 'get'],
      dirname(request.manifestPath),
      UPDATE_TIMEOUT_MS,
    );
    if (code === 0) return result;
    const tail = (stderr || stdout).slice(-500) || `${command} exited with code ${code}`;
    return { ok: false, message: `${result.message} Then ${command} pub get failed: ${tail}` };
  } catch (err) {
    const why = err instanceof Error ? err.message : `${command} pub get failed.`;
    return {
      ok: false,
      message: `${result.message} Then ${command} pub get could not run: ${why}`,
    };
  }
}

export const dartAdapter: PackageManagerAdapter = {
  ecosystem: 'dart',
  detect,
  listPackages: async (folderPath) => [await listSection(folderPath)],
  updatePackages,
  updateRuntime,
};
