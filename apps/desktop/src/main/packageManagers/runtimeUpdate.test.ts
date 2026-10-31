import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeUpdateRequest } from '../../shared/apiTypes';
import { tempDir, writeTree } from '../../test/main/fixtures';
import { rewritePubspecEnvironment } from './runtimeTargets';
import {
  applyRuntimeUpdate,
  type RuntimeUpdateDeps,
  runtimeCandidate,
  toolchainProblem,
} from './runtimeUpdate';

let root = '';
let pubspecPath = '';

beforeEach(() => {
  root = tempDir('runova-runtime-update-');
  writeTree(root, { 'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ^3.11.5\n' });
  pubspecPath = join(root, 'pubspec.yaml');
});

function installed(versions: Record<string, string | null>): RuntimeUpdateDeps {
  return { installedVersion: async (id) => versions[id] ?? null };
}

function sdkCandidate(latestVersion: string | null, next = true) {
  return runtimeCandidate({
    kind: 'dart',
    source: 'pubspec-sdk',
    declared: '^3.11.5',
    currentVersion: '3.11.5',
    latestVersion,
    next: next ? (latest) => `^${latest}` : null,
    requires: (latest) => ({ toolchain: 'dart', minVersion: latest }),
    manifestPath: pubspecPath,
    projectLabel: 'app',
    rewrite: (text, value) => rewritePubspecEnvironment(text, 'sdk', value),
  });
}

function request(overrides: Partial<RuntimeUpdateRequest> = {}): RuntimeUpdateRequest {
  return {
    ecosystem: 'dart',
    source: 'pubspec-sdk',
    kind: 'dart',
    manifestPath: pubspecPath,
    targetVersion: '3.13.5',
    ...overrides,
  };
}

describe('runtimeCandidate', () => {
  it('works out the next value and what it needs when there is a newer version', () => {
    expect(sdkCandidate('3.13.5').target).toMatchObject({
      isOutdated: true,
      nextDeclared: '^3.13.5',
      requires: { toolchain: 'dart', minVersion: '3.13.5' },
    });
  });

  it('has no next value or requirement when the value is current', () => {
    expect(sdkCandidate('3.11.5').target).toMatchObject({
      isOutdated: false,
      nextDeclared: null,
      requires: null,
    });
  });

  it('keeps an unknown latest version apart from up to date', () => {
    expect(sdkCandidate(null).target).toMatchObject({
      latestVersion: null,
      isOutdated: false,
    });
  });

  it('reports a newer version it will not rewrite itself', () => {
    expect(sdkCandidate('3.13.5', false).target).toMatchObject({
      isOutdated: true,
      nextDeclared: null,
    });
  });
});

describe('toolchainProblem', () => {
  const requires = { toolchain: 'flutter', minVersion: '3.47.7' };

  it('passes when nothing is required or the installed tool is new enough', async () => {
    expect(await toolchainProblem(null, installed({}))).toBeNull();
    expect(await toolchainProblem(requires, installed({ flutter: '3.47.7' }))).toBeNull();
    expect(await toolchainProblem(requires, installed({ flutter: '3.50.0' }))).toBeNull();
  });

  it('names the installed version when it is too old', async () => {
    expect(await toolchainProblem(requires, installed({ flutter: '3.38.1' }))).toBe(
      'This needs Flutter 3.47.7 or newer, and 3.38.1 is installed. Upgrade Flutter first.',
    );
  });

  it('says so when the tool is missing, or the lookup fails', async () => {
    expect(await toolchainProblem(requires, installed({}))).toMatch(
      /was not found on this machine/,
    );
    const failing: RuntimeUpdateDeps = {
      installedVersion: async () => {
        throw new Error('probe failed');
      },
    };
    expect(await toolchainProblem(requires, failing)).toMatch(/was not found/);
  });
});

describe('applyRuntimeUpdate', () => {
  const read = () => readFileSync(pubspecPath, 'utf-8');

  it('writes the new value when the toolchain can take it', async () => {
    const result = await applyRuntimeUpdate(
      request(),
      [sdkCandidate('3.13.5')],
      installed({ dart: '3.13.5' }),
    );

    expect(result).toEqual({ ok: true, message: 'Updated ^3.11.5 to ^3.13.5.' });
    expect(read()).toBe('name: app\nenvironment:\n  sdk: ^3.13.5\n');
  });

  it('refuses, and leaves the file alone, when the toolchain is too old', async () => {
    const result = await applyRuntimeUpdate(
      request(),
      [sdkCandidate('3.13.5')],
      installed({ dart: '3.11.5' }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Upgrade Dart first/);
    expect(read()).toContain('^3.11.5');
  });

  it('refuses a request for a version the list no longer shows', async () => {
    const result = await applyRuntimeUpdate(
      request({ targetVersion: '3.12.0' }),
      [sdkCandidate('3.13.5')],
      installed({ dart: '9.0.0' }),
    );
    expect(result).toEqual({
      ok: false,
      message: 'The newest version is now 3.13.5. Refresh and try again.',
    });
  });

  it('refuses a setting that is not in the file', async () => {
    const result = await applyRuntimeUpdate(
      request({ source: 'pubspec-flutter', kind: 'flutter' }),
      [sdkCandidate('3.13.5')],
      installed({}),
    );
    expect(result.message).toBe('That setting is no longer in the file. Refresh the list.');
  });

  it('refuses a value that is already current, or one it does not rewrite', async () => {
    expect(
      (await applyRuntimeUpdate(request(), [sdkCandidate('3.11.5')], installed({}))).message,
    ).toBe('^3.11.5 is already current.');
    expect(
      (await applyRuntimeUpdate(request(), [sdkCandidate('3.13.5', false)], installed({}))).message,
    ).toMatch(/Use Update with AI/);
  });

  it('refuses when the value moved out of place since it was listed', async () => {
    const candidate = sdkCandidate('3.13.5');
    writeTree(root, { 'pubspec.yaml': 'name: app\n' });

    const result = await applyRuntimeUpdate(request(), [candidate], installed({ dart: '3.13.5' }));

    expect(result).toEqual({
      ok: false,
      message: 'The file changed since it was read. Refresh the list.',
    });
    expect(read()).toBe('name: app\n');
  });
});
