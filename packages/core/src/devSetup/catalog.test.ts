import { describe, expect, it } from 'vitest';
import {
  applicableDependencies,
  appliesToOs,
  DEV_ITEMS,
  DEV_STACKS,
  expandPathTemplate,
  getDevItem,
  isDevItemId,
  itemsForStacks,
  normalizeDevSetupStacks,
} from './catalog.js';
import type { DevItem, DevOs, DevRecipe } from './types.js';

const OSES: DevOs[] = ['win32', 'darwin', 'linux'];
// Built from the code point so this file does not itself contain the character it forbids.
const EM_DASH = String.fromCodePoint(0x2014);

const ALLOWED_HOSTS = new Set([
  'ffmpeg.org',
  'git-scm.com',
  'nodejs.org',
  'cli.github.com',
  'pnpm.io',
  'bun.sh',
  'dotnet.microsoft.com',
  'adoptium.net',
  'docs.flutter.dev',
  'developer.android.com',
  'www.docker.com',
  'docs.docker.com',
  'brew.sh',
  'apps.apple.com',
  'learn.microsoft.com',
  'aka.ms',
  'apps.microsoft.com',
  // Studio's local voices: Piper's home and OmniVoice's model card.
  'github.com',
  'huggingface.co',
]);

function allRecipes(item: DevItem): DevRecipe[] {
  return OSES.flatMap((os) => [...(item.recipes[os] ?? [])]);
}

function allStrings(item: DevItem): string[] {
  const strings = [item.name, item.description, item.consent?.title ?? ''];
  for (const name of Object.values(item.nameByOs ?? {})) strings.push(name);
  for (const recipe of allRecipes(item)) {
    if (recipe.kind === 'terminal-only') strings.push(recipe.command, recipe.note ?? '');
    if (recipe.kind === 'pkg') strings.push(recipe.note ?? '');
  }
  return strings;
}

