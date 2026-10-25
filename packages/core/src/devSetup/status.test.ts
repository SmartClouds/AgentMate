import { describe, expect, it } from 'vitest';
import { getDevItem } from './catalog.js';
import { type RecipeContext, selectRecipe } from './recipes.js';
import { dependencyIds, deriveItemState, isReady } from './status.js';
import type { DevDetection, DevItem, DevItemJob, DevOs } from './types.js';

const item = (id: string): DevItem => {
  const found = getDevItem(id);
  if (!found) throw new Error(`no catalog item ${id}`);
  return found;
};

const ctx = (os: DevOs): RecipeContext => ({
  os,
  arch: 'x64',
  packageManagers: os === 'win32' ? ['winget'] : os === 'darwin' ? ['brew'] : ['apt-get'],
});

const found = (version: string | null, onPath = true): DevDetection => ({
  state: 'found',
  version,
  path: null,
  onPath,
});
const absent: DevDetection = { state: 'absent' };

/** A readiness lookup from a map; an id that is not listed is "not answered yet". */
const readyMap =
  (known: Record<string, boolean>) =>
  (id: string): boolean | undefined =>
    known[id];

function derive(
  id: string,
  os: DevOs,
  detection: DevDetection | undefined,
  options: { job?: DevItemJob; ready?: Record<string, boolean> } = {},
) {
  const target = item(id);
  return deriveItemState({
    item: target,
    os,
    mode: selectRecipe(target, ctx(os)),
    detection,
    job: options.job,
    readiness: readyMap(options.ready ?? {}),
  });
}

describe('deriveItemState from detection', () => {
  it('is checking until the probe has answered', () => {
    expect(derive('node', 'win32', undefined)).toEqual({ kind: 'checking' });
  });

  it('is unknown when the probe itself failed', () => {
    expect(derive('node', 'win32', { state: 'error', message: 'timed out' })).toEqual({
      kind: 'unknown',
      message: 'timed out',
    });
  });

  it('is installed at or above the minimum version', () => {
    expect(derive('node', 'win32', found('22.12.0'))).toEqual({
      kind: 'installed',
      version: '22.12.0',
      onPath: true,
    });
    expect(derive('node', 'win32', found('24.1.0'))).toMatchObject({ kind: 'installed' });
  });

  it('carries along that a tool was found off the PATH', () => {
    expect(derive('flutter', 'win32', found('3.40.0', false), { ready: { git: true } })).toEqual({
      kind: 'installed',
      version: '3.40.0',
      onPath: false,
    });
  });

  it('is outdated below the minimum, and says what the minimum is', () => {
    expect(derive('node', 'win32', found('20.11.0'))).toEqual({
      kind: 'outdated',
      version: '20.11.0',
      minVersion: '22.12.0',
    });
  });

  it('is outdated when the tool exists but its version could not be read', () => {
    expect(derive('node', 'win32', found(null))).toMatchObject({
      kind: 'outdated',
      version: null,
    });
  });

  it('is installed with any version when the item has no minimum', () => {
    expect(
      derive('dotnet-ef', 'win32', found('9.0.0'), { ready: { 'dotnet-sdk': true } }),
    ).toMatchObject({
      kind: 'installed',
    });
    expect(derive('gh-auth', 'win32', found(null), { ready: { gh: true } })).toMatchObject({
      kind: 'installed',
    });
  });

  it('is missing when nothing was found and nothing stands in the way', () => {
    expect(derive('node', 'win32', absent)).toEqual({ kind: 'missing' });
  });

  it('stays installed even when a dependency is not, since it is already there', () => {
    expect(derive('flutter', 'win32', found('3.40.0'), { ready: { git: false } })).toMatchObject({
      kind: 'installed',
    });
  });
});

