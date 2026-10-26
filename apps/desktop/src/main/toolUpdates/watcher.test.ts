import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppNotification } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings on disk, through the daily due-check, to a notification landing in the app's
 * inbox. Only Electron and the CLI/tool probing (which spawns real processes) and the
 * network lookup are stubbed; the store reads/writes and the registries are real.
 */

const userData = { dir: '' };
const sentBroadcasts: string[] = [];

vi.mock('electron', () => ({
  app: { getPath: () => userData.dir },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string) => sentBroadcasts.push(channel),
        },
      },
    ],
  },
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

const fakeCli = {
  id: 'fake-cli',
  name: 'Fake CLI',
  updateCheck: { type: 'npm', package: 'fake-cli' },
};
const fakeTool = {
  id: 'fake-tool',
  name: 'Fake Tool',
  updateCheck: { type: 'npm', package: 'fake-tool' },
};
const fakeToolNoSource = { id: 'no-source-tool', name: 'No Source Tool' };

vi.mock('@runova/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@runova/core')>();
  return {
    ...actual,
    CLI_REGISTRY: [fakeCli],
    AGENT_TOOL_REGISTRY: [fakeTool, fakeToolNoSource],
  };
});

const detect = vi.hoisted(() => ({
  detectAllClis: vi.fn(),
  detectAllTools: vi.fn(),
}));
vi.mock('../ipc/cliDetection', () => ({ detectAllClis: detect.detectAllClis }));
vi.mock('../ipc/tools', () => ({ detectAllTools: detect.detectAllTools }));

const versions = vi.hoisted(() => ({ fetchLatestVersion: vi.fn() }));
vi.mock('../registryVersions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registryVersions')>();
  return { ...actual, fetchLatestVersion: versions.fetchLatestVersion };
});

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(userData.dir, 'data', name), 'utf-8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

let runToolUpdateCheck: (now?: Date) => Promise<void>;

beforeEach(async () => {
  userData.dir = await mkdtemp(join(tmpdir(), 'runova-tool-updates-'));
  sentBroadcasts.length = 0;
  vi.clearAllMocks();
  detect.detectAllClis.mockResolvedValue([{ id: 'fake-cli', version: '1.0.0', installed: true }]);
  detect.detectAllTools.mockResolvedValue([
    { id: 'fake-tool', version: '2.0.0', installed: true },
    { id: 'no-source-tool', version: '1.0.0', installed: true },
  ]);
  versions.fetchLatestVersion.mockResolvedValue(null);
  vi.resetModules();
  ({ runToolUpdateCheck } = await import('./watcher'));
});

afterEach(async () => {
  await rm(userData.dir, { recursive: true, force: true });
});

async function writeSettings(overrides: Record<string, unknown>): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(userData.dir, 'data'), { recursive: true });
  await writeFile(join(userData.dir, 'data', 'settings.json'), JSON.stringify(overrides), 'utf-8');
}

describe('runToolUpdateCheck', () => {
  it('does nothing when the feature is disabled in settings', async () => {
    await writeSettings({ checkToolUpdatesEnabled: false });
    await runToolUpdateCheck(new Date('2026-09-17T12:00:00Z'));
    expect(detect.detectAllClis).not.toHaveBeenCalled();
    expect(detect.detectAllTools).not.toHaveBeenCalled();
  });

  it('appends a notification and broadcasts when a newer version is published', async () => {
    versions.fetchLatestVersion.mockImplementation(async (source: { package: string }) =>
      source.package === 'fake-tool' ? '3.0.0' : null,
    );
    await runToolUpdateCheck(new Date('2026-09-17T12:00:00Z'));

    const notifications = await readJson<AppNotification[]>('app-notifications.json', []);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: 'tool-update-available',
      title: 'Fake Tool update available',
      body: '2.0.0 → 3.0.0',
      htmlUrl: 'https://www.npmjs.com/package/fake-tool',
      read: false,
    });
    expect(sentBroadcasts).toEqual(['appNotifications:onChanged']);
  });

  it('skips entries with no update source and entries with no updates available', async () => {
    versions.fetchLatestVersion.mockResolvedValue('1.0.0'); // never newer than installed
    await runToolUpdateCheck(new Date('2026-09-17T12:00:00Z'));

    const notifications = await readJson<AppNotification[]>('app-notifications.json', []);
    expect(notifications).toHaveLength(0);
  });

  it('does not duplicate a notification already recorded for the same version', async () => {
    versions.fetchLatestVersion.mockImplementation(async (source: { package: string }) =>
      source.package === 'fake-tool' ? '3.0.0' : null,
    );
    await runToolUpdateCheck(new Date('2026-09-17T12:00:00Z'));
    sentBroadcasts.length = 0;

    // Second run past the interval sees the same latest version again.
    await runToolUpdateCheck(new Date('2026-09-19T12:00:00Z'));

    const notifications = await readJson<AppNotification[]>('app-notifications.json', []);
    expect(notifications).toHaveLength(1);
    expect(sentBroadcasts).toEqual([]);
  });

  it('records lastCheckedAt so a second run inside the interval is a no-op', async () => {
    const first = new Date('2026-09-17T12:00:00Z');
    await runToolUpdateCheck(first);
    expect(detect.detectAllClis).toHaveBeenCalledTimes(1);

    await runToolUpdateCheck(new Date('2026-09-17T13:00:00Z'));
    expect(detect.detectAllClis).toHaveBeenCalledTimes(1);

    const watch = await readJson<{ lastCheckedAt: string | null }>('tool-update-watch.json', {
      lastCheckedAt: null,
    });
    expect(watch.lastCheckedAt).toBe(first.toISOString());
  });
});
