import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ActivityEvent,
  AppSettings,
  BlueprintPreset,
  Project,
  ProjectBlueprint,
} from '@agentmat/core';
import { createBlankBlueprint, defaultProjectNotifications } from '@agentmat/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredProjectEnvironment } from '../shared/apiTypes';
import { useTempUserData } from '../test/main/ipcHarness';

/**
 * The JSON store behind every page: what a fresh profile reads, what an old profile gets migrated
 * into, and whether a write can lose data. Everything here goes through the real filesystem in a
 * throwaway userData folder, because the write path (temp file then rename) is the part worth
 * testing and mocking fs would test nothing.
 */

const userData = useTempUserData();

/**
 * The sqlite-backed stores open their file once and never close it, and Windows refuses to remove
 * a folder that still holds an open file, so the harness's cleanup would throw EPERM after any
 * test that reached the revisions database. Recording each connection as it prepares its first
 * statement is enough to close them all before the temp folder goes away.
 */
const openDatabases = new Set<DatabaseSync>();
const nativePrepare = DatabaseSync.prototype.prepare;
const nativeExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.prepare = function trackedPrepare(this: DatabaseSync, sql: string) {
  openDatabases.add(this);
  return nativePrepare.call(this, sql);
};
DatabaseSync.prototype.exec = function trackedExec(this: DatabaseSync, sql: string) {
  openDatabases.add(this);
  return nativeExec.call(this, sql);
};

afterEach(() => {
  for (const database of openDatabases) {
    try {
      database.close();
    } catch {
      // Already closed, or never opened. Either way there is nothing left holding the folder.
    }
  }
  openDatabases.clear();
});

type StoreModule = typeof import('./store');

/**
 * The handler modules register at import time and `useTempUserData` resets the registry before
 * each test, so the module has to be pulled in from inside the test to see this test's folder.
 */
async function loadStore(): Promise<StoreModule> {
  return import('./store');
}

/** A project with every field a current build writes, for the set/get round trips. */
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo',
    folderPath: 'C:/demo',
    description: '',
    tags: [],
    agentType: 'claude-code',
    notes: '',
    runCommands: [],
    prompt: '',
    notifications: defaultProjectNotifications(),
    cliId: null,
    iconDataUrl: null,
    iconFile: null,
    iconBgColor: null,
    iconColor: null,
    websiteUrl: '',
    repoUrl: '',
    githubActionsMuted: [],
    pinned: false,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Project;
}