describe('deriveItemState and dependencies', () => {
  it('is blocked, naming what it waits for, when a dependency is not installed', () => {
    expect(derive('flutter', 'win32', absent, { ready: { git: false } })).toEqual({
      kind: 'blocked',
      waitingFor: ['git'],
      via: 'dependency',
    });
  });

  it('is not blocked once the dependency is installed', () => {
    expect(derive('flutter', 'win32', absent, { ready: { git: true } })).toEqual({
      kind: 'missing',
    });
  });

  it('keeps checking while a dependency has not answered yet, rather than flashing "blocked"', () => {
    expect(derive('flutter', 'win32', absent, {})).toEqual({ kind: 'checking' });
  });

  it('lists every unmet dependency', () => {
    expect(
      derive('android-system-image', 'win32', absent, {
        ready: { 'android-emulator': false, 'android-platform': false },
      }),
    ).toEqual({
      kind: 'blocked',
      waitingFor: ['android-emulator', 'android-platform'],
      via: 'dependency',
    });
  });

  it('waits for Homebrew when the recipe runs through brew', () => {
    expect(derive('node', 'darwin', absent, { ready: { homebrew: false } })).toEqual({
      kind: 'blocked',
      waitingFor: ['homebrew'],
      via: 'dependency',
    });
  });

  it('ignores a dependency that does not exist on this OS', () => {
    expect(derive('docker-desktop', 'darwin', absent, { ready: { homebrew: true } })).toEqual({
      kind: 'missing',
    });
    expect(derive('docker-desktop', 'win32', absent, { ready: { wsl2: false } })).toMatchObject({
      kind: 'blocked',
      waitingFor: ['wsl2'],
    });
  });

  it('reports an item that comes with another as waiting for that one', () => {
    expect(derive('npm', 'win32', absent, { ready: { node: false } })).toEqual({
      kind: 'blocked',
      waitingFor: ['node'],
      via: 'bundled',
    });
  });

  it('is plainly missing when the parent is there but the bundled tool is not', () => {
    expect(derive('npm', 'win32', absent, { ready: { node: true } })).toEqual({ kind: 'missing' });
  });

  it('is unavailable when there is no way to install it from here', () => {
    const bare: DevItem = {
      id: 'bare',
      name: 'Bare',
      description: 'Has no way to be installed.',
      stack: 'essentials',
      detect: { kind: 'command', command: 'bare', args: [] },
      recipes: {},
    };
    expect(
      deriveItemState({
        item: bare,
        os: 'win32',
        mode: selectRecipe(bare, ctx('win32')),
        detection: absent,
        readiness: readyMap({}),
      }),
    ).toEqual({ kind: 'unavailable' });
  });
});

describe('deriveItemState and the install job', () => {
  it('shows an install in progress whatever the last probe said', () => {
    const job: DevItemJob = {
      status: 'installing',
      phase: 'downloading',
      fraction: 0.4,
      detail: '312 of 780 MB',
    };
    expect(derive('node', 'win32', absent, { job })).toEqual({
      kind: 'installing',
      phase: 'downloading',
      fraction: 0.4,
      detail: '312 of 780 MB',
    });
    expect(derive('node', 'win32', undefined, { job })).toMatchObject({ kind: 'installing' });
  });

  it('fills in sensible defaults for a job that has not reported progress', () => {
    expect(derive('node', 'win32', absent, { job: { status: 'installing' } })).toEqual({
      kind: 'installing',
      phase: 'installing',
      fraction: null,
      detail: null,
    });
  });

  it('shows a queued item as queued', () => {
    expect(derive('node', 'win32', absent, { job: { status: 'queued' } })).toEqual({
      kind: 'queued',
    });
  });

  it('shows a failure with its reason while the tool is still missing', () => {
    expect(
      derive('node', 'win32', absent, {
        job: { status: 'failed', message: 'winget could not finish (code 1603)', exitCode: 1603 },
      }),
    ).toEqual({
      kind: 'failed',
      message: 'winget could not finish (code 1603)',
      exitCode: 1603,
    });
  });

  it('forgets a failure once the tool turns out to be installed after all', () => {
    expect(
      derive('node', 'win32', found('22.12.0'), { job: { status: 'failed', message: 'x' } }),
    ).toMatchObject({ kind: 'installed' });
  });

  it('waits for the terminal until the tool shows up', () => {
    expect(derive('gh', 'win32', absent, { job: { status: 'waiting-terminal' } })).toEqual({
      kind: 'waiting-terminal',
    });
    expect(
      derive('gh', 'win32', found('2.62.0'), { job: { status: 'waiting-terminal' } }),
    ).toMatchObject({ kind: 'installed' });
  });
});

