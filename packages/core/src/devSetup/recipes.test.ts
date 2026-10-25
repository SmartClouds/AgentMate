import { describe, expect, it } from 'vitest';
import { getDevItem } from './catalog.js';
import {
  linuxPackageChoice,
  quoteShellArg,
  type RecipeContext,
  recipeArgv,
  recipeCommandLine,
  selectRecipe,
} from './recipes.js';
import type { DevItem } from './types.js';

const item = (id: string): DevItem => {
  const found = getDevItem(id);
  if (!found) throw new Error(`no catalog item ${id}`);
  return found;
};

const win: RecipeContext = { os: 'win32', arch: 'x64', packageManagers: ['winget'] };
const mac: RecipeContext = { os: 'darwin', arch: 'arm64', packageManagers: ['brew'] };
const ubuntu: RecipeContext = { os: 'linux', arch: 'x64', packageManagers: ['apt-get'] };

describe('recipeArgv', () => {
  it('builds the exact silent winget install', () => {
    expect(recipeArgv({ kind: 'winget', id: 'Git.Git' })).toEqual([
      'winget',
      'install',
      '--id',
      'Git.Git',
      '--exact',
      '--source',
      'winget',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ]);
  });

  it('uses upgrade for an update', () => {
    const argv = recipeArgv({ kind: 'winget', id: 'Git.Git' }, 'update');
    expect(argv?.slice(0, 4)).toEqual(['winget', 'upgrade', '--id', 'Git.Git']);
  });

  it('covers brew, casks, npm and dotnet tools', () => {
    expect(recipeArgv({ kind: 'brew', formula: 'gh' })).toEqual(['brew', 'install', 'gh']);
    expect(recipeArgv({ kind: 'brew', formula: 'gh' }, 'update')).toEqual([
      'brew',
      'upgrade',
      'gh',
    ]);
    expect(recipeArgv({ kind: 'brew-cask', cask: 'android-studio' })).toEqual([
      'brew',
      'install',
      '--cask',
      'android-studio',
    ]);
    expect(recipeArgv({ kind: 'npm-global', pkg: 'pnpm' })).toEqual([
      'npm',
      'install',
      '--global',
      'pnpm',
    ]);
    expect(recipeArgv({ kind: 'dotnet-tool', pkg: 'dotnet-ef' })).toEqual([
      'dotnet',
      'tool',
      'install',
      '--global',
      'dotnet-ef',
    ]);
    expect(recipeArgv({ kind: 'dotnet-tool', pkg: 'dotnet-ef' }, 'update')).toEqual([
      'dotnet',
      'tool',
      'update',
      '--global',
      'dotnet-ef',
    ]);
  });

  it('has no argv for recipes AgentMate runs itself or hands to the user', () => {
    expect(recipeArgv({ kind: 'managed', installer: 'flutter-archive' })).toBeNull();
    expect(recipeArgv({ kind: 'bundled', with: 'node' })).toBeNull();
    expect(recipeArgv({ kind: 'terminal-only', command: 'x' })).toBeNull();
    expect(recipeArgv({ kind: 'link', url: 'https://brew.sh' })).toBeNull();
    expect(recipeArgv({ kind: 'pkg', apt: ['git'] })).toBeNull();
  });
});

describe('selectRecipe on Windows', () => {
  it('installs with winget inside the app', () => {
    const mode = selectRecipe(item('git'), win);
    expect(mode).toMatchObject({ mode: 'in-app', recipe: { kind: 'winget', id: 'Git.Git' } });
  });

  it('falls back to the download page when winget is missing', () => {
    expect(selectRecipe(item('git'), { ...win, packageManagers: [] })).toEqual({
      mode: 'link',
      url: 'https://git-scm.com/downloads',
      reason: 'no-package-manager',
    });
  });

  it('runs a managed installer inside the app whatever package managers exist', () => {
    const mode = selectRecipe(item('flutter'), { ...win, packageManagers: [] });
    expect(mode).toMatchObject({
      mode: 'in-app',
      recipe: { kind: 'managed', installer: 'flutter-archive' },
    });
  });

  it('hands sign-in and WSL to the terminal because they ask questions or need permission', () => {
    expect(selectRecipe(item('gh-auth'), win)).toMatchObject({
      mode: 'terminal',
      command: 'gh auth login --web',
      reason: 'interactive',
    });
    expect(selectRecipe(item('wsl2'), win)).toMatchObject({
      mode: 'terminal',
      command: 'wsl --install --no-distribution',
    });
  });
});

