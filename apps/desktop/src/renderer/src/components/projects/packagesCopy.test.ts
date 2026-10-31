import type { PackageInfo, PackageManagerSection, RuntimeTarget } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import { buildPackageUpdatePrompt, outdatedRuntimes, runtimeLabel } from './packagesCopy';

function pkg(overrides: Partial<PackageInfo> = {}): PackageInfo {
  return {
    name: 'http',
    currentVersion: '1.2.0',
    latestVersion: '1.3.0',
    isOutdated: true,
    isDev: false,
    isInstalled: true,
    manifestPath: 'C:\\work\\app\\pubspec.yaml',
    projectLabel: 'app',
    ...overrides,
  };
}

function runtime(overrides: Partial<RuntimeTarget> = {}): RuntimeTarget {
  return {
    kind: 'dart',
    source: 'pubspec-sdk',
    declared: '^3.11.5',
    currentVersion: '3.11.5',
    latestVersion: '3.13.5',
    isOutdated: true,
    nextDeclared: '^3.13.5',
    requires: { toolchain: 'flutter', minVersion: '3.47.7' },
    manifestPath: 'C:\\work\\app\\pubspec.yaml',
    projectLabel: 'app',
    ...overrides,
  };
}

function section(overrides: Partial<PackageManagerSection> = {}): PackageManagerSection {
  return {
    ecosystem: 'dart',
    manager: 'pub',
    status: 'ok',
    message: null,
    packages: [pkg()],
    runtimes: [runtime()],
    toolchain: 'flutter',
    ...overrides,
  };
}

describe('runtimeLabel', () => {
  it('names each kind of runtime setting', () => {
    expect(runtimeLabel(runtime())).toBe('Dart SDK');
    expect(runtimeLabel(runtime({ kind: 'flutter', source: 'pubspec-flutter' }))).toBe(
      'Flutter SDK',
    );
    expect(runtimeLabel(runtime({ kind: 'dotnet', source: 'target-framework' }))).toBe(
      '.NET target framework',
    );
    expect(runtimeLabel(runtime({ kind: 'dotnet', source: 'global-json' }))).toBe(
      '.NET SDK (global.json)',
    );
    expect(runtimeLabel(runtime({ kind: 'bun', source: 'packageManager' }))).toBe(
      'Bun (packageManager)',
    );
    expect(runtimeLabel(runtime({ kind: 'node', source: 'engines' }))).toBe('Node.js (engines)');
  });
});

describe('outdatedRuntimes', () => {
  it('keeps only the settings that have a known newer version', () => {
    const current = runtime({ isOutdated: false, nextDeclared: null });
    const unknown = runtime({ latestVersion: null, isOutdated: false });
    const readOnly = runtime({ source: 'pubspec-flutter', kind: 'flutter', nextDeclared: null });
    expect(
      outdatedRuntimes(section({ runtimes: [runtime(), current, unknown, readOnly] })),
    ).toEqual([runtime(), readOnly]);
  });
});

describe('buildPackageUpdatePrompt with runtimes', () => {
  it('puts the runtime first and asks for it to move before any package', () => {
    const prompt = buildPackageUpdatePrompt(section(), [pkg()]);

    expect(prompt).toMatch(
      /^Move this project to the latest Dart SDK, then update 1 outdated pub package to their latest versions\./,
    );
    expect(prompt).toContain(
      'Runtime (current -> target):\n\n- Dart SDK in app (C:\\work\\app\\pubspec.yaml): ^3.11.5 -> ^3.13.5',
    );
    expect(prompt.indexOf('Runtime (current -> target)')).toBeLessThan(
      prompt.indexOf('Packages (current -> latest)'),
    );
    expect(prompt).toContain('1. Start with the runtime, before any package.');
    expect(prompt).toContain('run pub get and dart analyze');
  });

  it('asks for the same style when Runova would not rewrite the value itself', () => {
    const prompt = buildPackageUpdatePrompt(
      section({
        ecosystem: 'node',
        manager: 'npm',
        runtimes: [
          runtime({
            kind: 'node',
            source: 'engines',
            declared: '>=18 <22',
            latestVersion: '24.11.1',
            nextDeclared: null,
          }),
        ],
      }),
      [],
    );

    expect(prompt).toContain(
      '>=18 <22 -> 24.11.1 (write it in the same style as the current value)',
    );
    expect(prompt).toContain('reinstall so the lockfile is written by the new version');
  });

  it('works for a runtime move with no outdated package', () => {
    const prompt = buildPackageUpdatePrompt(
      section({
        ecosystem: 'dotnet',
        manager: 'nuget',
        packages: [],
        runtimes: [
          runtime({
            kind: 'dotnet',
            source: 'target-framework',
            declared: 'net8.0',
            nextDeclared: 'net10.0',
            projectLabel: 'Api',
          }),
        ],
      }),
      [],
    );

    expect(prompt).toMatch(/^Move this project to the latest \.NET target framework\./);
    expect(prompt).not.toContain('Packages (current -> latest)');
    expect(prompt).not.toContain('Update each package with');
    expect(prompt).toContain('move the Microsoft.* and System.* packages');
  });

  it('leaves the runtime out when asked to, and reads as before', () => {
    const prompt = buildPackageUpdatePrompt(section(), [pkg()], { includeRuntimes: false });

    expect(prompt).toMatch(/^Update 1 outdated pub package in this project/);
    expect(prompt).not.toContain('Runtime');
    expect(prompt).toContain('Only touch the packages listed here.');
  });
});