describe('dependencyIds', () => {
  it('combines declared dependencies, implied ones and the bundled parent', () => {
    expect(
      dependencyIds(item('flutter'), 'win32', selectRecipe(item('flutter'), ctx('win32'))),
    ).toEqual(['git']);
    expect(
      dependencyIds(item('node'), 'darwin', selectRecipe(item('node'), ctx('darwin'))),
    ).toEqual(['homebrew']);
    expect(dependencyIds(item('npm'), 'win32', selectRecipe(item('npm'), ctx('win32')))).toEqual([
      'node',
    ]);
  });

  it('lists each dependency once', () => {
    const doubled: DevItem = {
      ...item('pnpm'),
      dependsOn: ['npm', 'npm'],
    };
    expect(dependencyIds(doubled, 'win32', selectRecipe(doubled, ctx('win32')))).toEqual(['npm']);
  });
});

describe('isReady', () => {
  it('is true only for an installed item', () => {
    expect(isReady({ kind: 'installed', version: '1.0.0', onPath: true })).toBe(true);
    for (const state of [
      { kind: 'checking' },
      { kind: 'missing' },
      { kind: 'outdated', version: '1.0.0', minVersion: '2.0.0' },
      { kind: 'failed', message: 'x', exitCode: 1 },
    ] as const) {
      expect(isReady(state)).toBe(false);
    }
  });
});

describe('deriveItemState with an update on offer', () => {
  const offer = { state: 'update', latest: '24.22.1', installed: '24.20.0' } as const;

  function deriveWith(
    id: string,
    detection: DevDetection | undefined,
    update: Parameters<typeof deriveItemState>[0]['update'],
    job?: DevItemJob,
  ) {
    const target = item(id);
    return deriveItemState({
      item: target,
      os: 'win32',
      mode: selectRecipe(target, { ...ctx('win32'), intent: 'update' }),
      detection,
      job,
      readiness: readyMap({}),
      update,
    });
  }

  it('stays installed, so the tool is still counted as ready, and carries the newer version', () => {
    const state = deriveWith('node', found('24.20.0'), offer);

    expect(state).toEqual({
      kind: 'installed',
      version: '24.20.0',
      onPath: true,
      update: { latest: '24.22.1' },
    });
    expect(isReady(state)).toBe(true);
  });

  it('adds nothing for a tool that is current, or when the check has not answered or failed', () => {
    for (const update of [{ state: 'current' }, { state: 'unknown' }, undefined] as const) {
      expect(deriveWith('node', found('24.20.0'), update)).toEqual({
        kind: 'installed',
        version: '24.20.0',
        onPath: true,
      });
    }
  });

  it('ignores an update for a tool that is not installed', () => {
    expect(deriveWith('node', absent, offer)).toEqual({ kind: 'missing' });
    expect(deriveWith('node', undefined, offer)).toEqual({ kind: 'checking' });
  });

  it('keeps the older-than-minimum case as outdated, which an update does not change', () => {
    expect(deriveWith('node', found('20.11.0'), offer)).toMatchObject({ kind: 'outdated' });
  });

  it('shows the update that is running, and remembers it is an update', () => {
    const running: DevItemJob = {
      status: 'installing',
      phase: 'downloading',
      fraction: 0.4,
      intent: 'update',
    };
    expect(deriveWith('node', found('24.20.0'), offer, running)).toEqual({
      kind: 'installing',
      phase: 'downloading',
      fraction: 0.4,
      detail: null,
      intent: 'update',
    });
    expect(
      deriveWith('node', found('24.20.0'), offer, { status: 'queued', intent: 'update' }),
    ).toEqual({ kind: 'queued', intent: 'update' });
  });

  it('says an update is waiting on the terminal it was handed to', () => {
    expect(
      deriveWith('node', found('24.20.0'), offer, { status: 'waiting-terminal' }),
    ).toMatchObject({ kind: 'installed', update: { latest: '24.22.1', waiting: true } });
  });

  it('keeps why an update failed on the row that is still installed', () => {
    const failed: DevItemJob = {
      status: 'failed',
      message: 'Close the app that is using it, then try again.',
      intent: 'update',
    };
    expect(deriveWith('node', found('24.20.0'), offer, failed)).toMatchObject({
      kind: 'installed',
      update: { latest: '24.22.1', failure: 'Close the app that is using it, then try again.' },
    });
  });

  it('does not blame an update for an install that failed before the tool turned up', () => {
    const failed: DevItemJob = { status: 'failed', message: 'It broke.' };
    expect(deriveWith('node', found('24.20.0'), offer, failed)).toEqual({
      kind: 'installed',
      version: '24.20.0',
      onPath: true,
      update: { latest: '24.22.1' },
    });
  });
});
