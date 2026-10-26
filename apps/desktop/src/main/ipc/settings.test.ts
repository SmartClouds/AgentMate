import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppSettings, buildAgentLaunchCommand } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';

/**
 * settings.json on disk, through the main store and the settings IPC handler, to the command a
 * new Claude Code tab types. Only Electron and the modules with native or window side effects are
 * stubbed; the file reads, writes, and migrations are the real ones.
 */

const userData = { dir: '' };
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
/** Hoisted, so every fresh copy of the module graph after `vi.resetModules()` sees this one. */
const nativeTheme = vi.hoisted(() => ({ themeSource: 'system', shouldUseDarkColors: true }));

vi.mock('electron', () => ({
  app: { getPath: () => userData.dir },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
  nativeTheme,
}));
vi.mock('../blueprintFileStore', () => ({
  referencedAttachmentFiles: () => new Set(),
  removeOrphanAttachments: async () => undefined,
}));
vi.mock('../blueprintRevisionDb', () => ({ blueprintRevisionDb: {} }));
vi.mock('../projectIconStore', () => ({
  hydrateProjectIcons: async (projects: unknown) => projects,
  persistProjectIcons: async (projects: unknown) => projects,
}));
vi.mock('../grammar/languageToolClient', () => ({ clearGrammarCache: vi.fn() }));
vi.mock('../grammar/localServer', () => ({ stopLocalServer: vi.fn() }));
vi.mock('../network/proxy', () => ({ applyProxySettings: vi.fn() }));
vi.mock('../pet/petWindow', () => ({ petManager: { syncFromSettings: vi.fn() } }));

const dataFile = (name: string): string => join(userData.dir, 'data', name);

async function writeData(name: string, value: unknown): Promise<void> {
  await mkdir(join(userData.dir, 'data'), { recursive: true });
  await writeFile(dataFile(name), JSON.stringify(value), 'utf-8');
}

async function readSettingsFile(): Promise<Partial<AppSettings>> {
  return JSON.parse(await readFile(dataFile('settings.json'), 'utf-8'));
}

async function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return (await handler({}, ...args)) as T;
}

/** The command a new Claude Code tab would type with these settings. */
function claudeCommand(settings: AppSettings): string | null {
  return buildAgentLaunchCommand({
    cliId: 'claude-code',
    shellKind: 'powershell',
    launchDefaults: settings.cliLaunchDefaults['claude-code'],
  });
}

beforeEach(async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'runova-settings-'));
  handlers.clear();
  nativeTheme.themeSource = 'system';
  vi.resetModules();
  const { registerSettingsHandlers } = await import('./settings');
  registerSettingsHandlers();
});

afterEach(async () => {
  await rm(userData.dir, { recursive: true, force: true });
});

describe('settings to launch command', () => {
  it('starts Claude Code bare on a fresh install', async () => {
    const settings = await ipc<AppSettings>(IPC.settings.get);
    expect(settings.cliArgs).toEqual({});
    expect(settings.cliLaunchDefaults).toEqual({});
    expect(claudeCommand(settings)).toBe('claude');
  });

  it('never lets a --model from the Arguments box reach a new tab', async () => {
    // The shape found in the affected release install. Those arguments are for background tasks.
    await writeData('settings.json', {
      defaultCliId: 'claude-code',
      cliArgs: { 'claude-code': '--model haiku' },
      cliLaunchDefaults: { 'claude-code': { mode: 'auto' } },
    });
    const settings = await ipc<AppSettings>(IPC.settings.get);
    expect(settings.cliArgs).toEqual({ 'claude-code': '--model haiku' });
    expect(claudeCommand(settings)).toBe('claude --permission-mode auto');
  });

  it('never turns the last model a CLI ran on into a launch flag', async () => {
    await writeData('last-run-info.json', {
      'claude-code': { model: 'claude-haiku-4-5', effort: 'low' },
    });
    const settings = await ipc<AppSettings>(IPC.settings.get);
    expect(claudeCommand(settings)).toBe('claude');

    await ipc(IPC.settings.update, { theme: 'dark' });
    const onDisk = await readSettingsFile();
    expect(onDisk.cliArgs).toEqual({});
    expect(onDisk.cliLaunchDefaults).toEqual({});
  });

  it('drops junk from a hand-edited file instead of sending it', async () => {
    await writeData('settings.json', {
      cliArgs: { 'claude-code': '   ', 'codex-cli': 42 },
      cliLaunchDefaults: {
        'claude-code': { model: '  ', effort: 'turbo', mode: '' },
        'gemini-cli': 'yolo',
      },
    });
    const settings = await ipc<AppSettings>(IPC.settings.get);
    expect(settings.cliArgs).toEqual({});
    expect(settings.cliLaunchDefaults).toEqual({});
    expect(claudeCommand(settings)).toBe('claude');
  });

  it('keeps a launch default model the user did pick', async () => {
    await ipc(IPC.settings.update, {
      cliLaunchDefaults: { 'claude-code': { model: 'opus', effort: 'high' } },
    });
    const settings = await ipc<AppSettings>(IPC.settings.get);
    expect(claudeCommand(settings)).toBe('claude --model opus --effort high');
  });
});

