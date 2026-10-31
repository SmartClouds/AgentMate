import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { compareVersions } from '@runova/core';
import type {
  PackageInfo,
  PackageManagerSection,
  PackageUpdateItemResult,
  PackageUpdateRequest,
  PackageUpdateResult,
  RuntimeUpdateRequest,
  RuntimeUpdateResult,
} from '../../shared/apiTypes';
import { CliNotFoundError, mapWithConcurrency, runCli, tryParseJson } from './execUtils';
import { type DotnetChannel, runtimeFeeds } from './runtimeFeeds';
import {
  type DeclaredTargetFramework,
  parseTargetFramework,
  readGlobalJsonSdk,
  readTargetFramework,
  rewriteGlobalJsonSdk,
  rewriteTargetFramework,
} from './runtimeTargets';
import {
  applyRuntimeUpdate,
  type RuntimeCandidate,
  type RuntimeUpdateDeps,
  runtimeCandidate,
} from './runtimeUpdate';
import type { PackageManagerAdapter, UpdateProgressTick } from './types';

const MAX_SCAN_DEPTH = 4;
const PRUNED_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', 'packages', 'TestResults']);
const PROJECT_EXTENSIONS = ['.csproj', '.vbproj', '.fsproj'];
/** `dotnet list package` restores on demand; on a cold NuGet cache a single call can take a minute. */
const LIST_TIMEOUT_MS = 3 * 60 * 1000;
/** Each project runs two `dotnet` processes, so this is really 2x this many MSBuild instances. */
const LIST_CONCURRENCY = 4;
/** Generous, because these run while several MSBuild processes are saturating the machine. */
const REGISTRY_TIMEOUT_MS = 15000;
const REGISTRY_CONCURRENCY = 8;

async function findProjectFiles(root: string, dir = root, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (PRUNED_DIRS.has(entry.name)) continue;
      found.push(...(await findProjectFiles(root, join(dir, entry.name), depth + 1)));
    } else if (
      entry.isFile() &&
      PROJECT_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))
    ) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

// --- Manifest parsing -------------------------------------------------------
// The .csproj is the source of truth for *which* packages a project declares.
// `dotnet list package` only enriches that with resolved/latest versions, since
// it needs a successful restore and silently reports nothing for legacy or
// unrestorable projects.

interface DeclaredPackage {
  name: string;
  /** Null under Central Package Management when no Directory.Packages.props entry matched. */
  version: string | null;
}

function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

function attr(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(source);
  return match ? match[1].trim() || null : null;
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Parses `<PackageReference Include="X" Version="Y" />` plus the nested-`<Version>` form. */
function parsePackageReferences(xml: string): DeclaredPackage[] {
  const found: DeclaredPackage[] = [];
  const pattern = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference\s*>)/gi;
  for (const match of stripXmlComments(xml).matchAll(pattern)) {
    const [, attrs, body = ''] = match;
    const name = attr(attrs, 'Include') ?? attr(attrs, 'Update');
    if (!name) continue;
    const nested = /<Version>\s*([^<]*?)\s*<\/Version>/i.exec(body);
    found.push({ name, version: attr(attrs, 'Version') ?? nested?.[1] ?? null });
  }
  return found;
}

/** Parses the legacy `packages.config` used by non-SDK-style projects. */
function parsePackagesConfig(xml: string): DeclaredPackage[] {
  const found: DeclaredPackage[] = [];
  for (const match of stripXmlComments(xml).matchAll(/<package\b([^>]*?)\/?>/gi)) {
    const name = attr(match[1], 'id');
    if (!name) continue;
    found.push({ name, version: attr(match[1], 'version') });
  }
  return found;
}

/**
 * Resolves Central Package Management versions by walking up from the project
 * directory to the scan root, mirroring how MSBuild locates the nearest
 * Directory.Packages.props.
 */