describe('the catalog data', () => {
  it('gives every item a unique id', () => {
    const ids = DEV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every stack a unique id and puts every item in a known stack', () => {
    const stackIds = DEV_STACKS.map((stack) => stack.id);
    expect(new Set(stackIds).size).toBe(stackIds.length);
    for (const item of DEV_ITEMS) expect(stackIds).toContain(item.stack);
  });

  it('only depends on, and bundles with, items that exist', () => {
    for (const item of DEV_ITEMS) {
      for (const dep of item.dependsOn ?? [])
        expect(isDevItemId(dep), `${item.id} -> ${dep}`).toBe(true);
      for (const recipe of allRecipes(item)) {
        if (recipe.kind === 'bundled') {
          expect(isDevItemId(recipe.with), `${item.id} bundled with ${recipe.with}`).toBe(true);
        }
      }
      if (item.detect.kind === 'command' && item.detect.guard) {
        expect(isDevItemId(item.detect.guard.item)).toBe(true);
      }
    }
  });

  it('has no dependency cycles', () => {
    const edges = (item: DevItem): string[] => [
      ...(item.dependsOn ?? []),
      ...allRecipes(item).flatMap((recipe) => (recipe.kind === 'bundled' ? [recipe.with] : [])),
    ];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string, path: string[]): void => {
      if (state.get(id) === 'done') return;
      expect(state.get(id), `cycle: ${[...path, id].join(' -> ')}`).not.toBe('visiting');
      state.set(id, 'visiting');
      const item = getDevItem(id);
      for (const next of item ? edges(item) : []) visit(next, [...path, id]);
      state.set(id, 'done');
    };
    for (const item of DEV_ITEMS) visit(item.id, []);
  });

  it('keeps dependencies inside the same stack or Essentials, so a stack never needs another stack the user has not picked', () => {
    for (const item of DEV_ITEMS) {
      for (const dep of item.dependsOn ?? []) {
        const target = getDevItem(dep);
        expect(['essentials', item.stack], `${item.id} -> ${dep}`).toContain(target?.stack);
      }
    }
  });

  it('lists a dependency before the item that needs it, so the checklist reads top to bottom', () => {
    const position = new Map(DEV_ITEMS.map((item, index) => [item.id, index]));
    for (const item of DEV_ITEMS) {
      for (const dep of item.dependsOn ?? []) {
        expect(position.get(dep), `${dep} before ${item.id}`).toBeLessThan(
          position.get(item.id) ?? 0,
        );
      }
    }
  });

  it('gives every item an answer on every OS it applies to: a recipe, or a download page', () => {
    for (const item of DEV_ITEMS) {
      for (const os of OSES.filter((candidate) => appliesToOs(item, candidate))) {
        const hasRecipe = (item.recipes[os] ?? []).length > 0;
        expect(hasRecipe || Boolean(item.manualUrl), `${item.id} on ${os}`).toBe(true);
      }
    }
  });

  it('only gives recipes for OSes the item applies to', () => {
    for (const item of DEV_ITEMS) {
      for (const os of OSES) {
        if (!appliesToOs(item, os))
          expect(item.recipes[os] ?? [], `${item.id} on ${os}`).toEqual([]);
      }
    }
  });

  it('uses only well-formed package identifiers, since they end up on a command line', () => {
    const wingetId = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
    const brewName = /^[a-z0-9][a-z0-9@._+-]*$/;
    const npmName = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/;
    const distroName = /^[a-z0-9][a-z0-9+.-]*$/;
    const sdkPackage = /^[a-z0-9][a-z0-9;._{}-]*$/;
    for (const item of DEV_ITEMS) {
      for (const recipe of allRecipes(item)) {
        if (recipe.kind === 'winget') expect(recipe.id).toMatch(wingetId);
        if (recipe.kind === 'brew') expect(recipe.formula).toMatch(brewName);
        if (recipe.kind === 'brew-cask') expect(recipe.cask).toMatch(brewName);
        if (recipe.kind === 'npm-global' || recipe.kind === 'dotnet-tool') {
          expect(recipe.pkg).toMatch(npmName);
        }
        if (recipe.kind === 'pkg') {
          for (const name of [
            ...(recipe.apt ?? []),
            ...(recipe.dnf ?? []),
            ...(recipe.pacman ?? []),
          ]) {
            expect(name).toMatch(distroName);
          }
        }
        if (recipe.kind === 'managed' && recipe.sdkPackage) {
          expect(recipe.sdkPackage).toMatch(sdkPackage);
        }
      }
    }
  });

  it('only links to https pages on known hosts', () => {
    const urls: string[] = [];
    for (const item of DEV_ITEMS) {
      if (item.manualUrl) urls.push(item.manualUrl);
      if (item.consent) urls.push(item.consent.url);
      for (const recipe of allRecipes(item)) if (recipe.kind === 'link') urls.push(recipe.url);
    }
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.protocol, url).toBe('https:');
      expect(ALLOWED_HOSTS.has(parsed.hostname), `${parsed.hostname} is not allowed`).toBe(true);
    }
  });

  it('writes its text the way a person would, with no em dash', () => {
    for (const stack of DEV_STACKS) {
      expect(`${stack.name} ${stack.description}`).not.toContain(EM_DASH);
    }
    for (const item of DEV_ITEMS) {
      for (const text of allStrings(item)) expect(text, item.id).not.toContain(EM_DASH);
    }
  });

  it('requires a description for every item, so the checklist can explain itself', () => {
    for (const item of DEV_ITEMS) {
      expect(item.description.length, item.id).toBeGreaterThan(10);
    }
  });

  it('covers the tools the Essentials stack promises', () => {
    const essentials = DEV_ITEMS.filter((item) => item.stack === 'essentials').map(
      (item) => item.id,
    );
    expect(essentials).toEqual(expect.arrayContaining(['git', 'node', 'npm', 'gh']));
  });

  it('covers the Flutter stack end to end, from the JDK to a system image', () => {
    const flutter = DEV_ITEMS.filter((item) => item.stack === 'flutter').map((item) => item.id);
    expect(flutter).toEqual(
      expect.arrayContaining([
        'jdk17',
        'flutter',
        'dart',
        'android-cmdline-tools',
        'android-licenses',
        'android-platform-tools',
        'android-emulator',
        'android-platform',
        'android-system-image',
      ]),
    );
  });

  it('keeps Android Studio optional, since the headless SDK is what the checklist installs', () => {
    expect(getDevItem('android-studio')?.optional).toBe(true);
  });

  it('asks for consent before the Android licenses and Docker Desktop', () => {
    expect(getDevItem('android-licenses')?.consent).toBeDefined();
    expect(getDevItem('docker-desktop')?.consent).toBeDefined();
  });

  it('pins the minimum versions this repo needs', () => {
    expect(getDevItem('node')?.minVersion).toBe('22.12.0');
    expect(getDevItem('dotnet-sdk')?.minVersion).toBe('10.0.100');
    expect(getDevItem('jdk17')?.minVersion).toBe('17');
  });
});