describe('selectRecipe on macOS', () => {
  it('installs a formula with brew inside the app, and needs Homebrew first', () => {
    expect(selectRecipe(item('node'), mac)).toMatchObject({
      mode: 'in-app',
      recipe: { kind: 'brew', formula: 'node' },
      implies: ['homebrew'],
    });
  });

  it('sends a cask that needs an administrator password to the terminal', () => {
    expect(selectRecipe(item('dotnet-sdk'), mac)).toMatchObject({
      mode: 'terminal',
      command: 'brew install --cask dotnet-sdk',
      reason: 'needs-admin',
      implies: ['homebrew'],
    });
  });

  it('installs a cask that needs no password inside the app', () => {
    expect(selectRecipe(item('android-studio'), mac)).toMatchObject({
      mode: 'in-app',
      recipe: { kind: 'brew-cask', cask: 'android-studio' },
    });
  });

  it('takes Git from the Command Line Tools', () => {
    expect(selectRecipe(item('git'), mac)).toEqual({ mode: 'bundled', with: 'xcode-clt' });
  });

  it('needs nothing implied for the Homebrew installer itself', () => {
    expect(selectRecipe(item('homebrew'), mac)).toMatchObject({ mode: 'terminal', implies: [] });
  });
});

describe('selectRecipe on Linux', () => {
  it('always uses the terminal for distribution packages, since they need sudo', () => {
    expect(selectRecipe(item('git'), ubuntu)).toMatchObject({
      mode: 'terminal',
      command: 'sudo apt-get install -y git',
      reason: 'needs-admin',
    });
  });

  it('prefers apt-get, then dnf, then pacman, using each one its own package names', () => {
    const all: RecipeContext = { ...ubuntu, packageManagers: ['pacman', 'dnf', 'apt-get'] };
    expect(selectRecipe(item('gh'), all)).toMatchObject({ command: 'sudo apt-get install -y gh' });
    const noApt: RecipeContext = { ...ubuntu, packageManagers: ['pacman', 'dnf'] };
    expect(selectRecipe(item('gh'), noApt)).toMatchObject({ command: 'sudo dnf install -y gh' });
    const arch: RecipeContext = { ...ubuntu, packageManagers: ['pacman'] };
    expect(selectRecipe(item('gh'), arch)).toMatchObject({
      command: 'sudo pacman -S --noconfirm github-cli',
    });
  });

  it('installs several packages in one command', () => {
    expect(selectRecipe(item('node'), ubuntu)).toMatchObject({
      command: 'sudo apt-get install -y nodejs npm',
    });
  });

  it('falls back to the download page when no package manager is known', () => {
    expect(selectRecipe(item('git'), { ...ubuntu, packageManagers: [] })).toMatchObject({
      mode: 'link',
      reason: 'no-package-manager',
    });
  });
});

describe('selectRecipe in general', () => {
  it('reports a bundled item as arriving with its parent', () => {
    expect(selectRecipe(item('npm'), win)).toEqual({ mode: 'bundled', with: 'node' });
    expect(selectRecipe(item('dart'), win)).toEqual({ mode: 'bundled', with: 'flutter' });
  });

  it('runs npm and dotnet tools inside the app on every OS', () => {
    for (const ctx of [win, mac, ubuntu]) {
      expect(selectRecipe(item('pnpm'), ctx)).toMatchObject({
        mode: 'in-app',
        recipe: { kind: 'npm-global' },
      });
      expect(selectRecipe(item('dotnet-ef'), ctx)).toMatchObject({
        mode: 'in-app',
        recipe: { kind: 'dotnet-tool' },
      });
    }
  });

  it('launches Docker Desktop on Windows and a Mac, and uses systemctl on Linux', () => {
    expect(selectRecipe(item('docker-running'), win)).toMatchObject({
      mode: 'in-app',
      recipe: { kind: 'managed', installer: 'docker-launch' },
    });
    expect(selectRecipe(item('docker-running'), ubuntu)).toMatchObject({
      mode: 'terminal',
      command: 'sudo systemctl enable --now docker',
    });
  });

  it('is unavailable when there is neither a recipe nor a download page', () => {
    const bare: DevItem = {
      id: 'bare',
      name: 'Bare',
      description: 'Has no way to be installed.',
      stack: 'essentials',
      detect: { kind: 'command', command: 'bare', args: [] },
      recipes: {},
    };
    expect(selectRecipe(bare, win)).toEqual({ mode: 'unavailable' });
  });

  it('points an item with only a download page at that page', () => {
    const pageOnly: DevItem = {
      id: 'page-only',
      name: 'Page only',
      description: 'Has only a download page.',
      stack: 'essentials',
      detect: { kind: 'command', command: 'x', args: [] },
      recipes: {},
      manualUrl: 'https://brew.sh',
    };
    expect(selectRecipe(pageOnly, win)).toEqual({
      mode: 'link',
      url: 'https://brew.sh',
      reason: 'no-recipe',
    });
  });

  it('uses the update variants when asked to update', () => {
    const mode = selectRecipe(item('node'), { ...win, intent: 'update' });
    expect(mode).toMatchObject({ mode: 'in-app' });
    expect(recipeCommandLine(mode, win.os)).toContain('winget upgrade --id OpenJS.NodeJS.LTS');
  });
});

