import type { AppSettings } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/defaultSettings';
import type { NewsNotifierDeps } from './notify';
import type { NewsServiceDeps } from './service';

/**
 * The news runtime against the settings (E42, T025): news off stops the poll schedule and on
 * starts it again, and the notifier and the list read the saved choices on every call, so a
 * change in Settings applies without a restart.
 */

const saved = vi.hoisted(() => ({ settings: {} as Partial<AppSettings> }));
const service = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  installedChanged: vi.fn(),
  deps: null as unknown,
}));
const notifier = vi.hoisted(() => ({ deps: null as unknown }));
const offDevSetup = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3', isPackaged: false } }));
vi.mock('../deploy/watcher', () => ({ appNotificationInbox: () => ({ add: vi.fn() }) }));
vi.mock('../devSetup/runtime', () => ({
  onDevSetupDetected: () => offDevSetup,
  peekDevSetup: () => ({}),
}));
vi.mock('../ipc/cliDetection', () => ({
  onClisDetected: () => vi.fn(),
  peekDetectedClis: () => [],
}));
vi.mock('../ipc/send', () => ({ broadcastToWindows: vi.fn() }));
vi.mock('../notifications/osNotification', () => ({ showOsNotification: vi.fn() }));
vi.mock('../store', () => ({
  store: {
    getSettings: async () => ({ ...DEFAULT_SETTINGS, ...saved.settings }),
    updateSettings: vi.fn(),
    getNewsCache: async () => null,
    setNewsCache: vi.fn(),
    getAppNotifications: async () => [],
    setAppNotifications: vi.fn(),
  },
}));
vi.mock('./notify', () => ({
  createNewsNotifier: (deps: unknown) => {
    notifier.deps = deps;
    return { notify: vi.fn() };
  },
}));
vi.mock('./service', () => ({
  createNewsService: (deps: unknown) => {
    service.deps = deps;
    return {
      start: service.start,
      stop: service.stop,
      installedChanged: service.installedChanged,
    };
  },
}));

async function loadRuntime() {
  vi.resetModules();
  return import('./runtime');
}

function settings(patch: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

beforeEach(() => {
  saved.settings = {};
  service.start.mockClear();
  service.stop.mockClear();
  offDevSetup.mockClear();
});

describe('news on and off', () => {
  it('starts polling at launch while news is on, the default', async () => {
    const runtime = await loadRuntime();
    await runtime.startNews();
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it('never starts polling at launch while news is off', async () => {
    saved.settings = { newsEnabled: false };
    const runtime = await loadRuntime();
    await runtime.startNews();
    expect(service.start).not.toHaveBeenCalled();
  });

  it('stops polling when news is turned off and starts again when it is turned back on', async () => {
    const runtime = await loadRuntime();
    await runtime.startNews();

    runtime.applyNewsSettings(settings({ newsEnabled: false }));
    expect(service.stop).toHaveBeenCalledTimes(1);
    // Detection changes no longer reach the news client either.
    expect(offDevSetup).toHaveBeenCalledTimes(1);

    runtime.applyNewsSettings(settings({ newsEnabled: true }));
    expect(service.start).toHaveBeenCalledTimes(2);
  });

  it('leaves news alone when it was never started, as in an e2e run without a fake API', async () => {
    const runtime = await loadRuntime();
    runtime.applyNewsSettings(settings({ newsEnabled: true }));
    expect(service.start).not.toHaveBeenCalled();
  });

  it('does not start again after quitting', async () => {
    const runtime = await loadRuntime();
    await runtime.startNews();
    runtime.stopNews();
    runtime.applyNewsSettings(settings({ newsEnabled: true }));
    expect(service.start).toHaveBeenCalledTimes(1);
  });
});

describe('what the notifier and the list read from settings', () => {
  it('notifies at the saved minimum severity, and at none while news is off', async () => {
    const runtime = await loadRuntime();
    runtime.getNewsService();
    const minSeverity = (notifier.deps as NewsNotifierDeps).minSeverity;
    expect(minSeverity).toBeDefined();

    expect(await minSeverity?.()).toBe('high');
    saved.settings = { newsNotifyMinSeverity: 'critical' };
    expect(await minSeverity?.()).toBe('critical');
    saved.settings = { newsNotifyMinSeverity: 'never' };
    expect(await minSeverity?.()).toBe('never');
    saved.settings = { newsEnabled: false, newsNotifyMinSeverity: 'low' };
    expect(await minSeverity?.()).toBe('never');
  });

  it('lists the categories picked in Settings', async () => {
    const runtime = await loadRuntime();
    runtime.getNewsService();
    const shownCategories = (service.deps as NewsServiceDeps).shownCategories;

    expect(await shownCategories?.()).toEqual([]);
    saved.settings = { newsCategories: ['security', 'release'] };
    expect(await shownCategories?.()).toEqual(['security', 'release']);
  });
});
