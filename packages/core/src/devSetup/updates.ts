import { androidPackagesFor } from './androidRepository.js';
import { type DevSetupEnvironment, linuxPackageChoice, selectRecipe } from './recipes.js';
import type { DevItem, DevItemUpdate, DevUpdateCheck, DevUpdateSource } from './types.js';
import { compareVersions, parseVersion } from './version.js';

/**
 * Knowing which installed tools have a newer version. The rule is to ask whatever will do the
 * update: winget for a winget recipe, Homebrew for a brew one, the registry for an npm package. Then
 * the chip on a row and the button next to it cannot disagree, which a vendor's release page could
 * (winget lags a release by hours or days).
 *
 * Everything here is pure: which source answers for an item, and how each source's output reads.
 * The commands and the network live in the desktop app.
 */

export type DevUpdateQuery =
  | { source: 'winget'; id: string }
  | { source: 'brew'; name: string }
  | { source: 'apt-get' | 'dnf' | 'pacman'; packages: readonly string[] }
  | { source: 'npm'; package: string }
  | { source: 'nuget'; package: string }
  | { source: 'flutter' }
  | { source: 'sdkmanager'; package: string };

/** What one source says about one package: the version it has, and the one it would move to. */
export interface UpdateOffer {
  installed: string | null;
  latest: string;
}

/**
 * What to ask, and of whom, to learn whether this item has an update. Null for the rows an update
 * does not apply to: ones that come with another tool (npm with Node.js), steps (signing in to
 * GitHub, accepting licenses), download pages, and anything installed by a route with no way to ask.
 */
export function updateQueryFor(
  item: DevItem,
  environment: DevSetupEnvironment,
): DevUpdateQuery | null {
  const mode = selectRecipe(item, { ...environment, intent: 'update' });
  if (mode.mode !== 'in-app' && mode.mode !== 'terminal') return null;
  const { recipe } = mode;

  switch (recipe.kind) {
    case 'winget':
      return { source: 'winget', id: recipe.id };
    case 'brew':
      return { source: 'brew', name: recipe.formula };
    case 'brew-cask':
      return { source: 'brew', name: recipe.cask };
    case 'pkg': {
      const choice = linuxPackageChoice(recipe, environment.packageManagers);
      return choice ? { source: choice.manager, packages: choice.packages } : null;
    }
    case 'npm-global':
      return { source: 'npm', package: recipe.pkg };
    case 'dotnet-tool':
      return { source: 'nuget', package: recipe.pkg };
    case 'managed': {
      if (recipe.installer === 'flutter-archive') return { source: 'flutter' };
      // The command-line tools cannot replace themselves while they run (on Windows the file is
      // locked), and licenses and Docker's launch are steps, not versions.
      if (recipe.installer !== 'android-package') return null;
      const sdkPackage = androidPackagesFor(environment.arch)[item.id];
      return sdkPackage ? { source: 'sdkmanager', package: sdkPackage } : null;
    }
    default:
      return null;
  }
}

/** Which source an item is asked of, for grouping the questions into one call per source. */
export function updateSourceFor(
  item: DevItem,
  environment: DevSetupEnvironment,
): DevUpdateSource | null {
  return updateQueryFor(item, environment)?.source ?? null;
}

const VERSION_LIKE = /^\d/;

/**
 * The row `winget upgrade` prints for `id`. winget draws a table whose columns move with the
 * longest name and whose headers follow the system language, so this reads by position from the
 * id instead: the two words after it are the installed and the available version. Spinner lines
 * and the footer have no id in them and fall through.
 */
export function findWingetUpgrade(output: string, id: string): UpdateOffer | null {
  const wanted = id.toLowerCase();
  for (const line of output.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/);
    const at = words.findIndex((word) => word.toLowerCase() === wanted);
    // Something always comes before the id: the name.
    if (at < 1) continue;
    const installed = words[at + 1];
    const latest = words[at + 2];
    if (!installed || !latest || !VERSION_LIKE.test(latest)) continue;
    return { installed: VERSION_LIKE.test(installed) ? installed : null, latest };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The newest of the versions brew lists as installed, which is the one a command would run. */
function newestInstalled(value: unknown): string | null {
  const versions = (Array.isArray(value) ? value : [value]).filter(
    (one): one is string => typeof one === 'string' && one.length > 0,
  );
  return versions.reduce<string | null>(
    (best, one) => (best === null || compareVersions(one, best) > 0 ? one : best),
    null,
  );
}

/** `brew outdated --json=v2`, by formula or cask name. Null when the text is not that JSON. */
export function parseBrewOutdated(json: string): Map<string, UpdateOffer> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const outdated = new Map<string, UpdateOffer>();
  for (const key of ['formulae', 'casks']) {
    const list = parsed[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry.name !== 'string') continue;
      const latest = entry.current_version;
      if (typeof latest !== 'string' || !latest) continue;
      outdated.set(entry.name, { installed: newestInstalled(entry.installed_versions), latest });
    }
  }
  return outdated;
}

/** `apt list --upgradable`: `git/jammy-updates 1:2.34.1-1 amd64 [upgradable from: 1:2.34.0-1]`. */
export function parseAptUpgradable(text: string): Map<string, UpdateOffer> {
  const upgradable = new Map<string, UpdateOffer>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([^\s/]+)\/\S+\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+?)\s*\])?/.exec(
      line.trim(),
    );
    if (!match?.[1] || !match[2]) continue;
    upgradable.set(match[1], { installed: match[3] ?? null, latest: match[2] });
  }
  return upgradable;
}

