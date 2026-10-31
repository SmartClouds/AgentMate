import type { PackageInfo, PackageManagerSection, RuntimeTarget } from '@shared/apiTypes';

export type BumpKind = 'major' | 'minor' | 'patch';

function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const cleaned = version.trim().replace(/^[~^>=<\s]+/, '');
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

export function bumpKind(current: string, latest: string): BumpKind | null {
  const from = parseSemver(current);
  const to = parseSemver(latest);
  if (!from || !to) return null;
  if (to.major !== from.major) return 'major';
  if (to.minor !== from.minor) return 'minor';
  if (to.patch !== from.patch) return 'patch';
  return null;
}

function managerName(section: PackageManagerSection): string {
  if (section.ecosystem === 'dotnet') return 'NuGet';
  return section.manager;
}

function installHint(section: PackageManagerSection): string {
  if (section.ecosystem === 'dotnet') {
    return 'dotnet add <project.csproj> package <Name> --version <version>';
  }
  if (section.ecosystem === 'dart') {
    return 'flutter pub add <name>:^<version> (dart pub add for plain Dart packages, prefix dev: for dev dependencies)';
  }
  if (section.manager === 'yarn') return 'yarn add <name>@<version> (add -D for dev dependencies)';
  if (section.manager === 'pnpm') return 'pnpm add <name>@<version> (add -D for dev dependencies)';
  if (section.manager === 'bun') return 'bun add <name>@<version> (add -d for dev dependencies)';
  return 'npm install <name>@<version> (add -D for dev dependencies)';
}

const RUNTIME_NAMES: Record<RuntimeTarget['kind'], string> = {
  bun: 'Bun',
  node: 'Node.js',
  pnpm: 'pnpm',
  npm: 'npm',
  yarn: 'Yarn',
  dotnet: '.NET',
  dart: 'Dart SDK',
  flutter: 'Flutter SDK',
};

/** What a runtime row is called: "Dart SDK", ".NET target framework", "Bun (packageManager)". */
export function runtimeLabel(target: RuntimeTarget): string {
  switch (target.source) {
    case 'target-framework':
      return '.NET target framework';
    case 'global-json':
      return '.NET SDK (global.json)';
    case 'packageManager':
      return `${RUNTIME_NAMES[target.kind]} (packageManager)`;
    case 'engines':
      return `${RUNTIME_NAMES[target.kind]} (engines)`;
    default:
      return RUNTIME_NAMES[target.kind];
  }
}

/** The runtime targets that have a newer version, the ones an update or the prompt is about. */
export function outdatedRuntimes(section: PackageManagerSection): RuntimeTarget[] {
  return section.runtimes.filter((target) => target.isOutdated && target.latestVersion);
}

/** Unique names in display order, one per line. */
export function buildPackageNames(packages: PackageInfo[]): string {
  const names = [...new Set(packages.map((pkg) => pkg.name))].sort((a, b) => a.localeCompare(b));
  return names.join('\n');
}

export type PackageCommitMode = 'none' | 'single' | 'each';

/** The choices the "Update with AI" dialog puts into the prompt. */
export interface PackageUpdatePromptOptions {
  /** Leave major bumps out of the list, and say they were left out. */
  skipMajor?: boolean;
  /** Ask the agent to run the project's checks after updating. On unless turned off. */
  runChecks?: boolean;
  commit?: PackageCommitMode;
  /** Free text from the user, added as is. */
  notes?: string;
  /** Put the section's outdated runtime targets in the prompt too. On unless turned off. */
  includeRuntimes?: boolean;
}

function runtimeLine(target: RuntimeTarget): string {
  const to =
    target.nextDeclared ??
    `${target.latestVersion} (write it in the same style as the current value)`;
  return `- ${runtimeLabel(target)} in ${target.projectLabel} (${target.manifestPath}): ${target.declared} -> ${to}`;
}

/** The step that tells the agent how to go about a runtime move, per kind of runtime. */
function runtimeStep(runtimes: RuntimeTarget[]): string {
  const notes: string[] = [];
  if (runtimes.some((t) => t.source === 'target-framework' || t.source === 'global-json')) {
    notes.push(
      'for .NET, move the Microsoft.* and System.* packages that follow the framework to the matching major version in the same change, and make sure global.json (if any) allows an SDK that can build the new target',
    );
  }
  if (runtimes.some((t) => t.kind === 'dart' || t.kind === 'flutter')) {
    notes.push(
      'for Dart and Flutter, run pub get and dart analyze, and fix the language and API changes the new SDK reports',
    );
  }
  if (runtimes.some((t) => t.source === 'packageManager' || t.source === 'engines')) {
    notes.push(
      'for the JavaScript runtime, reinstall so the lockfile is written by the new version',
    );
  }
  const howTo = notes.length > 0 ? ` In particular, ${notes.join('; ')}.` : '';
  return `Start with the runtime, before any package. Change the values listed under Runtime, make sure the installed toolchain is at least that new (upgrade it first if not), and read the release notes or migration guide for the versions in between.${howTo}`;
}

