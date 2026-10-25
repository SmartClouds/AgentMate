import { describe, expect, it } from 'vitest';
import { getDevItem, itemsForStacks } from './catalog.js';
import {
  buildInstallPlan,
  buildUpdatePlan,
  collectConsents,
  missingItemIds,
  type PlanEntry,
  summarizeSetup,
  updatableItemIds,
} from './plan.js';
import { type RecipeContext, selectRecipe } from './recipes.js';
import type { DevItem, DevItemState, DevOs } from './types.js';

const INSTALLED: DevItemState = { kind: 'installed', version: '1.0.0', onPath: true };
const MISSING: DevItemState = { kind: 'missing' };

const contexts: Record<DevOs, RecipeContext> = {
  win32: { os: 'win32', arch: 'x64', packageManagers: ['winget'] },
  darwin: { os: 'darwin', arch: 'arm64', packageManagers: ['brew'] },
  linux: { os: 'linux', arch: 'x64', packageManagers: ['apt-get'] },
};

/** Entries for the chosen stacks, every item missing unless the map says otherwise. */
function entriesFor(
  stacks: string[],
  os: DevOs,
  states: Record<string, DevItemState> = {},
  context: RecipeContext = contexts[os],
): Map<string, PlanEntry> {
  const entries = new Map<string, PlanEntry>();
  for (const item of itemsForStacks(stacks, os)) {
    entries.set(item.id, {
      item,
      mode: selectRecipe(item, context),
      state: states[item.id] ?? MISSING,
    });
  }
  return entries;
}

const installed = (...ids: string[]): Record<string, DevItemState> =>
  Object.fromEntries(ids.map((id) => [id, INSTALLED]));

describe('missingItemIds', () => {
  it('lists the required items that still need work, in checklist order', () => {
    const entries = entriesFor(['essentials'], 'win32', installed('git'));
    expect(missingItemIds(entries)).toEqual(['node', 'npm', 'gh']);
  });

  it('leaves out optional items', () => {
    const ids = missingItemIds(entriesFor(['essentials'], 'win32'));
    expect(ids).not.toContain('pnpm');
    expect(ids).not.toContain('gh-auth');
  });

  it('leaves out items that are already being worked on or not yet checked', () => {
    const entries = entriesFor(['essentials'], 'win32', {
      git: { kind: 'checking' },
      node: { kind: 'installing', phase: 'installing', fraction: null, detail: null },
      npm: { kind: 'queued' },
      gh: { kind: 'unknown', message: 'timed out' },
    });
    expect(missingItemIds(entries)).toEqual([]);
  });

  it('counts outdated, failed, blocked and waiting items as work to do', () => {
    const entries = entriesFor(['essentials'], 'win32', {
      git: { kind: 'outdated', version: '2.1.0', minVersion: '2.30.0' },
      node: { kind: 'failed', message: 'x', exitCode: 1 },
      npm: { kind: 'blocked', waitingFor: ['node'], via: 'bundled' },
      gh: { kind: 'waiting-terminal' },
    });
    expect(missingItemIds(entries)).toEqual(['git', 'node', 'npm', 'gh']);
  });
});

