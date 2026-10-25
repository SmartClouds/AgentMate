import { readFileSync } from 'node:fs';
import type { DevDetection, DevSetupEnvironment } from '@agentmat/core';
import { describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from './probe';
import { createUpdateChecker, type UpdateCheckerDeps } from './updates';

/**
 * The checker asks each source one question for everything that source covers, remembers the
 * answer for a while, and lets one source fail without taking the others with it. The machine is
 * faked: the commands print what the real ones printed (the fixtures are trimmed real copies), and
 * the clock is moved by hand.
 */

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../../../../packages/core/src/devSetup/__fixtures__/${name}`, import.meta.url),
    'utf-8',
  );

const WIN: DevSetupEnvironment = { os: 'win32', arch: 'x64', packageManagers: ['winget'] };
const MAC: DevSetupEnvironment = { os: 'darwin', arch: 'arm64', packageManagers: ['brew'] };
const UBUNTU: DevSetupEnvironment = { os: 'linux', arch: 'x64', packageManagers: ['apt-get'] };
const FEDORA: DevSetupEnvironment = { os: 'linux', arch: 'x64', packageManagers: ['dnf'] };
const ARCH: DevSetupEnvironment = { os: 'linux', arch: 'x64', packageManagers: ['pacman'] };

const ran = (output: string, extra: Partial<ProbeResult> = {}): ProbeResult => ({
  ok: true,
  code: 0,
  stdout: output,
  stderr: '',
  output,
  notFound: false,
  timedOut: false,
  error: null,
  ...extra,
});

const found = (version: string | null): DevDetection => ({
  state: 'found',
  version,
  path: null,
  onPath: true,
});

function world(
  options: {
    environment?: DevSetupEnvironment;
    detections?: Record<string, DevDetection>;
    probe?: (command: string, args: readonly string[]) => ProbeResult | Promise<ProbeResult>;
    latestNpm?: (pkg: string) => Promise<string | null>;
    fetchJson?: (url: string) => Promise<unknown>;
    sdkmanagerList?: () => Promise<string | null>;
  } = {},
) {
  let time = 1_000_000;
  const probes: string[] = [];
  const deps: UpdateCheckerDeps = {
    environment: async () => options.environment ?? WIN,
    detect: async (id) => options.detections?.[id] ?? { state: 'absent' },
    probe: vi.fn(async (command: string, args: readonly string[]) => {
      probes.push([command, ...args].join(' '));
      return (await options.probe?.(command, args)) ?? ran('');
    }),
    latestNpm: options.latestNpm ?? (async () => null),
    fetchJson: options.fetchJson ?? (async () => ({})),
    sdkmanagerList: options.sdkmanagerList ?? (async () => null),
    now: () => time,
  };
  return {
    checker: createUpdateChecker(deps),
    probes,
    deps,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const wingetList = () => ran(fixture('winget-upgrade.txt'));

describe('winget', () => {
  it('asks once for everything and reads each row from the one answer', async () => {
    const w = world({ probe: wingetList });

    const result = await w.checker.check(['node', 'docker-desktop', 'gh']);

    expect(w.probes).toEqual([
      'winget upgrade --source winget --accept-source-agreements --disable-interactivity',
    ]);
    expect(result.node).toEqual({ state: 'update', latest: '24.22.1', installed: '24.20.0' });
    expect(result['docker-desktop']).toEqual({
      state: 'update',
      latest: '4.96.2',
      installed: '4.96.0',
    });
    expect(result.gh).toEqual({ state: 'current' });
  });

  it('remembers the answer, so opening the page again does not ask winget again', async () => {
    const w = world({ probe: wingetList });

    await w.checker.check(['node', 'gh']);
    const again = await w.checker.check(['node', 'gh']);
    w.advance(10 * 60_000);
    await w.checker.check(['node']);

    expect(w.probes).toHaveLength(1);
    expect(again.node).toMatchObject({ state: 'update' });
  });

  it('asks again after the answer has gone stale', async () => {
    const w = world({ probe: wingetList });

    await w.checker.check(['node']);
    w.advance(31 * 60_000);
    await w.checker.check(['node']);

    expect(w.probes).toHaveLength(2);
  });

  it('asks again when told to, and asks only about the one tool when it is one', async () => {
    const w = world({ probe: wingetList });

    await w.checker.check(['node', 'gh', 'git']);
    await w.checker.check(['node'], { force: true });

    expect(w.probes[1]).toBe(
      'winget upgrade --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --disable-interactivity',
    );
  });

  it('lets a forced check of many tools ask for the whole list again', async () => {
    const w = world({ probe: wingetList });

    await w.checker.check(['node', 'gh']);
    await w.checker.check(['node', 'gh'], { force: true });

    expect(w.probes[1]).toBe(
      'winget upgrade --source winget --accept-source-agreements --disable-interactivity',
    );
  });

  it('shares one question between two checks that arrive together', async () => {
    const w = world({ probe: wingetList });

    await Promise.all([w.checker.check(['node', 'gh']), w.checker.check(['node', 'gh'])]);

    expect(w.probes).toHaveLength(1);
  });

  it('cannot say when winget is missing, did not answer in time, or said nothing', async () => {
    for (const reply of [
      ran('', { ok: false, notFound: true }),
      ran('', { ok: false, timedOut: true }),
      ran('', { ok: false, error: 'spawn failed' }),
      ran('   \n'),
    ]) {
      const w = world({ probe: () => reply });
      expect(await w.checker.check(['node', 'gh'])).toEqual({
        node: { state: 'unknown' },
        gh: { state: 'unknown' },
      });
    }
  });

  it('asks again soon after a failure instead of holding on to it for half an hour', async () => {
    let answer = ran('', { ok: false, timedOut: true });
    const w = world({ probe: () => answer });

    await w.checker.check(['node']);
    answer = wingetList();
    w.advance(2 * 60_000);
    const later = await w.checker.check(['node']);

    expect(later.node).toMatchObject({ state: 'update' });
  });

  it('says current for a tool winget does not list, which is what no row means', async () => {
    const w = world({ probe: () => ran('No installed package found matching input criteria.') });

    expect(await w.checker.check(['gh'])).toEqual({ gh: { state: 'current' } });
  });
});

describe('Homebrew', () => {
  const outdated = JSON.stringify({
    formulae: [{ name: 'gh', installed_versions: ['2.62.0'], current_version: '2.70.0' }],
    casks: [{ name: 'docker-desktop', installed_versions: ['4.40.0'], current_version: '4.41.1' }],
  });

  it('asks brew once, for formulae and casks, by their names', async () => {
    const w = world({ environment: MAC, probe: () => ran(outdated) });

    const result = await w.checker.check(['gh', 'docker-desktop', 'node']);

    expect(w.probes).toEqual(['brew outdated --json=v2 --greedy']);
    expect(result.gh).toEqual({ state: 'update', latest: '2.70.0', installed: '2.62.0' });
    expect(result['docker-desktop']).toMatchObject({ state: 'update', latest: '4.41.1' });
    expect(result.node).toEqual({ state: 'current' });
  });

  it('cannot say when brew printed something that is not JSON', async () => {
    const w = world({ environment: MAC, probe: () => ran('Error: no') });

    expect(await w.checker.check(['gh'])).toEqual({ gh: { state: 'unknown' } });
  });
});

describe('Linux package managers', () => {
  it('reads apt, taking the first of a recipe packages that has an update', async () => {
    const w = world({
      environment: UBUNTU,
      probe: () =>
        ran(
          'Listing...\nnpm/jammy 10.9.2-1 all [upgradable from: 10.9.0-1]\ngit/jammy 1:2.43.0-1 amd64 [upgradable from: 1:2.34.1-1]',
        ),
    });

    const result = await w.checker.check(['git', 'node', 'gh']);

    expect(w.probes).toEqual(['apt list --upgradable']);
    expect(result.git).toMatchObject({ state: 'update', latest: '1:2.43.0-1' });
    expect(result.node).toMatchObject({ state: 'update', latest: '10.9.2-1' });
    expect(result.gh).toEqual({ state: 'current' });
  });

  it('reads dnf, where exit code 100 means there are updates', async () => {
    const w = world({
      environment: FEDORA,
      probe: () => ran('git.x86_64   2.43.5-1.fc40   updates', { ok: false, code: 100 }),
    });

    const result = await w.checker.check(['git', 'gh']);

    expect(w.probes).toEqual(['dnf check-update -q']);
    expect(result.git).toMatchObject({ state: 'update', latest: '2.43.5-1.fc40' });
    expect(result.gh).toEqual({ state: 'current' });
  });

  it('does not take a dnf error for "nothing to update"', async () => {
    const w = world({
      environment: FEDORA,
      probe: () => ran('Error: failed to download metadata', { ok: false, code: 1 }),
    });

    expect(await w.checker.check(['git'])).toEqual({ git: { state: 'unknown' } });
  });

  it('reads pacman, where exit code 1 means nothing is out of date', async () => {
    const w = world({
      environment: ARCH,
      probe: () => ran('github-cli 2.62.0-1 -> 2.70.0-1', { ok: false, code: 0 }),
    });
    expect((await w.checker.check(['gh'])).gh).toMatchObject({ state: 'update' });
    expect(w.probes).toEqual(['pacman -Qu']);

    const none = world({ environment: ARCH, probe: () => ran('', { ok: false, code: 1 }) });
    expect(await none.checker.check(['gh'])).toEqual({ gh: { state: 'current' } });
  });
});

describe('registries and feeds', () => {
  it('compares the registry newest with what pnpm reports', async () => {
    const w = world({
      detections: { pnpm: found('12.14.0') },
      latestNpm: async (pkg) => (pkg === 'pnpm' ? '12.15.1' : null),
    });

    expect((await w.checker.check(['pnpm'])).pnpm).toEqual({
      state: 'update',
      latest: '12.15.1',
      installed: null,
    });
  });

  it('is current when the registry has nothing newer, and cannot say when it did not answer', async () => {
    const current = world({
      detections: { pnpm: found('12.15.1') },
      latestNpm: async () => '12.15.1',
    });
    expect(await current.checker.check(['pnpm'])).toEqual({ pnpm: { state: 'current' } });

    const offline = world({ detections: { pnpm: found('12.14.0') }, latestNpm: async () => null });
    expect(await offline.checker.check(['pnpm'])).toEqual({ pnpm: { state: 'unknown' } });
  });

  it('does not ask a registry about a tool that is not installed', async () => {
    const latestNpm = vi.fn(async () => '12.15.1');
    const w = world({ latestNpm });

    expect(await w.checker.check(['pnpm'])).toEqual({ pnpm: { state: 'unknown' } });
    expect(latestNpm).not.toHaveBeenCalled();
  });

  it('reads the newest stable version from the NuGet index for the Entity Framework tool', async () => {
    const fetchJson = vi.fn(async () => ({ versions: ['10.0.2', '10.0.13', '11.0.0-preview.1'] }));
    const w = world({ detections: { 'dotnet-ef': found('10.0.2') }, fetchJson });

    const result = await w.checker.check(['dotnet-ef']);

    expect(fetchJson).toHaveBeenCalledWith(
      'https://api.nuget.org/v3-flatcontainer/dotnet-ef/index.json',
    );
    expect(result['dotnet-ef']).toMatchObject({ state: 'update', latest: '10.0.13' });
  });

  it('reads the current stable Flutter from the official list', async () => {
    const manifest = JSON.parse(fixture('flutter-releases-windows.json')) as unknown;
    const fetchJson = vi.fn(async () => manifest);
    const w = world({ detections: { flutter: found('3.47.2') }, fetchJson });

    const result = await w.checker.check(['flutter']);

    expect(fetchJson).toHaveBeenCalledWith(
      'https://storage.googleapis.com/flutter_infra_release/releases/releases_windows.json',
    );
    expect(result.flutter).toMatchObject({ state: 'update' });
  });

  it('keeps a feed that fails from spoiling the other answers', async () => {
    const w = world({
      probe: wingetList,
      detections: { 'dotnet-ef': found('10.0.2') },
      fetchJson: async () => {
        throw new Error('offline');
      },
    });

    const result = await w.checker.check(['node', 'dotnet-ef']);

    expect(result.node).toMatchObject({ state: 'update' });
    expect(result['dotnet-ef']).toEqual({ state: 'unknown' });
  });
});

describe('the Android SDK', () => {
  it('reads sdkmanager once for every package it covers', async () => {
    const sdkmanagerList = vi.fn(async () => fixture('sdkmanager-list.txt'));
    const w = world({ sdkmanagerList });

    const result = await w.checker.check([
      'android-emulator',
      'android-platform-tools',
      'android-platform',
    ]);

    expect(sdkmanagerList).toHaveBeenCalledTimes(1);
    expect(result['android-emulator']).toEqual({
      state: 'update',
      latest: '37.2.12',
      installed: '36.5.11',
    });
    expect(result['android-platform-tools']).toMatchObject({ state: 'update', latest: '37.0.1' });
    expect(result['android-platform']).toEqual({ state: 'current' });
  });

  it('cannot say when sdkmanager is missing or printed no list', async () => {
    for (const list of [async () => null, async () => 'Error: JAVA_HOME is not set']) {
      const w = world({ sdkmanagerList: list });
      expect(await w.checker.check(['android-emulator'])).toEqual({
        'android-emulator': { state: 'unknown' },
      });
    }
  });
});

describe('what is not asked', () => {
  it('has nothing to say about a row that comes with another tool or is only a step', async () => {
    const w = world({ probe: wingetList });

    expect(await w.checker.check(['npm', 'gh-auth', 'docker-running'])).toEqual({
      npm: { state: 'unknown' },
      'gh-auth': { state: 'unknown' },
      'docker-running': { state: 'unknown' },
    });
    expect(w.probes).toEqual([]);
  });

  it('has nothing to ask when winget is not on the machine', async () => {
    const w = world({ environment: { ...WIN, packageManagers: [] } });

    expect(await w.checker.check(['node'])).toEqual({ node: { state: 'unknown' } });
    expect(w.probes).toEqual([]);
  });
});

describe('forget', () => {
  it('makes the next check ask again for that tool', async () => {
    const w = world({ probe: wingetList });

    await w.checker.check(['node', 'gh']);
    w.checker.forget(['node']);
    await w.checker.check(['node', 'gh']);

    expect(w.probes).toHaveLength(2);
  });
});