/** The packages the prompt would list, after the options have had their say. */
export function promptPackages(
  packages: PackageInfo[],
  options: PackageUpdatePromptOptions = {},
): PackageInfo[] {
  if (!options.skipMajor) return packages;
  return packages.filter(
    (pkg) => !pkg.latestVersion || bumpKind(pkg.currentVersion, pkg.latestVersion) !== 'major',
  );
}

function commitStep(mode: PackageCommitMode | undefined): string | null {
  if (mode === 'single') {
    return 'When everything passes, commit all of the updates together in one commit with a short message that lists the packages.';
  }
  if (mode === 'each') {
    return 'Commit each package on its own once it passes, so any single update can be reverted. Name the package and both versions in the message.';
  }
  return null;
}

/** A prompt an agent can act on to update the given packages to their latest versions. */
export function buildPackageUpdatePrompt(
  section: PackageManagerSection,
  allPackages: PackageInfo[],
  options: PackageUpdatePromptOptions = {},
): string {
  const packages = promptPackages(allPackages, options);
  const skippedMajor = allPackages.length - packages.length;
  const manager = managerName(section);
  const byManifest = new Map<string, PackageInfo[]>();
  for (const pkg of packages) {
    const list = byManifest.get(pkg.manifestPath) ?? [];
    list.push(pkg);
    byManifest.set(pkg.manifestPath, list);
  }

  let majorCount = 0;
  const blocks: string[] = [];
  for (const [manifestPath, list] of [...byManifest.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const label = list[0]?.projectLabel;
    const heading = label ? `${label} (${manifestPath})` : manifestPath;
    const lines = [...list]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((pkg) => {
        const target = pkg.latestVersion ?? 'latest (version lookup failed, check the registry)';
        const bump = pkg.latestVersion ? bumpKind(pkg.currentVersion, pkg.latestVersion) : null;
        if (bump === 'major') majorCount += 1;
        const tags = [bump, pkg.isDev ? 'dev' : null].filter(Boolean).join(', ');
        return `- ${pkg.name}: ${pkg.currentVersion} -> ${target}${tags ? ` (${tags})` : ''}`;
      });
    blocks.push(`${heading}\n${lines.join('\n')}`);
  }

  const count = packages.length;
  const runtimes = options.includeRuntimes === false ? [] : outdatedRuntimes(section);
  const runtimeNames = [...new Set(runtimes.map(runtimeLabel))].join(', ');
  const steps = [
    runtimes.length > 0 ? runtimeStep(runtimes) : null,
    count > 0
      ? `Update each package with ${manager}, for example: ${installHint(section)}. Keep the existing version range style (^, ~, exact) in the manifest.`
      : null,
    majorCount > 0
      ? `${majorCount} of these ${majorCount === 1 ? 'is a major bump' : 'are major bumps'}. Before updating those, read the changelog or migration guide and fix any breaking changes in the code.`
      : null,
    skippedMajor > 0
      ? `Leave major version bumps alone this time. ${skippedMajor} outdated package${skippedMajor === 1 ? ' was' : 's were'} left off the list for that reason.`
      : null,
    runtimes.length > 0
      ? 'Only touch what is listed here and what the runtime move itself needs. If something forces another package to move (peer dependencies, shared versions), say so and explain why.'
      : 'Only touch the packages listed here. If one package forces another to move (peer dependencies, shared versions), say so and explain why.',
    options.runChecks === false
      ? null
      : 'After updating, run the typecheck, lint, tests, and build the project already uses, and fix anything that breaks.',
    'If a package cannot be updated cleanly, leave it at its current version and tell me what blocked it.',
    commitStep(options.commit),
  ].filter((step): step is string => step !== null);

  const notes = options.notes?.trim();
  const packagesGoal = `${count} outdated ${manager} package${count === 1 ? '' : 's'}`;
  const goal =
    runtimes.length === 0
      ? `Update ${packagesGoal} in this project to their latest versions.`
      : count === 0
        ? `Move this project to the latest ${runtimeNames}.`
        : `Move this project to the latest ${runtimeNames}, then update ${packagesGoal} to their latest versions.`;
  return [
    goal,
    ...(runtimes.length > 0
      ? ['', 'Runtime (current -> target):', '', runtimes.map(runtimeLine).join('\n')]
      : []),
    ...(count > 0 ? ['', 'Packages (current -> latest):', '', blocks.join('\n\n')] : []),
    '',
    'How to do it:',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    ...(notes ? ['', 'Also keep this in mind:', notes] : []),
    '',
    'When you are done, give me a short summary of what changed and anything that was left behind.',
  ].join('\n');
}
