import type { DevArch, DevItem, DevItemId, DevOs, DevRecipe } from './types.js';

/**
 * Turning an item's list of recipes into the one thing the app will do for it on this machine:
 * install it inside the app, hand a command to the terminal, point at a download page, or note
 * that it arrives with something else. Pure, so every OS can be tested from any OS.
 */

export type PackageManagerId = 'winget' | 'brew' | 'apt-get' | 'dnf' | 'pacman';
export type InstallIntent = 'install' | 'update';

export interface RecipeContext {
  os: DevOs;
  arch: DevArch;
  /** The package managers found on this machine. */
  packageManagers: readonly PackageManagerId[];
  /** Update changes `install` to `upgrade` where a manager distinguishes them. */
  intent?: InstallIntent;
}

/** What the app learns about the machine once: its OS, CPU and which package managers exist. */
export type DevSetupEnvironment = Pick<RecipeContext, 'os' | 'arch' | 'packageManagers'>;

export type TerminalReason = 'needs-admin' | 'interactive';

export type InstallMode =
  | {
      mode: 'in-app';
      recipe: DevRecipe;
      intent: InstallIntent;
      /** Items that must be installed first because the recipe runs through them. */
      implies: DevItemId[];
    }
  | {
      mode: 'terminal';
      recipe: DevRecipe;
      intent: InstallIntent;
      command: string;
      reason: TerminalReason;
      implies: DevItemId[];
    }
  | { mode: 'bundled'; with: DevItemId }
  | { mode: 'link'; url: string; reason: 'no-package-manager' | 'no-recipe' }
  | { mode: 'unavailable' };

/** The order Linux package managers are tried in. */
const LINUX_MANAGERS = ['apt-get', 'dnf', 'pacman'] as const;

function wingetArgv(id: string, intent: InstallIntent): string[] {
  return [
    'winget',
    intent === 'update' ? 'upgrade' : 'install',
    '--id',
    id,
    '--exact',
    '--source',
    'winget',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements',
  ];
}

/** The command a package-manager recipe runs, or null for recipes that are not one command. */
export function recipeArgv(recipe: DevRecipe, intent: InstallIntent = 'install'): string[] | null {
  switch (recipe.kind) {
    case 'winget':
      return wingetArgv(recipe.id, intent);
    case 'brew':
      return ['brew', intent === 'update' ? 'upgrade' : 'install', recipe.formula];
    case 'brew-cask':
      return ['brew', intent === 'update' ? 'upgrade' : 'install', '--cask', recipe.cask];
    case 'npm-global':
      return ['npm', 'install', '--global', recipe.pkg];
    case 'dotnet-tool':
      return ['dotnet', 'tool', intent === 'update' ? 'update' : 'install', '--global', recipe.pkg];
    default:
      return null;
  }
}

/** Quotes one argument for display and for pasting into a terminal on `os`. */
export function quoteShellArg(arg: string, os: DevOs): string {
  if (arg !== '' && /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) return arg;
  if (os === 'win32') return `"${arg.replaceAll('"', '\\"')}"`;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function joinCommand(argv: readonly string[], os: DevOs): string {
  return argv.map((arg) => quoteShellArg(arg, os)).join(' ');
}

export type LinuxPackageManagerId = (typeof LINUX_MANAGERS)[number];

/** The first Linux manager on this machine that has a package for the recipe, and which packages. */
export function linuxPackageChoice(
  recipe: Extract<DevRecipe, { kind: 'pkg' }>,
  available: readonly PackageManagerId[],
): { manager: LinuxPackageManagerId; packages: readonly string[] } | null {
  for (const manager of LINUX_MANAGERS) {
    if (!available.includes(manager)) continue;
    const packages =
      manager === 'apt-get' ? recipe.apt : manager === 'dnf' ? recipe.dnf : recipe.pacman;
    if (packages?.length) return { manager, packages };
  }
  return null;
}

function linuxPackageCommand(
  recipe: Extract<DevRecipe, { kind: 'pkg' }>,
  available: readonly PackageManagerId[],
  intent: InstallIntent,
): string | null {
  const choice = linuxPackageChoice(recipe, available);
  if (!choice) return null;
  const { manager, packages } = choice;
  if (manager === 'apt-get') {
    const flags = intent === 'update' ? ['-y', '--only-upgrade'] : ['-y'];
    return ['sudo', 'apt-get', 'install', ...flags, ...packages].join(' ');
  }
  if (manager === 'dnf') {
    return ['sudo', 'dnf', intent === 'update' ? 'upgrade' : 'install', '-y', ...packages].join(
      ' ',
    );
  }
  return ['sudo', 'pacman', '-S', '--noconfirm', ...packages].join(' ');
}

/**
 * Walks the item's recipes for this OS in order and returns the first one this machine can use.
 * A recipe skipped only because its package manager is missing makes the fallback a download link
 * with a reason that says so, which is a different thing to tell the user than "no recipe".
 */
export function selectRecipe(item: DevItem, context: RecipeContext): InstallMode {
  const intent = context.intent ?? 'install';
  let skippedForManager = false;

  for (const recipe of item.recipes[context.os] ?? []) {
    switch (recipe.kind) {
      case 'winget':
        if (!context.packageManagers.includes('winget')) {
          skippedForManager = true;
          break;
        }
        return { mode: 'in-app', recipe, intent, implies: [] };
      case 'brew':
        return { mode: 'in-app', recipe, intent, implies: ['homebrew'] };
      case 'brew-cask':
        if (recipe.needsAdmin) {
          const argv = recipeArgv(recipe, intent) ?? [];
          return {
            mode: 'terminal',
            recipe,
            intent,
            command: joinCommand(argv, context.os),
            reason: 'needs-admin',
            implies: ['homebrew'],
          };
        }
        return { mode: 'in-app', recipe, intent, implies: ['homebrew'] };
      case 'pkg': {
        const command = linuxPackageCommand(recipe, context.packageManagers, intent);
        if (!command) {
          skippedForManager = true;
          break;
        }
        return {
          mode: 'terminal',
          recipe,
          intent,
          command,
          reason: 'needs-admin',
          implies: [],
        };
      }
      case 'npm-global':
      case 'dotnet-tool':
      case 'managed':
        return { mode: 'in-app', recipe, intent, implies: [] };
      case 'bundled':
        return { mode: 'bundled', with: recipe.with };
      case 'terminal-only':
        return {
          mode: 'terminal',
          recipe,
          intent,
          command: recipe.command,
          reason: 'interactive',
          implies: [],
        };
      case 'link':
        return { mode: 'link', url: recipe.url, reason: 'no-recipe' };
    }
  }

  if (item.manualUrl) {
    return {
      mode: 'link',
      url: item.manualUrl,
      reason: skippedForManager ? 'no-package-manager' : 'no-recipe',
    };
  }
  return { mode: 'unavailable' };
}

/**
 * The command a person could run by hand to get the same result, for "Copy command" and "Open in
 * terminal". Null when there is no single command: Runova's own installers, bundled items and
 * download pages.
 */
export function recipeCommandLine(mode: InstallMode, os: DevOs): string | null {
  if (mode.mode === 'terminal') return mode.command;
  if (mode.mode !== 'in-app') return null;
  const argv = recipeArgv(mode.recipe, mode.intent);
  return argv ? joinCommand(argv, os) : null;
}