describe('buildInstallPlan', () => {
  it('orders everything in the Flutter stack so each tool comes after what it needs', () => {
    const entries = entriesFor(['essentials', 'flutter'], 'win32');
    const plan = buildInstallPlan(missingItemIds(entries), entries, 'win32');
    expect(plan.steps).toEqual([
      'git',
      'node',
      'gh',
      'jdk17',
      'flutter',
      'android-cmdline-tools',
      'android-licenses',
      'android-platform-tools',
      'android-emulator',
      'android-platform',
      'android-system-image',
    ]);
    expect(plan.manual).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it('skips what is already installed', () => {
    const entries = entriesFor(['essentials', 'flutter'], 'win32', installed('git', 'jdk17'));
    const plan = buildInstallPlan(missingItemIds(entries), entries, 'win32');
    expect(plan.steps).not.toContain('git');
    expect(plan.steps).not.toContain('jdk17');
    expect(plan.steps).toContain('flutter');
  });

  it('pulls in the dependencies of a single requested item, ahead of it', () => {
    const entries = entriesFor(['essentials', 'flutter'], 'win32');
    const plan = buildInstallPlan(['android-system-image'], entries, 'win32');
    expect(plan.steps).toEqual([
      'jdk17',
      'android-cmdline-tools',
      'android-licenses',
      'android-emulator',
      'android-platform',
      'android-system-image',
    ]);
  });

  it('installs an optional item when it is asked for by name', () => {
    const entries = entriesFor(['essentials'], 'win32', installed('npm'));
    expect(buildInstallPlan(['pnpm'], entries, 'win32').steps).toEqual(['pnpm']);
  });

  it('installs the parent for an item that comes bundled, and does not list the item itself', () => {
    const entries = entriesFor(['essentials'], 'win32', installed('git', 'gh'));
    const plan = buildInstallPlan(['npm'], entries, 'win32');
    expect(plan.steps).toEqual(['node']);
    expect(plan.manual).toEqual([]);
  });

  it('hands steps that need a terminal to the user, and defers what depends on them', () => {
    const entries = entriesFor(
      ['essentials', 'docker'],
      'win32',
      installed('git', 'node', 'npm', 'gh'),
    );
    const plan = buildInstallPlan(missingItemIds(entries), entries, 'win32');
    expect(plan.steps).toEqual([]);
    expect(plan.manual).toEqual(['wsl2']);
    expect(plan.deferred).toEqual(['docker-desktop', 'docker-running']);
  });

  it('runs the Docker steps once WSL is in place', () => {
    const entries = entriesFor(
      ['essentials', 'docker'],
      'win32',
      installed('git', 'node', 'npm', 'gh', 'wsl2'),
    );
    const plan = buildInstallPlan(missingItemIds(entries), entries, 'win32');
    expect(plan.steps).toEqual(['docker-desktop', 'docker-running']);
    expect(plan.manual).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it('sends every distribution package on Linux to the terminal and defers Flutter behind Git', () => {
    const entries = entriesFor(['essentials', 'flutter'], 'linux');
    const plan = buildInstallPlan(['flutter'], entries, 'linux');
    expect(plan.manual).toEqual(['git']);
    expect(plan.deferred).toEqual(['flutter']);
    expect(plan.steps).toEqual([]);
  });

  it('treats a download-page-only install as something the user does by hand', () => {
    const noWinget: RecipeContext = { ...contexts.win32, packageManagers: [] };
    const entries = entriesFor(['essentials'], 'win32', {}, noWinget);
    const plan = buildInstallPlan(['git'], entries, 'win32');
    expect(plan.manual).toEqual(['git']);
  });

  it('asks the user to install Homebrew first on a Mac, then runs the brew steps', () => {
    const entries = entriesFor(['essentials'], 'darwin', installed('xcode-clt', 'git'));
    const plan = buildInstallPlan(['node'], entries, 'darwin');
    expect(plan.manual).toEqual(['homebrew']);
    expect(plan.deferred).toEqual(['node']);
  });

  it('ignores items that are being installed already', () => {
    const entries = entriesFor(['essentials'], 'win32', {
      node: { kind: 'installing', phase: 'installing', fraction: null, detail: null },
    });
    const plan = buildInstallPlan(['gh', 'node'], entries, 'win32');
    expect(plan.steps).toEqual(['gh']);
  });

  it('ignores ids that are not in the checklist and lists each item once', () => {
    const entries = entriesFor(['essentials'], 'win32');
    const plan = buildInstallPlan(['gh', 'gh', 'not-in-the-list', 'npm', 'node'], entries, 'win32');
    expect(plan.steps).toEqual(['gh', 'node']);
  });

  it('refuses a dependency cycle instead of looping', () => {
    const a: DevItem = {
      id: 'a',
      name: 'A',
      description: 'Depends on b.',
      stack: 'essentials',
      dependsOn: ['b'],
      detect: { kind: 'command', command: 'a', args: [] },
      recipes: { win32: [{ kind: 'winget', id: 'Vendor.A' }] },
    };
    const b: DevItem = { ...a, id: 'b', name: 'B', dependsOn: ['a'] };
    const entries = new Map<string, PlanEntry>([
      ['a', { item: a, mode: selectRecipe(a, contexts.win32), state: MISSING }],
      ['b', { item: b, mode: selectRecipe(b, contexts.win32), state: MISSING }],
    ]);
    expect(() => buildInstallPlan(['a'], entries, 'win32')).toThrow(/cycle/i);
  });
});

describe('collectConsents', () => {
  it('lists the agreements behind the steps that will run, once each', () => {
    const consents = collectConsents([
      'git',
      'android-licenses',
      'docker-desktop',
      'android-licenses',
    ]);
    expect(consents.map((consent) => consent.title)).toEqual([
      'Android SDK licenses',
      'Docker Subscription Service Agreement',
    ]);
  });

  it('is empty when none of the steps carry one', () => {
    expect(collectConsents(['git', 'node'])).toEqual([]);
  });

  it('ignores ids that are not in the catalog', () => {
    expect(collectConsents(['nope'])).toEqual([]);
  });
});

describe('summarizeSetup', () => {
  it('counts only the required items toward ready', () => {
    const entries = entriesFor(['essentials'], 'win32', installed('git', 'node', 'pnpm'));
    const summary = summarizeSetup([...entries.values()]);
    // git, node, npm, gh are required; pnpm and gh-auth are optional.
    expect(summary.total).toBe(4);
    expect(summary.ready).toBe(2);
    expect(summary.missing).toBe(2);
    expect(summary.checking).toBe(0);
  });

  it('reports each stack on its own', () => {
    const entries = entriesFor(['essentials', 'docker'], 'win32', installed('git', 'wsl2'));
    const summary = summarizeSetup([...entries.values()]);
    expect(summary.stacks.find((stack) => stack.stack === 'essentials')).toMatchObject({
      ready: 1,
      total: 4,
    });
    expect(summary.stacks.find((stack) => stack.stack === 'docker')).toMatchObject({
      ready: 1,
      total: 3,
    });
  });

  it('keeps unanswered items out of the missing count', () => {
    const entries = entriesFor(['essentials'], 'win32', {
      git: { kind: 'checking' },
      node: { kind: 'checking' },
    });
    const summary = summarizeSetup([...entries.values()]);
    expect(summary.checking).toBe(2);
    expect(summary.missing).toBe(2);
    expect(summary.ready).toBe(0);
  });

  it('is complete only when nothing is checking or missing', () => {
    const all = entriesFor(['essentials'], 'win32', installed('git', 'node', 'npm', 'gh'));
    expect(summarizeSetup([...all.values()]).complete).toBe(true);
    const some = entriesFor(['essentials'], 'win32', installed('git', 'node', 'npm'));
    expect(summarizeSetup([...some.values()]).complete).toBe(false);
  });

  it('is not complete with no items at all', () => {
    expect(summarizeSetup([]).complete).toBe(false);
  });
});

describe('the catalog still builds a plan', () => {
  it('has an install-all plan on every OS for every stack without throwing', () => {
    for (const os of ['win32', 'darwin', 'linux'] as const) {
      const entries = entriesFor(['essentials', 'dotnet', 'flutter', 'docker'], os);
      expect(() => buildInstallPlan(missingItemIds(entries), entries, os)).not.toThrow();
    }
  });

  it('keeps every item in exactly one bucket', () => {
    for (const os of ['win32', 'darwin', 'linux'] as const) {
      const entries = entriesFor(['essentials', 'dotnet', 'flutter', 'docker'], os);
      const plan = buildInstallPlan(missingItemIds(entries), entries, os);
      const all = [...plan.steps, ...plan.manual, ...plan.deferred];
      expect(new Set(all).size, os).toBe(all.length);
      for (const id of all) expect(getDevItem(id), id).toBeDefined();
    }
  });
});

describe('updatableItemIds and buildUpdatePlan', () => {
  const withUpdate = (latest: string | null, waiting = false): DevItemState => ({
    kind: 'installed',
    version: '1.0.0',
    onPath: true,
    update: { latest, ...(waiting ? { waiting: true } : {}) },
  });

  /** Every item installed, with the states given laid over their ids. */
  function installedWith(os: DevOs, states: Record<string, DevItemState>): Map<string, PlanEntry> {
    const all = entriesFor(['essentials'], os);
    for (const [id, entry] of all) all.set(id, { ...entry, state: states[id] ?? INSTALLED });
    return all;
  }

  it('lists the installed items with an update, in checklist order, optional ones too', () => {
    const entries = installedWith('win32', {
      gh: withUpdate('2.103.0'),
      node: withUpdate('24.22.1'),
      pnpm: withUpdate(null),
    });

    expect(updatableItemIds(entries)).toEqual(['node', 'gh', 'pnpm']);
  });

  it('leaves out an update that is already waiting on a terminal', () => {
    const entries = installedWith('win32', {
      gh: withUpdate('2.103.0', true),
      node: withUpdate(null),
    });

    expect(updatableItemIds(entries)).toEqual(['node']);
  });

  it('runs winget updates in the app', () => {
    const entries = installedWith('win32', { gh: withUpdate('2.103.0'), node: withUpdate(null) });

    expect(buildUpdatePlan(updatableItemIds(entries), entries)).toEqual({
      steps: ['node', 'gh'],
      manual: [],
    });
  });

  it('hands a package-manager update that needs a password to the person', () => {
    const entries = installedWith('linux', { gh: withUpdate(null), node: withUpdate(null) });

    expect(buildUpdatePlan(updatableItemIds(entries), entries)).toEqual({
      steps: [],
      manual: ['node', 'gh'],
    });
  });

  it('only plans what it was asked for, and nothing that has no update', () => {
    const entries = installedWith('win32', { gh: withUpdate('2.103.0'), node: withUpdate(null) });

    expect(buildUpdatePlan(['gh', 'git', 'missing-id', 'gh'], entries)).toEqual({
      steps: ['gh'],
      manual: [],
    });
  });
});

describe('summarizeSetup with updates', () => {
  it('counts the rows that can be updated, optional ones included, without changing ready', () => {
    const entryFor = (id: string, state: DevItemState): PlanEntry => {
      const found = getDevItem(id);
      if (!found) throw new Error(`no catalog item ${id}`);
      return { item: found, mode: selectRecipe(found, contexts.win32), state };
    };

    const summary = summarizeSetup([
      entryFor('git', INSTALLED),
      entryFor('node', { ...INSTALLED, update: { latest: '24.22.1' } }),
      entryFor('pnpm', { ...INSTALLED, update: { latest: null } }),
    ]);

    expect(summary).toMatchObject({ total: 2, ready: 2, updates: 2, complete: true });
  });
});