const DNF_ARCH = /\.(?:x86_64|aarch64|noarch|i686|armv7hl|ppc64le|s390x)$/;

/** `dnf check-update`: `git.x86_64   2.43.5-1.fc40   updates`, up to the obsoleting section. */
export function parseDnfCheckUpdate(text: string): Map<string, UpdateOffer> {
  const upgradable = new Map<string, UpdateOffer>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^Obsoleting Packages/i.test(line)) break;
    const words = line.split(/\s+/);
    const [nameAndArch, version] = words;
    if (words.length < 3 || !nameAndArch || !version || !DNF_ARCH.test(nameAndArch)) continue;
    upgradable.set(nameAndArch.replace(DNF_ARCH, ''), {
      installed: null,
      latest: version.replace(/^\d+:/, ''),
    });
  }
  return upgradable;
}

/** `pacman -Qu`: `github-cli 2.62.0-1 -> 2.70.0-1`. */
export function parsePacmanQu(text: string): Map<string, UpdateOffer> {
  const upgradable = new Map<string, UpdateOffer>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+->\s+(\S+)/.exec(line.trim());
    if (match?.[1] && match[2] && match[3]) {
      upgradable.set(match[1], { installed: match[2], latest: match[3] });
    }
  }
  return upgradable;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Package ids are written with `;` in this app and the newer sdkmanager prints them with `/`. */
function sdkPackageId(raw: string): string {
  return raw.replaceAll('/', ';');
}

/**
 * What `sdkmanager --list` says is out of date. The current tool marks it inside the installed
 * table (`emulator   36.5.11   ->   37.2.12`, columns told apart by runs of spaces), and older ones
 * list it in an "Available Updates" table. `answered` is false for output that is not the list at
 * all (an error, a missing Java), which must not read as "nothing to update".
 */
export function parseSdkManagerUpdates(text: string): {
  answered: boolean;
  updates: Map<string, UpdateOffer>;
} {
  const updates = new Map<string, UpdateOffer>();
  let answered = false;
  let section: 'installed' | 'updates' | 'other' = 'other';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').trim();
    if (/^installed packages:/i.test(line)) {
      answered = true;
      section = 'installed';
      continue;
    }
    if (/^available updates:/i.test(line)) {
      section = 'updates';
      continue;
    }
    if (/^available packages:/i.test(line)) {
      section = 'other';
      continue;
    }

    if (section === 'installed') {
      const [id, installed, arrow, latest] = line.split(/\s{2,}/);
      if (id && installed && arrow === '->' && latest) {
        updates.set(sdkPackageId(id), { installed, latest });
      }
    } else if (section === 'updates') {
      const [id, installed, latest] = line.split('|').map((cell) => cell.trim());
      if (!id || !installed || !latest || /^(id|-+)$/i.test(id) || /^-+$/.test(installed)) continue;
      updates.set(sdkPackageId(id), { installed, latest });
    }
  }
  return { answered, updates };
}

/** The newest version a NuGet package has that is not a preview, from its flat-container index. */
export function latestStableNuGet(index: unknown): string | null {
  if (!isRecord(index) || !Array.isArray(index.versions)) return null;
  const stable = index.versions.filter(
    (version): version is string => typeof version === 'string' && /^\d+(?:\.\d+)*$/.test(version),
  );
  return stable.reduce<string | null>(
    (best, one) => (best === null || compareVersions(one, best) > 0 ? one : best),
    null,
  );
}

/**
 * For a source that only names the newest version (a registry, Flutter's list): an update when it
 * is ahead of what the probe read. With either missing there is nothing to compare, which is not
 * the same as being up to date.
 */
export function feedUpdateCheck(installed: string | null, latest: string | null): DevUpdateCheck {
  if (!installed || !latest) return { state: 'unknown' };
  if (compareVersions(latest, installed) <= 0) return { state: 'current' };
  return { state: 'update', latest, installed: null };
}

/** The first two numbers of a version. Two versions agree on these only if they are one product. */
function leadingParts(version: string): number[] {
  return version
    .split('.')
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function sameScale(a: string, b: string): boolean {
  const left = leadingParts(a);
  const right = leadingParts(b);
  return [0, 1].every((index) => (left[index] ?? 0) === (right[index] ?? 0));
}

/**
 * What a row shows for a check, or null when there is nothing to show. `latest` is set only when
 * it can be set beside the installed version without confusing anyone: the source's own installed
 * version must be the probe's (Docker Desktop 4.96 and the engine's 28.x are not), and the newer
 * one is cut to three parts like the probe's, so a change only in winget's fourth part ("2.55.0.1"
 * to "2.55.0.2") says "Update available" instead of naming a version that looks the same.
 */
export function resolveItemUpdate(
  detected: string | null,
  check: DevUpdateCheck | undefined,
): DevItemUpdate | null {
  if (check?.state !== 'update') return null;
  if (!check.latest) return { latest: null };
  if (check.installed && (!detected || !sameScale(check.installed, detected))) {
    return { latest: null };
  }
  const shown = parseVersion(check.latest) ?? check.latest;
  if (detected && compareVersions(shown, detected) <= 0) return { latest: null };
  return { latest: shown };
}