describe('checkToolUpdatesEnabled', () => {
  it('defaults to on for a fresh install', async () => {
    const settings = await ipc<AppSettings>(IPC.settings.get);
    expect(settings.checkToolUpdatesEnabled).toBe(true);
  });

  it('stays on when a pre-existing settings file predates the flag', async () => {
    await writeData('settings.json', { theme: 'dark' });
    const settings = await ipc<AppSettings>(IPC.settings.get);
    expect(settings.checkToolUpdatesEnabled).toBe(true);
  });

  it('persists turning it off, and back on', async () => {
    const off = await ipc<AppSettings>(IPC.settings.update, { checkToolUpdatesEnabled: false });
    expect(off.checkToolUpdatesEnabled).toBe(false);
    expect((await readSettingsFile()).checkToolUpdatesEnabled).toBe(false);

    const on = await ipc<AppSettings>(IPC.settings.update, { checkToolUpdatesEnabled: true });
    expect(on.checkToolUpdatesEnabled).toBe(true);
    expect((await readSettingsFile()).checkToolUpdatesEnabled).toBe(true);
  });
});

describe('statusBarUsage', () => {
  it('shows every provider on a fresh install', async () => {
    const settings = await ipc<AppSettings>(IPC.settings.get);
    expect(settings.statusBarUsage).toEqual({ 'claude-code': true, codex: true, cursor: true });
  });

  it('persists hiding one provider without touching the others', async () => {
    const next = await ipc<AppSettings>(IPC.settings.update, {
      statusBarUsage: { 'claude-code': true, codex: false, cursor: true },
    });
    expect(next.statusBarUsage.codex).toBe(false);
    expect(next.statusBarUsage['claude-code']).toBe(true);
    expect((await readSettingsFile()).statusBarUsage).toEqual({
      'claude-code': true,
      codex: false,
      cursor: true,
    });
  });
});

describe('startupPage', () => {
  it('persists a picked page, and going back to the last page', async () => {
    const dashboard = await ipc<AppSettings>(IPC.settings.update, { startupPage: '/' });
    expect(dashboard.startupPage).toBe('/');
    expect((await readSettingsFile()).startupPage).toBe('/');

    const last = await ipc<AppSettings>(IPC.settings.update, { startupPage: 'last' });
    expect(last.startupPage).toBe('last');
    expect((await readSettingsFile()).startupPage).toBe('last');
  });
});

describe('theme', () => {
  it('retints the window when the theme changes', async () => {
    await ipc(IPC.settings.update, { theme: 'light' });
    expect(nativeTheme.themeSource).toBe('light');

    await ipc(IPC.settings.update, { theme: 'vs2026' });
    expect(nativeTheme.themeSource).toBe('dark');

    await ipc(IPC.settings.update, { theme: 'system' });
    expect(nativeTheme.themeSource).toBe('system');
  });

  it('leaves the window alone when something else changes', async () => {
    nativeTheme.themeSource = 'light';
    await ipc(IPC.settings.update, { startupPage: '/' });
    expect(nativeTheme.themeSource).toBe('light');
  });
});

describe('updates made at the same time', () => {
  it('keeps every one of them', async () => {
    // Each update reads the file, merges, and writes it back. Run side by side without a queue,
    // a later read could miss an earlier write and put the old value back.
    await Promise.all([
      ipc<AppSettings>(IPC.settings.update, { theme: 'dark' }),
      ipc<AppSettings>(IPC.settings.update, { startupPage: '/' }),
      ipc<AppSettings>(IPC.settings.update, { checkToolUpdatesEnabled: false }),
      ipc<AppSettings>(IPC.settings.update, { keepAwake: 'off' }),
    ]);

    expect(await readSettingsFile()).toMatchObject({
      theme: 'dark',
      startupPage: '/',
      checkToolUpdatesEnabled: false,
      keepAwake: 'off',
    });
  });
});