/** A tiny real PNG, small enough that the icon resizer hands it straight back. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

describe('a fresh profile', () => {
  it('reads the built-in settings when settings.json does not exist yet', async () => {
    const { store, DEFAULT_SETTINGS } = await loadStore();

    const settings = await store.getSettings();

    expect(settings.theme).toBe('system');
    expect(settings.defaultCliId).toBeNull();
    expect(settings.pingTargets).toEqual(['1.1.1.1']);
    expect(settings.keepAwake).toBe('agent');
    expect(settings.dashboardStatCards).toEqual(['location']);
    expect(settings.dashboardUsageCards).toEqual(['claude-code']);
    expect(settings.dashboardUsageSummaryCards).toEqual([
      'tokens-today',
      'tokens-week',
      'cost-today',
    ]);
    expect(settings.dashboardChartCards).toEqual(DEFAULT_SETTINGS.dashboardChartCards);
    // Every card in the lists above has a cell, so the dashboard doesn't append any on first load.
    expect(settings.dashboardLayout.flatMap((row) => row.items).sort()).toEqual(
      [
        ...settings.dashboardChartCards,
        'stat:location',
        'usage:claude-code',
        'summary:tokens-today',
        'summary:tokens-week',
        'summary:cost-today',
      ].sort(),
    );
    expect(settings.dashboardIntroducedCharts).toEqual(settings.dashboardChartCards);
    // Nothing was written just by reading: a first launch that crashes leaves no half profile.
    expect(existsSync(userData.dataFile('settings.json'))).toBe(false);
  });

  it('keeps the plain dashboard defaults for an existing profile that predates them', async () => {
    writeFileSync(
      userData.dataFile('settings.json'),
      JSON.stringify({ dashboardChartOrder: ['memory', 'cpu'] }),
      'utf-8',
    );
    const { store, DEFAULT_SETTINGS } = await loadStore();

    const settings = await store.getSettings();

    // The first-run layout would hide this user's legacy card order, so it isn't applied here.
    expect(settings.dashboardLayout).toEqual([]);
    expect(settings.dashboardChartOrder).toEqual(['memory', 'cpu']);
    expect(settings.dashboardStatCards).toEqual(DEFAULT_SETTINGS.dashboardStatCards);
  });

  it('round trips the defaults, so reading what was written changes nothing', async () => {
    const { store } = await loadStore();

    const first = await store.getSettings();
    await store.setSettings(first);
    const second = await store.getSettings();

    expect(second).toEqual(first);
  });

  it('gives every list store an empty value rather than throwing', async () => {
    const { store } = await loadStore();

    expect(await store.getProjects()).toEqual([]);
    expect(await store.getActivity()).toEqual([]);
    expect(await store.getTemplates()).toEqual([]);
    expect(await store.getRepositories()).toEqual([]);
    expect(await store.getFavoriteSkills()).toEqual([]);
    expect(await store.getMcpRepositories()).toEqual([]);
    expect(await store.getProjectDrafts()).toEqual([]);
    expect(await store.getBlueprints()).toEqual([]);
    expect(await store.getScheduledTasks()).toEqual([]);
    expect(await store.getRemoteServers()).toEqual([]);
    expect(await store.getSshServers()).toEqual([]);
    expect(await store.getRdpServers()).toEqual([]);
    expect(await store.getProjectEnvironments()).toEqual([]);
    expect(await store.getAppNotifications()).toEqual([]);
    expect(await store.getSshVault()).toBeNull();
    expect(await store.getPipelineWatch()).toEqual({ lastCompletedRunId: {} });
    expect(await store.getToolUpdateWatch()).toEqual({ lastCheckedAt: null });
    expect(await store.getLastRunInfoByCli()).toEqual({});
  });

  it('seeds the blueprint presets once and keeps their ids stable', async () => {
    const { store } = await loadStore();

    const seeded = await store.getBlueprintPresets();
    expect(seeded.length).toBeGreaterThan(0);
    // Written out on the first read, which is what makes editing or deleting one stick.
    expect(existsSync(userData.dataFile('blueprint-presets.json'))).toBe(true);

    const again = await store.getBlueprintPresets();
    expect(again.map((preset) => preset.id)).toEqual(seeded.map((preset) => preset.id));
  });

  it('leaves the presets empty once the user has deleted them all', async () => {
    const { store } = await loadStore();
    await store.setBlueprintPresets([]);

    // An empty array is a decision, not an absent file, so the starter set must not come back.
    expect(await store.getBlueprintPresets()).toEqual([]);
  });
});

describe('settings migrations', () => {
  it('renames the old week-opus reset window to week-fable', async () => {
    userData.writeData('settings.json', {
      usageResetAlerts: { enabled: true, windows: ['week-opus', 'session'] },
    });
    const { store } = await loadStore();

    const settings = await store.getSettings();

    // A saved alert still naming the old key would match no window and never fire.
    expect(settings.usageResetAlerts.windows).toContain('week-fable');
    expect(settings.usageResetAlerts.windows).not.toContain('week-opus');
  });

  it('does not duplicate the window when both keys were saved', async () => {
    userData.writeData('settings.json', {
      usageResetAlerts: { enabled: true, windows: ['week-opus', 'week-fable'] },
    });
    const { store } = await loadStore();

    const windows = (await store.getSettings()).usageResetAlerts.windows;

    expect(windows.filter((key) => key === 'week-fable')).toHaveLength(1);
  });

  it('survives a half written alerts block with no windows array', async () => {
    // A crash mid-write used to leave this shape, and the renderer threw on first access.
    userData.writeData('settings.json', { usageResetAlerts: { enabled: true } });
    const { store } = await loadStore();

    const settings = await store.getSettings();

    expect(Array.isArray(settings.usageResetAlerts.windows)).toBe(true);
  });

  it('carries the old networkQualityAlerts flag onto the pet setting', async () => {
    userData.writeData('settings.json', { networkQualityAlerts: true });
    const { store } = await loadStore();

    expect((await store.getSettings()).desktopPetNetworkQuality).toBe(true);
  });

  it('gives every status bar provider an on or off, keeping only a saved false as off', async () => {
    userData.writeData('settings.json', {
      statusBarUsage: { codex: false, cursor: 'no', gemini: false },
    });
    const { store } = await loadStore();

    expect((await store.getSettings()).statusBarUsage).toEqual({
      'claude-code': true,
      codex: false,
      cursor: true,
    });
  });

  it('shows every status bar provider when the saved value is not an object', async () => {
    userData.writeData('settings.json', { statusBarUsage: 'off' });
    const { store } = await loadStore();

    expect((await store.getSettings()).statusBarUsage).toEqual({
      'claude-code': true,
      codex: true,
      cursor: true,
    });
  });

  it('falls back to the system theme when the saved value is not a theme', async () => {
    userData.writeData('settings.json', { theme: 'neon' });
    const { store } = await loadStore();

    expect((await store.getSettings()).theme).toBe('system');
  });

  it('keeps the opt-out booleans opt-out and the opt-in booleans opt-in', async () => {
    userData.writeData('settings.json', {
      keepTerminalsRunning: false,
      workspaceNotifications: false,
      checkToolUpdatesEnabled: false,
      desktopPetCanMove: false,
      desktopPetCanParachute: 'yes',
      desktopPetGear3d: 1,
      vaultLockOnSystemLock: false,
    });
    const { store } = await loadStore();

    const settings = await store.getSettings();

    expect(settings.keepTerminalsRunning).toBe(false);
    expect(settings.workspaceNotifications).toBe(false);
    expect(settings.checkToolUpdatesEnabled).toBe(false);
    expect(settings.desktopPetCanMove).toBe(false);
    // Anything that is not literally true stays off, so a stray string cannot enable it.
    expect(settings.desktopPetCanParachute).toBe(false);
    expect(settings.desktopPetGear3d).toBe(false);
    expect(settings.vaultLockOnSystemLock).toBe(false);
  });

  describe('stopDockerWithRun', () => {
    it('asks by default, so nothing is stopped without the user hearing about it', async () => {
      const { store } = await loadStore();

      expect((await store.getSettings()).stopDockerWithRun).toBe('ask');
    });

    it.each(['ask', 'stop', 'keep'] as const)('keeps a saved %s', async (mode) => {
      userData.writeData('settings.json', { stopDockerWithRun: mode });
      const { store } = await loadStore();

      expect((await store.getSettings()).stopDockerWithRun).toBe(mode);
    });

    it.each([
      ['an unknown word', 'always'],
      ['a boolean', true],
      ['a number', 1],
      ['null', null],
    ])('falls back to asking for %s', async (_name, value) => {
      userData.writeData('settings.json', { stopDockerWithRun: value });
      const { store } = await loadStore();

      // Stopping someone's database on the strength of a corrupted file would be worse than asking.
      expect((await store.getSettings()).stopDockerWithRun).toBe('ask');
    });
  });

  describe('autoPauseRunsWhileAgentWorks', () => {
    it('is off by default, so a run never freezes without the user asking for it', async () => {
      const { store } = await loadStore();

      expect((await store.getSettings()).autoPauseRunsWhileAgentWorks).toBe(false);
    });

    it('keeps a saved true', async () => {
      userData.writeData('settings.json', { autoPauseRunsWhileAgentWorks: true });
      const { store } = await loadStore();

      expect((await store.getSettings()).autoPauseRunsWhileAgentWorks).toBe(true);
    });

    it.each(['yes', 1, null])('stays off for %s', async (value) => {
      userData.writeData('settings.json', { autoPauseRunsWhileAgentWorks: value });
      const { store } = await loadStore();

      expect((await store.getSettings()).autoPauseRunsWhileAgentWorks).toBe(false);
    });
  });

  describe('idle resources', () => {
    it('lists things as idle after 20 minutes and alerts about them by default', async () => {
      const { store } = await loadStore();

      const settings = await store.getSettings();

      expect(settings.idleResourceMinutes).toBe(20);
      expect(settings.idleResourceNotify).toBe(true);
    });

    it('gives a profile that predates the setting the same defaults', async () => {
      userData.writeData('settings.json', { theme: 'dark' });
      const { store } = await loadStore();

      const settings = await store.getSettings();

      expect(settings.idleResourceMinutes).toBe(20);
      expect(settings.idleResourceNotify).toBe(true);
    });

    it.each([1, 45, 1440])('keeps a saved %s minutes', async (minutes) => {
      userData.writeData('settings.json', { idleResourceMinutes: minutes });
      const { store } = await loadStore();

      expect((await store.getSettings()).idleResourceMinutes).toBe(minutes);
    });

    it.each([
      ['zero', 0, 1],
      ['negative', -4, 1],
      ['past a day', 99_999, 1440],
      ['a decimal', 12.6, 13],
    ])('clamps %s into range', async (_name, value, expected) => {
      userData.writeData('settings.json', { idleResourceMinutes: value });
      const { store } = await loadStore();

      expect((await store.getSettings()).idleResourceMinutes).toBe(expected);
    });

    it.each([
      ['a string', '30'],
      ['a boolean', true],
      ['null', null],
    ])('falls back to 20 minutes for %s', async (_name, value) => {
      userData.writeData('settings.json', { idleResourceMinutes: value });
      const { store } = await loadStore();

      expect((await store.getSettings()).idleResourceMinutes).toBe(20);
    });

    it('remembers alerts once they are switched off, and treats anything else as on', async () => {
      userData.writeData('settings.json', { idleResourceNotify: false });
      const off = await loadStore();
      expect((await off.store.getSettings()).idleResourceNotify).toBe(false);

      userData.writeData('settings.json', { idleResourceNotify: 'nope' });
      const junk = await loadStore();
      expect((await junk.store.getSettings()).idleResourceNotify).toBe(true);
    });
  });

  describe('dev setup stacks', () => {
    it('starts with Essentials alone', async () => {
      const { store } = await loadStore();

      expect((await store.getSettings()).devSetupStacks).toEqual(['essentials']);
    });

    it('gives a profile that predates the setting the same default', async () => {
      userData.writeData('settings.json', { theme: 'dark' });
      const { store } = await loadStore();

      expect((await store.getSettings()).devSetupStacks).toEqual(['essentials']);
    });

    it('keeps the stacks a user picked, in catalog order, with Essentials first', async () => {
      userData.writeData('settings.json', { devSetupStacks: ['docker', 'flutter'] });
      const { store } = await loadStore();

      expect((await store.getSettings()).devSetupStacks).toEqual([
        'essentials',
        'flutter',
        'docker',
      ]);
    });

    it('drops unknown and repeated stacks from a hand-edited settings file', async () => {
      userData.writeData('settings.json', { devSetupStacks: ['dotnet', 'bogus', 'dotnet', 7] });
      const { store } = await loadStore();

      expect((await store.getSettings()).devSetupStacks).toEqual(['essentials', 'dotnet']);
    });

    it.each([
      ['a string', 'docker'],
      ['null', null],
      ['an object', { docker: true }],
    ])('falls back to Essentials for %s', async (_name, value) => {
      userData.writeData('settings.json', { devSetupStacks: value });
      const { store } = await loadStore();

      expect((await store.getSettings()).devSetupStacks).toEqual(['essentials']);
    });
  });

  describe('dashboard charts added after the first release', () => {
    const ORIGINAL = ['cpu', 'memory', 'disk', 'gpu', 'network', 'pings', 'github'];

    it('treats a profile with no record of what it was offered as having seen the originals', async () => {
      userData.writeData('settings.json', { dashboardChartCards: ORIGINAL });
      const { store } = await loadStore();

      const settings = await store.getSettings();

      // The later charts are missing from this list, so the dashboard introduces them once.
      expect(settings.dashboardIntroducedCharts).toEqual(ORIGINAL);
      expect(settings.dashboardIntroducedCharts).not.toContain('resource-usage');
      expect(settings.dashboardIntroducedCharts).not.toContain('idle-resources');
      expect(settings.dashboardIntroducedCharts).not.toContain('github-actions');
    });

    it('keeps the record a profile already has', async () => {
      userData.writeData('settings.json', {
        dashboardIntroducedCharts: [...ORIGINAL, 'github-actions'],
      });
      const { store } = await loadStore();

      expect((await store.getSettings()).dashboardIntroducedCharts).toEqual([
        ...ORIGINAL,
        'github-actions',
      ]);
    });

    it('places both usage cards in the default layout, side by side', async () => {
      const { DEFAULT_SETTINGS, store } = await loadStore();

      const settings = await store.getSettings();

      expect(settings.dashboardChartCards).toContain('resource-usage');
      expect(settings.dashboardChartCards).toContain('idle-resources');
      expect(DEFAULT_SETTINGS.dashboardChartCards).toContain('idle-resources');
      expect(
        settings.dashboardLayout.find((row) => row.items.includes('idle-resources'))?.items,
      ).toEqual(['resource-usage', 'idle-resources']);
    });
  });

  it('keeps pipeline failure notices and click-to-open on for a profile that predates them', async () => {
    userData.writeData('settings.json', { theme: 'dark' });
    const { store } = await loadStore();

    const settings = await store.getSettings();

    expect(settings.pipelineFailureNotify).toBe(true);
    // The Pipelines page is where a click always went.
    expect(settings.pipelineFailureOpen).toBe('pipelines');
  });

  it('remembers pipeline failure notices switched off and the place a click goes', async () => {
    userData.writeData('settings.json', {
      pipelineFailureNotify: false,
      pipelineFailureOpen: 'workspace',
    });
    const { store } = await loadStore();

    const settings = await store.getSettings();

    expect(settings.pipelineFailureNotify).toBe(false);
    expect(settings.pipelineFailureOpen).toBe('workspace');
  });

  it.each([
    // It was an on/off switch before it became a choice, and off meant "do nothing".
    [false, 'none'],
    [true, 'pipelines'],
    ['somewhere-else', 'pipelines'],
  ])('reads a saved click target of %j as %s', async (saved, expected) => {
    userData.writeData('settings.json', { pipelineFailureOpen: saved });
    const { store } = await loadStore();

    expect((await store.getSettings()).pipelineFailureOpen).toBe(expected);
  });

  it('remembers the 3D rope and parachute once it is switched off', async () => {
    userData.writeData('settings.json', { desktopPetGear3d: false });
    const { store } = await loadStore();

    expect((await store.getSettings()).desktopPetGear3d).toBe(false);
  });

  it('starts a fresh profile on Fandi, walking the right way with 3D gear', async () => {
    const { store } = await loadStore();

    const settings = await store.getSettings();

    expect(settings.desktopPetCharacterId).toBe('fandi');
    expect(settings.desktopPetFlippedIds).toEqual(['fandi']);
    expect(settings.desktopPetGear3d).toBe(true);
    expect(settings.desktopPetScale).toBe(100);
  });

  it('keeps the flipped pet list to unique character ids', async () => {
    userData.writeData('settings.json', { desktopPetFlippedIds: ['nori', 'nori', 3, 'hex'] });
    const { store } = await loadStore();

    expect((await store.getSettings()).desktopPetFlippedIds).toEqual(['nori', 'hex']);
  });

  it('sizes in the Build Prompt dialog right away for a profile that predates the setting', async () => {
    userData.writeData('settings.json', { theme: 'dark' });
    const { store, DEFAULT_SETTINGS } = await loadStore();

    expect(DEFAULT_SETTINGS.promptBuilderAutoSize).toBe(true);
    expect((await store.getSettings()).promptBuilderAutoSize).toBe(true);
  });

  it('keeps the Build Prompt sizing off once it is switched off', async () => {
    userData.writeData('settings.json', { promptBuilderAutoSize: false });
    const { store } = await loadStore();

    expect((await store.getSettings()).promptBuilderAutoSize).toBe(false);
  });

  it('keeps sizing on for a stored value that is not literally false, like the other opt-out flags', async () => {
    userData.writeData('settings.json', { promptBuilderAutoSize: 'no' });
    const { store } = await loadStore();

    expect((await store.getSettings()).promptBuilderAutoSize).toBe(true);
  });

  it('saves a switch-off to disk and reads it back', async () => {
    const { store } = await loadStore();
    const settings = await store.getSettings();

    await store.setSettings({ ...settings, promptBuilderAutoSize: false });

    expect((await store.getSettings()).promptBuilderAutoSize).toBe(false);
  });

  it('drops duplicate and non-string entries from the CLI order', async () => {
    userData.writeData('settings.json', { cliOrder: ['claude', 'claude', 7, 'codex'] });
    const { store } = await loadStore();

    expect((await store.getSettings()).cliOrder).toEqual(['claude', 'codex']);
  });

  it('offers the default review commands until the user edits them', async () => {
    const { store } = await loadStore();
    expect((await store.getSettings()).reviewCommands).toContain('@claude review');
  });

  it('keeps saved review commands trimmed and unique', async () => {
    userData.writeData('settings.json', { reviewCommands: [' @bot go ', '@bot go', 4] });
    const { store } = await loadStore();

    expect((await store.getSettings()).reviewCommands).toEqual(['@bot go']);
  });

  it('replaces a cliOrder that is not an array at all', async () => {
    userData.writeData('settings.json', { cliOrder: 'claude' });
    const { store } = await loadStore();

    expect((await store.getSettings()).cliOrder).toEqual([]);
  });

  it('opens on the last page by default, including for a file that predates the setting', async () => {
    const fresh = await loadStore();
    expect((await fresh.store.getSettings()).startupPage).toBe('last');

    userData.writeData('settings.json', { theme: 'dark' });
    expect((await fresh.store.getSettings()).startupPage).toBe('last');
  });

  it('falls back to the last page when the saved startup page is not a page', async () => {
    const { store } = await loadStore();

    for (const startupPage of ['/widget/x', 42, '/nowhere', null]) {
      userData.writeData('settings.json', { startupPage });
      expect((await store.getSettings()).startupPage).toBe('last');
    }
  });

  it('keeps a startup page picked from the list', async () => {
    userData.writeData('settings.json', { startupPage: '/usage' });
    const { store } = await loadStore();

    expect((await store.getSettings()).startupPage).toBe('/usage');
  });

  it('keeps the main menu on the left by default, including for a file that predates the setting', async () => {
    const fresh = await loadStore();
    expect((await fresh.store.getSettings()).menuPosition).toBe('left');

    userData.writeData('settings.json', { theme: 'dark' });
    expect((await fresh.store.getSettings()).menuPosition).toBe('left');
  });

  it('puts the main menu back on the left when the saved position is not one it knows', async () => {
    const { store } = await loadStore();

    for (const menuPosition of ['diagonal', 42, null, 'TOP']) {
      userData.writeData('settings.json', { menuPosition });
      expect((await store.getSettings()).menuPosition).toBe('left');
    }
  });

  it('keeps the main menu along the top once it was moved there', async () => {
    userData.writeData('settings.json', { menuPosition: 'top' });
    const { store } = await loadStore();

    expect((await store.getSettings()).menuPosition).toBe('top');
  });

  it('fills in a key the saved file has never heard of', async () => {
    userData.writeData('settings.json', { theme: 'dark' });
    const { store, DEFAULT_SETTINGS } = await loadStore();

    const settings = await store.getSettings();

    expect(settings.theme).toBe('dark');
    expect(settings.ollamaBaseUrl).toBe(DEFAULT_SETTINGS.ollamaBaseUrl);
  });
});

describe('the Android SDK settings', () => {
  it('defaults to auto-detection with emulators left running', async () => {
    const { store } = await loadStore();

    const settings = await store.getSettings();

    // Null means "work it out from ANDROID_HOME and the usual install paths".
    expect(settings.androidSdkPath).toBeNull();
    expect(settings.androidEmulatorLaunchFlags).toBe('');
    // An emulator is a window the user can close themselves, so quitting AgentMate leaves it be.
    expect(settings.androidStopEmulatorsOnQuit).toBe(false);
    expect(settings.androidCapturePath).toBeNull();
  });

  it('trims a blank SDK path back to null so detection takes over again', async () => {
    userData.writeData('settings.json', { androidSdkPath: '   ', androidCapturePath: '' });
    const { store } = await loadStore();

    const settings = await store.getSettings();

    expect(settings.androidSdkPath).toBeNull();
    expect(settings.androidCapturePath).toBeNull();
  });

  it('keeps a real SDK path and trims the whitespace around it', async () => {
    userData.writeData('settings.json', { androidSdkPath: '  C:/Android/Sdk  ' });
    const { store } = await loadStore();

    expect((await store.getSettings()).androidSdkPath).toBe('C:/Android/Sdk');
  });

  it('refuses a non-string SDK path rather than passing it to a command line', async () => {
    userData.writeData('settings.json', { androidSdkPath: 42, androidStopEmulatorsOnQuit: 'yes' });
    const { store } = await loadStore();

    const settings = await store.getSettings();

    expect(settings.androidSdkPath).toBeNull();
    expect(settings.androidStopEmulatorsOnQuit).toBe(false);
  });

  it('caps the launch flags so one bad paste cannot build an enormous command line', async () => {
    userData.writeData('settings.json', { androidEmulatorLaunchFlags: '-x '.repeat(400) });
    const { store } = await loadStore();

    expect((await store.getSettings()).androidEmulatorLaunchFlags.length).toBeLessThanOrEqual(500);
  });
});

describe('project defaults on read', () => {
  it('turns the old single runCommand string into the run commands list', async () => {
    userData.writeData('projects.json', [
      { id: 'p1', name: 'Old', folderPath: 'C:/old', runCommand: '  pnpm dev  ' },
    ]);
    const { store } = await loadStore();

    const [loaded] = await store.getProjects();

    expect(loaded.runCommands).toEqual([{ id: 'legacy', label: '', command: 'pnpm dev' }]);
    // The legacy key itself is gone, so a later write cannot resurrect it.
    expect('runCommand' in loaded).toBe(false);
  });

  it('drops the githubActions opt-in list that predates watching everything', async () => {
    userData.writeData('projects.json', [
      { id: 'p1', name: 'Old', folderPath: 'C:/old', githubActions: ['ci.yml'] },
    ]);
    const { store } = await loadStore();

    expect('githubActions' in (await store.getProjects())[0]).toBe(false);
  });

  it('fills the fields an older entry never had', async () => {
    userData.writeData('projects.json', [{ id: 'p1', name: 'Old', folderPath: 'C:/old' }]);
    const { store } = await loadStore();

    expect(await store.getProjects()).toEqual([
      expect.objectContaining({
        prompt: '',
        pinned: false,
        archived: false,
        cliId: null,
        iconDataUrl: null,
        iconFile: null,
        websiteUrl: '',
        repoUrl: '',
        githubActionsMuted: [],
        notifications: defaultProjectNotifications(),
        worktreeSetup: { command: '', copyGlobs: null },
      }),
    ]);
  });

  it('rejects a colour that is not a hex string', async () => {
    userData.writeData('projects.json', [
      { id: 'p1', name: 'Old', folderPath: 'C:/old', iconBgColor: 'red', iconColor: '#00ff00' },
    ]);
    const { store } = await loadStore();

    const [loaded] = await store.getProjects();

    expect(loaded.iconBgColor).toBeNull();
    expect(loaded.iconColor).toBe('#00ff00');
  });
});

describe('a corrupt store file', () => {
  it('surfaces the parse failure instead of handing back a wrong profile', async () => {
    writeFileSync(userData.dataFile('settings.json'), '{ "theme": "dark"', 'utf-8');
    const { store } = await loadStore();

    // Silently falling back to the defaults would look like the user's settings were wiped,
    // so the read fails loudly and the caller decides what to do about it.
    await expect(store.getSettings()).rejects.toThrow(SyntaxError);
  });

  it('lets the orphan sweeps carry on when a file cannot be parsed', async () => {
    writeFileSync(userData.dataFile('projects.json'), 'not json at all', 'utf-8');
    const { pruneOrphanBlueprints, pruneOrphanEnvironments, migrateInlineProjectIcons } =
      await loadStore();

    // These run at startup. A bad file must not stop the app from booting.
    await expect(pruneOrphanBlueprints()).resolves.toBeUndefined();
    await expect(pruneOrphanEnvironments()).resolves.toBeUndefined();
    await expect(migrateInlineProjectIcons()).resolves.toBeUndefined();
  });
});

describe('the atomic write', () => {
  it('leaves no temp file behind once the write finished', async () => {
    const { store } = await loadStore();

    await store.setTemplates([]);

    const leftovers = readdirSync(join(userData.dir, 'data')).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('replaces the whole file rather than writing over the start of it', async () => {
    const { store } = await loadStore();
    const long = Array.from({ length: 300 }, (_, index) => ({
      id: `old-${index}`,
      type: 'project-created',
      message: 'a very long message '.repeat(20),
      createdAt: '2026-01-01T00:00:00.000Z',
    })) as ActivityEvent[];

    await store.setActivity(long);
    await store.setActivity([]);

    // A write that truncated in place would leave a tail of the old document behind.
    expect(await readFile(userData.dataFile('activity-log.json'), 'utf-8')).toBe('[]');
    expect(await store.getActivity()).toEqual([]);
  });

  it('keeps concurrent writes to different stores apart', async () => {
    const { store } = await loadStore();

    await Promise.all([
      store.setActivity([]),
      store.setTemplates([]),
      store.setRepositories([]),
      store.setScheduledTasks([]),
      store.setLastRunInfoByCli({ claude: { cwd: 'C:/x' } } as never),
    ]);

    expect(await store.getLastRunInfoByCli()).toEqual({ claude: { cwd: 'C:/x' } });
    expect(await store.getTemplates()).toEqual([]);
  });

  it('never blends two overlapping writes to the same store', async () => {
    const { store } = await loadStore();
    const payloads = Array.from({ length: 10 }, (_, index) => [
      { id: `t${index}`, name: `Template ${index}`, content: 'x', createdAt: '2026-01-01' },
    ]);

    // allSettled, not all: on Windows two renames racing for the same destination can have one
    // refused by the OS with EPERM. What has to hold either way is that the file left behind is
    // one writer's whole document, never a mix of two.
    const results = await Promise.allSettled(
      payloads.map((one) => store.setTemplates(one as never)),
    );

    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(payloads).toContainEqual(await store.getTemplates());
  });
});

describe('migrateInlineProjectIcons', () => {
  it('moves an inlined icon out into its own file', async () => {
    userData.writeData('projects.json', [
      { id: 'p1', name: 'Inline', folderPath: 'C:/x', iconDataUrl: PNG_DATA_URL },
    ]);
    const { store, migrateInlineProjectIcons } = await loadStore();

    await migrateInlineProjectIcons();

    const onDisk = JSON.parse(
      readFileSync(userData.dataFile('projects.json'), 'utf-8'),
    ) as Project[];
    expect(onDisk[0].iconDataUrl).toBeNull();
    expect(onDisk[0].iconFile).toMatch(/\.png$/);
    expect(existsSync(join(userData.dir, 'data', 'project-icons', onDisk[0].iconFile ?? ''))).toBe(
      true,
    );

    // The renderer still gets a data URL, so the move is invisible to it.
    const [hydrated] = await store.getProjects();
    expect(hydrated.iconDataUrl).toBe(PNG_DATA_URL);
    expect(hydrated.iconFile).toBe(onDisk[0].iconFile);
  });

  it('does not rewrite projects.json when nothing is inlined', async () => {
    userData.writeData('projects.json', [{ id: 'p1', name: 'Plain', folderPath: 'C:/x' }]);
    const before = readFileSync(userData.dataFile('projects.json'), 'utf-8');
    const { migrateInlineProjectIcons } = await loadStore();

    await migrateInlineProjectIcons();

    expect(readFileSync(userData.dataFile('projects.json'), 'utf-8')).toBe(before);
  });

  it('drops an icon file no project points at any more', async () => {
    const { store } = await loadStore();
    await store.setProjects([project({ iconDataUrl: PNG_DATA_URL })]);
    const iconsDir = join(userData.dir, 'data', 'project-icons');
    expect(readdirSync(iconsDir)).toHaveLength(1);

    await store.setProjects([project({ iconDataUrl: null, iconFile: null })]);

    expect(readdirSync(iconsDir)).toEqual([]);
  });
});

describe('pruneOrphanBlueprints', () => {
  it('drops the blueprints and revisions of a project that is gone', async () => {
    const { store, pruneOrphanBlueprints } = await loadStore();
    const { blueprintRevisionDb } = await import('./blueprintRevisionDb');
    await store.setProjects([project({ id: 'live' })]);
    await store.setBlueprints([
      createBlankBlueprint('bp-live', 'live'),
      createBlankBlueprint('bp-dead', 'dead'),
    ]);
    blueprintRevisionDb.add({
      blueprintId: 'bp-dead',
      projectId: 'dead',
      target: 'section',
      stepId: 'idea',
      text: 'gone',
    });
    blueprintRevisionDb.add({
      blueprintId: 'bp-live',
      projectId: 'live',
      target: 'section',
      stepId: 'idea',
      text: 'kept',
    });

    await pruneOrphanBlueprints();

    expect((await store.getBlueprints()).map((one: ProjectBlueprint) => one.id)).toEqual([
      'bp-live',
    ]);
    expect(blueprintRevisionDb.list('dead', 'idea')).toEqual([]);
    expect(blueprintRevisionDb.list('live', 'idea')).toHaveLength(1);
  });

  it('leaves the file alone when every blueprint still has its project', async () => {
    const { store, pruneOrphanBlueprints } = await loadStore();
    await store.setProjects([project({ id: 'live' })]);
    await store.setBlueprints([createBlankBlueprint('bp-live', 'live')]);
    const before = readFileSync(userData.dataFile('blueprints.json'), 'utf-8');

    await pruneOrphanBlueprints();

    expect(readFileSync(userData.dataFile('blueprints.json'), 'utf-8')).toBe(before);
  });

  it('deletes the attachment files the dropped blueprints owned', async () => {
    const { store, pruneOrphanBlueprints } = await loadStore();
    const { writeAttachmentFromDataUrl } = await import('./blueprintFileStore');
    await store.setProjects([]);
    const attachment = await writeAttachmentFromDataUrl('shot.png', PNG_DATA_URL);
    const dead = createBlankBlueprint('bp-dead', 'dead');
    dead.sections[0].attachments = [attachment];
    await store.setBlueprints([dead]);
    const filePath = join(userData.dir, 'data', 'blueprint-files', attachment.fileName);
    expect(existsSync(filePath)).toBe(true);

    await pruneOrphanBlueprints();

    expect(existsSync(filePath)).toBe(false);
  });
});

describe('pruneOrphanEnvironments', () => {
  it('drops environments whose project is gone and keeps the rest', async () => {
    const { store, pruneOrphanEnvironments } = await loadStore();
    await store.setProjects([project({ id: 'live' })]);
    const environments = [
      { id: 'e1', projectId: 'live' },
      { id: 'e2', projectId: 'dead' },
    ] as unknown as StoredProjectEnvironment[];
    await store.setProjectEnvironments(environments);

    await pruneOrphanEnvironments();

    expect((await store.getProjectEnvironments()).map((one) => one.id)).toEqual(['e1']);
  });

  it('leaves the file alone when nothing is orphaned', async () => {
    const { store, pruneOrphanEnvironments } = await loadStore();
    await store.setProjects([project({ id: 'live' })]);
    await store.setProjectEnvironments([
      { id: 'e1', projectId: 'live' },
    ] as unknown as StoredProjectEnvironment[]);
    const before = readFileSync(userData.dataFile('project-environments.json'), 'utf-8');

    await pruneOrphanEnvironments();

    expect(readFileSync(userData.dataFile('project-environments.json'), 'utf-8')).toBe(before);
  });
});

describe('logActivity', () => {
  it('puts the newest event first and caps the log at 200', async () => {
    const { store, logActivity } = await loadStore();
    await store.setActivity(
      Array.from({ length: 200 }, (_, index) => ({
        id: `old-${index}`,
        type: 'project-created',
        message: 'old',
        createdAt: '2026-01-01T00:00:00.000Z',
      })) as ActivityEvent[],
    );

    const event = await logActivity('project-created', 'newest', { projectId: 'p1' });

    const events = await store.getActivity();
    expect(events).toHaveLength(200);
    expect(events[0]).toEqual(event);
    expect(event.metadata).toEqual({ projectId: 'p1' });
    // The oldest entry fell off the end rather than the log growing without bound.
    expect(events.at(-1)?.id).toBe('old-198');
  });
});

describe('blueprint presets round trip', () => {
  it('keeps what was written, without re-seeding', async () => {
    const { store } = await loadStore();
    const preset: BlueprintPreset = {
      id: 'custom',
      stepId: 'idea',
      label: 'React 19',
      text: 'Use React 19.',
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    await store.setBlueprintPresets([preset]);

    expect(await store.getBlueprintPresets()).toEqual([preset]);
  });
});

describe('settings written by the app come back byte for byte', () => {
  it('keeps a nested block through a save and reload', async () => {
    const { store } = await loadStore();
    const settings: AppSettings = {
      ...(await store.getSettings()),
      theme: 'dark',
      pingTargets: ['8.8.8.8', '1.1.1.1'],
      usageCardModes: { claude: 'subscription' },
    };

    await store.setSettings(settings);

    expect(await store.getSettings()).toEqual(settings);
  });
});

describe('worktree settings', () => {
  it('starts with worktrees next to the repository and .env files copied', async () => {
    const { store } = await loadStore();

    expect((await store.getSettings()).worktrees).toEqual({
      baseDir: null,
      copyGlobs: ['.env', '.env.*'],
      deleteBranchOnRemove: false,
    });
  });

  it('cleans a hand-edited value on read', async () => {
    userData.writeData('settings.json', {
      worktrees: { baseDir: '  ', copyGlobs: ['.env', 7], deleteBranchOnRemove: 'yes' },
    });
    const { store } = await loadStore();

    expect((await store.getSettings()).worktrees).toEqual({
      baseDir: null,
      copyGlobs: ['.env'],
      deleteBranchOnRemove: false,
    });
  });
});

describe('worktree records', () => {
  it('reads an empty list on a fresh profile', async () => {
    const { store } = await loadStore();

    expect(await store.getWorktrees()).toEqual([]);
  });

  it('round-trips records and drops ones that cannot be used', async () => {
    const { store } = await loadStore();
    const good = {
      id: 'wt-1',
      projectId: 'p1',
      path: 'C:/code/app.worktrees/feat',
      branch: 'feat',
      baseBranch: 'main',
      createdAt: '2026-09-25T00:00:00.000Z',
      createdByApp: true,
    };
    userData.writeData('worktrees.json', [good, { id: 'wt-2' }, 'junk', { ...good, id: '' }]);

    expect(await store.getWorktrees()).toEqual([good]);

    await store.setWorktrees([{ ...good, branch: null }]);
    expect(await store.getWorktrees()).toEqual([{ ...good, branch: null }]);
  });
});

describe('help embedding models', () => {
  it('starts with no model picked for any provider', async () => {
    const { store } = await loadStore();

    expect((await store.getSettings()).helpEmbeddingModels).toEqual({});
  });

  it('cleans a hand-edited value on read', async () => {
    userData.writeData('settings.json', {
      helpEmbeddingModels: {
        openai: '  text-embedding-3-large  ',
        gemini: 7,
        ollama: '   ',
        anthropic: 'not-a-provider',
      },
    });
    const { store } = await loadStore();

    // Anything unusable is dropped, so search falls back to the catalog default for it.
    expect((await store.getSettings()).helpEmbeddingModels).toEqual({
      openai: 'text-embedding-3-large',
    });
  });

  it('reads a block that is not an object as no picks', async () => {
    userData.writeData('settings.json', { helpEmbeddingModels: ['bge-m3'] });
    const { store } = await loadStore();

    expect((await store.getSettings()).helpEmbeddingModels).toEqual({});
  });

  it('keeps a picked model through a save and reload', async () => {
    const { store } = await loadStore();

    await store.updateSettings((current) => ({
      ...current,
      helpEmbeddingModels: { ...current.helpEmbeddingModels, ollama: 'bge-m3' },
    }));

    expect((await store.getSettings()).helpEmbeddingModels).toEqual({ ollama: 'bge-m3' });
  });
});