describe('isDevItemId and getDevItem', () => {
  it('recognises catalog ids only', () => {
    expect(isDevItemId('git')).toBe(true);
    expect(isDevItemId('rm -rf')).toBe(false);
    expect(isDevItemId('')).toBe(false);
    expect(isDevItemId(42)).toBe(false);
    expect(isDevItemId(null)).toBe(false);
  });

  it('does not treat inherited object keys as items', () => {
    expect(isDevItemId('constructor')).toBe(false);
    expect(isDevItemId('__proto__')).toBe(false);
    expect(getDevItem('toString')).toBeUndefined();
  });
});

describe('appliesToOs and applicableDependencies', () => {
  it('applies everywhere unless the item names its OSes', () => {
    expect(appliesToOs(getDevItem('git') as DevItem, 'linux')).toBe(true);
    expect(appliesToOs(getDevItem('wsl2') as DevItem, 'win32')).toBe(true);
    expect(appliesToOs(getDevItem('wsl2') as DevItem, 'darwin')).toBe(false);
    expect(appliesToOs(getDevItem('homebrew') as DevItem, 'linux')).toBe(false);
  });

  it('drops dependencies that do not exist on the current OS', () => {
    const docker = getDevItem('docker-desktop') as DevItem;
    expect(applicableDependencies(docker, 'win32')).toEqual(['wsl2']);
    expect(applicableDependencies(docker, 'darwin')).toEqual([]);
    expect(applicableDependencies(docker, 'linux')).toEqual([]);
  });
});

describe('itemsForStacks', () => {
  it('returns the chosen stacks in catalog order, filtered to the OS', () => {
    const win = itemsForStacks(['essentials', 'docker'], 'win32').map((item) => item.id);
    expect(win).toContain('wsl2');
    expect(win).toContain('docker-desktop');
    expect(win).not.toContain('homebrew');
    expect(win).not.toContain('dotnet-sdk');

    const mac = itemsForStacks(['essentials'], 'darwin').map((item) => item.id);
    expect(mac).toContain('homebrew');
    expect(mac).toContain('xcode-clt');
    expect(mac).not.toContain('wsl2');

    const index = (ids: string[], id: string): number => ids.indexOf(id);
    expect(index(win, 'git')).toBeLessThan(index(win, 'docker-desktop'));
  });

  it('adds Essentials even when it was not asked for', () => {
    const ids = itemsForStacks(['dotnet'], 'linux').map((item) => item.id);
    expect(ids).toContain('git');
    expect(ids).toContain('dotnet-sdk');
  });
});

describe('normalizeDevSetupStacks', () => {
  it('always keeps Essentials first, drops unknown ids and removes repeats', () => {
    expect(normalizeDevSetupStacks(['docker', 'bogus', 'docker'])).toEqual([
      'essentials',
      'docker',
    ]);
    expect(normalizeDevSetupStacks(['flutter', 'essentials', 'dotnet'])).toEqual([
      'essentials',
      'dotnet',
      'flutter',
    ]);
  });

  it('falls back to Essentials alone for anything that is not a list', () => {
    expect(normalizeDevSetupStacks(undefined)).toEqual(['essentials']);
    expect(normalizeDevSetupStacks(null)).toEqual(['essentials']);
    expect(normalizeDevSetupStacks('docker')).toEqual(['essentials']);
    expect(normalizeDevSetupStacks([1, {}, null])).toEqual(['essentials']);
  });
});

describe('expandPathTemplate', () => {
  const win = {
    os: 'win32' as const,
    env: { ProgramFiles: 'C:\\Program Files' },
    home: 'C:\\Users\\me',
  };
  const mac = { os: 'darwin' as const, env: {}, home: '/Users/me' };

  it('fills in environment variables and the home folder', () => {
    expect(expandPathTemplate('%ProgramFiles%\\Git\\cmd\\git{exe}', win)).toBe(
      'C:\\Program Files\\Git\\cmd\\git.exe',
    );
    expect(expandPathTemplate('~/develop/flutter/bin/flutter{exe}', mac)).toBe(
      '/Users/me/develop/flutter/bin/flutter',
    );
  });

  it('gives back null when a variable is not set, so the path is skipped rather than guessed', () => {
    expect(expandPathTemplate('%JAVA_HOME%\\bin\\javac{exe}', win)).toBeNull();
    expect(
      expandPathTemplate('%JAVA_HOME%/bin/javac', { ...mac, env: { JAVA_HOME: '  ' } }),
    ).toBeNull();
  });
});
