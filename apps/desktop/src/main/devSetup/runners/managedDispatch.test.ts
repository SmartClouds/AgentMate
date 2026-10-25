import type { DevRecipe } from '@agentmat/core';
import { describe, expect, it, vi } from 'vitest';
import { type ManagedRunners, runManagedRecipe } from './managedDispatch';
import type { RunHooks, RunResult } from './packageManagerRunner';

/**
 * A managed recipe names which of the app's own installers to run. This picks it, and for the
 * Android packages takes the package id from the catalog, so what sdkmanager is asked for can
 * never come from anywhere else.
 */

const OK: RunResult = { ok: true, code: 0, cancelled: false };
const hooks = {} as RunHooks;

function runners(): ManagedRunners & { calls: string[] } {
  const calls: string[] = [];
  const done = (name: string) => async () => {
    calls.push(name);
    return OK;
  };
  return {
    calls,
    flutter: {
      run: done('flutter'),
      update: vi.fn(async (_hooks: RunHooks, foundAt: string | null) => {
        calls.push(`flutter-update:${foundAt}`);
        return OK;
      }),
    },
    android: {
      runCmdlineTools: done('cmdline-tools'),
      runLicenses: done('licenses'),
      runPackage: vi.fn(async (pkg: string) => {
        calls.push(`package:${pkg}`);
        return OK;
      }),
    },
    dockerLaunch: { run: done('docker-launch') },
    androidPackages: {
      'android-emulator': 'emulator',
      'android-system-image': 'system-images;android-36;google_apis;x86_64',
    },
  };
}

const managed = (installer: Extract<DevRecipe, { kind: 'managed' }>['installer']) =>
  ({ kind: 'managed', installer }) as Extract<DevRecipe, { kind: 'managed' }>;

describe('runManagedRecipe', () => {
  it('runs the Flutter installer for the Flutter archive', async () => {
    const r = runners();

    expect(await runManagedRecipe('flutter', managed('flutter-archive'), hooks, r)).toBe(OK);
    expect(r.calls).toEqual(['flutter']);
  });

  it('runs the command-line tools installer', async () => {
    const r = runners();

    await runManagedRecipe('android-cmdline-tools', managed('android-cmdline-tools'), hooks, r);

    expect(r.calls).toEqual(['cmdline-tools']);
  });

  it('runs the licenses step', async () => {
    const r = runners();

    await runManagedRecipe('android-licenses', managed('android-licenses'), hooks, r);

    expect(r.calls).toEqual(['licenses']);
  });

  it('installs the package the catalog names for that item', async () => {
    const r = runners();

    await runManagedRecipe('android-emulator', managed('android-package'), hooks, r);
    await runManagedRecipe('android-system-image', managed('android-package'), hooks, r);

    expect(r.calls).toEqual([
      'package:emulator',
      'package:system-images;android-36;google_apis;x86_64',
    ]);
  });

  it('refuses a package step for an item that has no package', async () => {
    const r = runners();

    expect(await runManagedRecipe('git', managed('android-package'), hooks, r)).toMatchObject({
      ok: false,
      message: 'There is no Android package set for that item.',
    });
    expect(r.calls).toEqual([]);
  });

  it('launches Docker for the Docker step', async () => {
    const r = runners();

    await runManagedRecipe('docker-running', managed('docker-launch'), hooks, r);

    expect(r.calls).toEqual(['docker-launch']);
  });
});

describe('runManagedRecipe for an update', () => {
  const update = (path: string | null = null) => ({ intent: 'update' as const, path });

  it('updates Flutter where it was found, rather than installing it again', async () => {
    const r = runners();

    await runManagedRecipe(
      'flutter',
      managed('flutter-archive'),
      hooks,
      r,
      update('D:\\f\\flutter.bat'),
    );

    expect(r.calls).toEqual(['flutter-update:D:\\f\\flutter.bat']);
  });

  it('updates an Android package by asking sdkmanager for it again', async () => {
    const r = runners();

    await runManagedRecipe('android-emulator', managed('android-package'), hooks, r, update());

    expect(r.calls).toEqual(['package:emulator']);
  });

  it('has no update for the steps that are not a version', async () => {
    const r = runners();

    for (const [id, installer] of [
      ['android-cmdline-tools', 'android-cmdline-tools'],
      ['android-licenses', 'android-licenses'],
      ['docker-running', 'docker-launch'],
    ] as const) {
      expect(await runManagedRecipe(id, managed(installer), hooks, r, update())).toMatchObject({
        ok: false,
        message: 'This step cannot be updated.',
      });
    }
    expect(r.calls).toEqual([]);
  });

  it('still installs when no intent is given', async () => {
    const r = runners();

    await runManagedRecipe('flutter', managed('flutter-archive'), hooks, r);

    expect(r.calls).toEqual(['flutter']);
  });
});