async function readCentralVersions(
  rootFolder: string,
  projectDir: string,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  let dir = projectDir;
  for (;;) {
    const xml = await readFileSafe(join(dir, 'Directory.Packages.props'));
    if (xml) {
      for (const match of stripXmlComments(xml).matchAll(/<PackageVersion\b([^>]*?)\/?>/gi)) {
        const name = attr(match[1], 'Include');
        const version = attr(match[1], 'Version');
        if (name && version && !versions.has(name)) versions.set(name, version);
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir || relative(rootFolder, dir) === '') break;
    dir = parent;
  }
  return versions;
}

async function readDeclaredPackages(
  rootFolder: string,
  projectPath: string,
): Promise<DeclaredPackage[]> {
  const projectDir = dirname(projectPath);
  const [projectXml, configXml] = await Promise.all([
    readFileSafe(projectPath),
    readFileSafe(join(projectDir, 'packages.config')),
  ]);

  const declared = new Map<string, DeclaredPackage>();
  for (const pkg of [
    ...(projectXml ? parsePackageReferences(projectXml) : []),
    ...(configXml ? parsePackagesConfig(configXml) : []),
  ]) {
    const existing = declared.get(pkg.name);
    if (!existing) declared.set(pkg.name, pkg);
    else if (!existing.version && pkg.version) declared.set(pkg.name, pkg);
  }

  if ([...declared.values()].some((p) => p.version === null)) {
    const central = await readCentralVersions(rootFolder, projectDir);
    for (const [name, pkg] of declared) {
      const version = central.get(name);
      if (pkg.version === null && version) declared.set(name, { name, version });
    }
  }

  return [...declared.values()];
}

// --- CLI enrichment ---------------------------------------------------------

interface DotnetListPackage {
  id: string;
  resolvedVersion?: string;
  requestedVersion?: string;
  latestVersion?: string;
}

interface DotnetListJson {
  projects?: {
    path?: string;
    frameworks?: { topLevelPackages?: DotnetListPackage[] }[];
  }[];
  /** Present instead of usable framework data when restore fails. */
  problems?: { text?: string; level?: string }[];
}

function collectTopLevelPackages(json: DotnetListJson | null): Map<string, DotnetListPackage> {
  const map = new Map<string, DotnetListPackage>();
  for (const project of json?.projects ?? []) {
    for (const framework of project.frameworks ?? []) {
      for (const pkg of framework.topLevelPackages ?? []) {
        if (!map.has(pkg.id)) map.set(pkg.id, pkg);
      }
    }
  }
  return map;
}

/**
 * Latest stable version from the NuGet flat container, used when the CLI can't
 * restore. The index is sorted ascending by SemVer, so the last non-prerelease
 * entry is the latest stable. Retried once, since a transient timeout here would
 * otherwise be indistinguishable from "already up to date".
 */
async function fetchLatestFromNuget(name: string, attempt = 0): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(name.toLowerCase())}/index.json`,
      { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) },
    );
    if (res.status === 404) return null; // unlisted or a private-feed package
    if (!res.ok) throw new Error(`nuget.org returned ${res.status}`);
    const data = (await res.json()) as { versions?: string[] };
    const stable = (data.versions ?? []).filter((v) => !v.includes('-'));
    return stable.at(-1) ?? data.versions?.at(-1) ?? null;
  } catch {
    return attempt === 0 ? fetchLatestFromNuget(name, attempt + 1) : null;
  }
}

interface ProjectScanOutcome {
  projectLabel: string;
  /** True when the CLI failed, so versions came from the manifest alone. */
  degraded: boolean;
  packages: PackageInfo[];
}

async function listPackagesForProject(
  rootFolder: string,
  projectPath: string,
): Promise<ProjectScanOutcome> {
  const cwd = dirname(projectPath);
  const projectLabel = basename(projectPath).replace(/\.(cs|vb|fs)proj$/i, '');
  const declared = await readDeclaredPackages(rootFolder, projectPath);

  const [installedRes, outdatedRes] = await Promise.all([
    runCli('dotnet', ['list', projectPath, 'package', '--format', 'json'], cwd, LIST_TIMEOUT_MS),
    runCli(
      'dotnet',
      ['list', projectPath, 'package', '--outdated', '--format', 'json'],
      cwd,
      LIST_TIMEOUT_MS,
    ),
  ]);

  const installed = collectTopLevelPackages(tryParseJson<DotnetListJson>(installedRes.stdout));
  const outdated = collectTopLevelPackages(tryParseJson<DotnetListJson>(outdatedRes.stdout));

  // Union so neither source can hide a package: the manifest catches projects the
  // CLI can't restore, the CLI catches packages pulled in by an imported .props.
  const names = new Set([...declared.map((p) => p.name), ...installed.keys()]);
  const declaredByName = new Map(declared.map((p) => [p.name, p]));
  const degraded = names.size > 0 && installed.size === 0;

  const packages = await mapWithConcurrency([...names], REGISTRY_CONCURRENCY, async (name) => {
    const resolved = installed.get(name);
    const currentVersion =
      resolved?.resolvedVersion ??
      resolved?.requestedVersion ??
      declaredByName.get(name)?.version ??
      'unknown';
    let latestVersion = outdated.get(name)?.latestVersion ?? null;
    // The CLI only lists packages it considers outdated, so a miss here is
    // ambiguous: up to date, or never resolved at all. Only ask NuGet directly
    // in the latter case.
    if (latestVersion === null && !resolved) latestVersion = await fetchLatestFromNuget(name);

    const isOutdated =
      latestVersion !== null && currentVersion !== 'unknown' && latestVersion !== currentVersion;
    return {
      name,
      currentVersion,
      latestVersion: isOutdated ? latestVersion : currentVersion,
      isOutdated,
      isDev: false,
      isInstalled: resolved !== undefined,
      manifestPath: projectPath,
      projectLabel,
    } satisfies PackageInfo;
  });

  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { projectLabel, degraded, packages };
}

async function detect(folderPath: string): Promise<boolean> {
  const files = await findProjectFiles(folderPath);
  return files.length > 0;
}

// --- Runtime targets --------------------------------------------------------

/** The nearest `name` from `startDir` up to and including the scan root. */
async function nearestFile(
  rootFolder: string,
  startDir: string,
  name: string,
): Promise<string | null> {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, name);
    if ((await readFileSafe(candidate)) !== null) return candidate;
    const parent = dirname(dir);
    if (parent === dir || relative(rootFolder, dir) === '') return null;
    dir = parent;
  }
}

function targetFrameworkCandidate(
  rootFolder: string,
  holderPath: string,
  declared: DeclaredTargetFramework,
  channel: DotnetChannel | null,
): RuntimeCandidate | null {
  const projectLabel = PROJECT_EXTENSIONS.some((ext) => holderPath.toLowerCase().endsWith(ext))
    ? basename(holderPath).replace(/\.(cs|vb|fs)proj$/i, '')
    : relative(rootFolder, holderPath);
  const base = {
    kind: 'dotnet',
    source: 'target-framework',
    declared: declared.declared,
    latestVersion: channel?.channel ?? null,
    manifestPath: holderPath,
    projectLabel,
    rewrite: rewriteTargetFramework,
  } as const;

  if (declared.multiple) {
    // A multi-targeted library usually means it on purpose, so the list is only reported.
    const versions = declared.declared
      .split(';')
      .map((tfm) => parseTargetFramework(tfm)?.version)
      .filter((v): v is string => Boolean(v))
      .sort(compareVersions);
    const highest = versions.at(-1);
    if (!highest) return null;
    return runtimeCandidate({ ...base, currentVersion: highest, next: null, requires: null });
  }

  const parsed = parseTargetFramework(declared.declared);
  if (!parsed) return null; // .NET Framework or netstandard, which are not moved this way
  return runtimeCandidate({
    ...base,
    currentVersion: parsed.version,
    next: (latest) => `net${latest}${parsed.suffix}`,
    requires: (latest) => ({
      toolchain: 'dotnet-sdk',
      minVersion: `${latest.split('.')[0]}.0.100`,
    }),
  });
}

/**
 * The target framework of each project (or the Directory.Build.props it inherits one from) and
 * the global.json SDK pin. A file several projects share shows up once.
 */
async function dotnetRuntimeCandidates(
  rootFolder: string,
  projectFiles: string[],
): Promise<RuntimeCandidate[]> {
  const channel = await runtimeFeeds.dotnet();
  const seen = new Set<string>();
  const candidates: RuntimeCandidate[] = [];

  for (const projectPath of projectFiles) {
    const projectDir = dirname(projectPath);
    let holder: string | null = projectPath;
    const projectXml = await readFileSafe(projectPath);
    let declared = projectXml ? readTargetFramework(projectXml) : null;
    if (!declared) {
      holder = await nearestFile(rootFolder, projectDir, 'Directory.Build.props');
      const propsXml = holder ? await readFileSafe(holder) : null;
      declared = propsXml ? readTargetFramework(propsXml) : null;
    }
    if (holder && declared && !seen.has(holder)) {
      seen.add(holder);
      const candidate = targetFrameworkCandidate(rootFolder, holder, declared, channel);
      if (candidate) candidates.push(candidate);
    }

    const globalJson = await nearestFile(rootFolder, projectDir, 'global.json');
    if (globalJson && !seen.has(globalJson)) {
      seen.add(globalJson);
      const source = await readFileSafe(globalJson);
      const version = source ? readGlobalJsonSdk(source) : null;
      if (version) {
        candidates.push(
          runtimeCandidate({
            kind: 'dotnet',
            source: 'global-json',
            declared: version,
            currentVersion: version,
            latestVersion: channel?.latestSdk ?? null,
            next: (latest) => latest,
            requires: (latest) => ({ toolchain: 'dotnet-sdk', minVersion: latest }),
            manifestPath: globalJson,
            projectLabel: relative(rootFolder, globalJson),
            rewrite: rewriteGlobalJsonSdk,
          }),
        );
      }
    }
  }
  return candidates;
}

async function listSection(folderPath: string): Promise<PackageManagerSection> {
  const projectFiles = await findProjectFiles(folderPath);
  const base = {
    ecosystem: 'dotnet',
    manager: 'nuget',
    toolchain: 'dotnet-sdk',
    runtimes: (await dotnetRuntimeCandidates(folderPath, projectFiles)).map((c) => c.target),
  } as const;
  if (projectFiles.length === 0) {
    return { ...base, status: 'ok', message: null, packages: [] };
  }

  let outcomes: ProjectScanOutcome[];
  try {
    outcomes = await mapWithConcurrency(projectFiles, LIST_CONCURRENCY, (path) =>
      listPackagesForProject(folderPath, path),
    );
  } catch (err) {
    if (err instanceof CliNotFoundError) {
      return {
        ...base,
        status: 'cli-missing',
        message: 'Install the .NET SDK to manage NuGet packages for this project.',
        packages: [],
      };
    }
    return {
      ...base,
      status: 'error',
      message: err instanceof Error ? err.message : 'Failed to list NuGet packages.',
      packages: [],
    };
  }

  const degraded = outcomes.filter((o) => o.degraded && o.packages.length > 0);
  const message =
    degraded.length > 0
      ? `Could not restore ${degraded.map((o) => o.projectLabel).join(', ')}, so versions for ${degraded.length === 1 ? 'it are' : 'those are'} read from the project file and may not reflect what is resolved at build time.`
      : null;

  return { ...base, status: 'ok', message, packages: outcomes.flatMap((o) => o.packages) };
}

async function updatePackages(
  _folderPath: string,
  updates: PackageUpdateRequest[],
  onProgress: (tick: UpdateProgressTick) => void,
): Promise<PackageUpdateResult> {
  const total = updates.length;
  const results: PackageUpdateItemResult[] = [];
  let completed = 0;

  // Run sequentially: concurrent `dotnet add` calls against different .csproj
  // in the same solution can race on the shared NuGet global-packages cache.
  for (const update of updates) {
    onProgress({ packageName: update.name, status: 'running', completed, total });
    const { code, stdout, stderr } = await runCli(
      'dotnet',
      ['add', update.manifestPath, 'package', update.name, '--version', update.targetVersion],
      dirname(update.manifestPath),
      2 * 60 * 1000,
    );
    const ok = code === 0;
    const message = ok
      ? 'Updated'
      : (stderr || stdout).slice(-500) || `dotnet exited with code ${code}`;
    completed++;
    results.push({ name: update.name, ok, message });
    onProgress({
      packageName: update.name,
      status: ok ? 'done' : 'error',
      message: ok ? undefined : message,
      completed,
      total,
    });
  }

  return { ok: results.every((r) => r.ok), results };
}

async function updateRuntime(
  folderPath: string,
  request: RuntimeUpdateRequest,
  deps: RuntimeUpdateDeps,
): Promise<RuntimeUpdateResult> {
  const candidates = await dotnetRuntimeCandidates(folderPath, await findProjectFiles(folderPath));
  return applyRuntimeUpdate(request, candidates, deps);
}

export const dotnetAdapter: PackageManagerAdapter = {
  ecosystem: 'dotnet',
  detect,
  listPackages: async (folderPath) => [await listSection(folderPath)],
  updatePackages,
  updateRuntime,
};