describe('linuxPackageChoice', () => {
  const recipe = {
    kind: 'pkg',
    apt: ['nodejs', 'npm'],
    dnf: ['nodejs'],
    pacman: ['nodejs'],
  } as const;

  it('takes the first manager on the machine that has a package, in apt, dnf, pacman order', () => {
    expect(linuxPackageChoice(recipe, ['pacman', 'dnf'])).toEqual({
      manager: 'dnf',
      packages: ['nodejs'],
    });
    expect(linuxPackageChoice(recipe, ['apt-get', 'dnf'])).toEqual({
      manager: 'apt-get',
      packages: ['nodejs', 'npm'],
    });
  });

  it('skips a manager the recipe has no package for', () => {
    expect(linuxPackageChoice({ kind: 'pkg', dnf: ['git'] }, ['apt-get', 'dnf'])).toEqual({
      manager: 'dnf',
      packages: ['git'],
    });
  });

  it('is null when none of the machine managers can install it', () => {
    expect(linuxPackageChoice(recipe, [])).toBeNull();
    expect(linuxPackageChoice({ kind: 'pkg', pacman: ['x'] }, ['apt-get'])).toBeNull();
  });
});

describe('recipeCommandLine', () => {
  it('gives the equivalent command for an in-app install, so it can be copied and run by hand', () => {
    expect(recipeCommandLine(selectRecipe(item('git'), win), 'win32')).toBe(
      'winget install --id Git.Git --exact --source winget --silent --accept-package-agreements --accept-source-agreements',
    );
    expect(recipeCommandLine(selectRecipe(item('node'), mac), 'darwin')).toBe('brew install node');
  });

  it('gives the terminal command as written', () => {
    expect(recipeCommandLine(selectRecipe(item('gh-auth'), win), 'win32')).toBe(
      'gh auth login --web',
    );
  });

  it('has no command for bundled, link, unavailable or managed installs', () => {
    expect(recipeCommandLine(selectRecipe(item('npm'), win), 'win32')).toBeNull();
    expect(
      recipeCommandLine(selectRecipe(item('git'), { ...win, packageManagers: [] }), 'win32'),
    ).toBeNull();
    expect(recipeCommandLine(selectRecipe(item('flutter'), win), 'win32')).toBeNull();
    expect(recipeCommandLine({ mode: 'unavailable' }, 'win32')).toBeNull();
  });
});

describe('quoteShellArg', () => {
  it('leaves plain words alone', () => {
    expect(quoteShellArg('Git.Git', 'win32')).toBe('Git.Git');
    expect(quoteShellArg('--accept-package-agreements', 'linux')).toBe(
      '--accept-package-agreements',
    );
  });

  it('wraps an argument with a space in double quotes on Windows', () => {
    expect(quoteShellArg('C:\\Program Files\\x', 'win32')).toBe('"C:\\Program Files\\x"');
  });

  it('wraps in single quotes elsewhere and escapes an embedded one', () => {
    expect(quoteShellArg('a b', 'darwin')).toBe("'a b'");
    expect(quoteShellArg("it's", 'linux')).toBe("'it'\\''s'");
  });

  it('quotes the empty string so it survives as an argument', () => {
    expect(quoteShellArg('', 'win32')).toBe('""');
    expect(quoteShellArg('', 'linux')).toBe("''");
  });
});
