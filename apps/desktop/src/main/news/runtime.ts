import type { AppSettings, NewsLocalState } from '@runova/core';
import { app } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { newsSettingsOf, notifyThreshold } from '../../shared/newsSettings';
import { appNotificationInbox } from '../deploy/watcher';
import { onDevSetupDetected, peekDevSetup } from '../devSetup/runtime';
import { onClisDetected, peekDetectedClis } from '../ipc/cliDetection';
import { broadcastToWindows } from '../ipc/send';
import { showOsNotification } from '../notifications/osNotification';
import { store } from '../store';
import { createNewsClient, newsApiBaseUrl, newsUserAgent } from './client';
import { DEV_SETUP_NEWS_ITEMS, installedTools } from './installed';
import { createNewsNotifier } from './notify';
import { createNewsService, type NewsService } from './service';
import { normalizeNewsState } from './state';

/**
 * Binds the news service (E42) to the real app: the proxy-aware fetch that `installProxyFetch()`
 * puts on globalThis, news-cache.json, `newsState` in settings.json, the inbox and the OS
 * notification, and the detections Dev Setup and CLI Manager already remember. The news choices
 * in Settings are read on every call, and turning news off stops the poll schedule (T025).
 */

async function newsSettings() {
  return newsSettingsOf(await store.getSettings());
}

async function getState(): Promise<NewsLocalState> {
  return normalizeNewsState((await store.getSettings()).newsState);
}

async function updateState(update: (state: NewsLocalState) => NewsLocalState): Promise<void> {
  await store.updateSettings((settings) => ({
    ...settings,
    newsState: update(normalizeNewsState(settings.newsState)),
  }));
}

function createService(): NewsService {
  const version = app.getVersion();
  const client = createNewsClient({
    // Looked up on each call, so the proxy-aware fetch is used even if it is installed later.
    fetch: (input, init) => globalThis.fetch(input, init),
    baseUrl: newsApiBaseUrl({ isPackaged: app.isPackaged, env: process.env }),
    userAgent: newsUserAgent(version, process.platform),
    readCache: () => store.getNewsCache(),
    writeCache: (cache) => store.setNewsCache(cache),
  });
  const notifier = createNewsNotifier({
    inbox: appNotificationInbox({
      list: () => store.getAppNotifications(),
      save: (items) => store.setAppNotifications(items),
      changed: () => broadcastToWindows(IPC.appNotifications.onChanged),
    }),
    toast: (input) => {
      showOsNotification(input);
    },
    getState,
    updateState,
    minSeverity: async () => notifyThreshold(await newsSettings()),
  });
  return createNewsService({
    client,
    getState,
    updateState,
    installed: () =>
      installedTools({
        appVersion: version,
        electronVersion: process.versions.electron ?? '',
        nodeVersion: process.versions.node,
        devSetup: peekDevSetup(DEV_SETUP_NEWS_ITEMS),
        clis: peekDetectedClis(),
      }),
    notifier,
    broadcast: (event) => broadcastToWindows(IPC.news.onChanged, event),
    shownCategories: async () => (await newsSettings()).categories,
  });
}

let service: NewsService | null = null;
let unsubscribe: (() => void)[] = [];
/** Set once the app has asked for news at all; an e2e run with no fake API never does. */
let started = false;

export function getNewsService(): NewsService {
  service ??= createService();
  return service;
}

function resume(): void {
  const news = getNewsService();
  if (unsubscribe.length === 0) {
    const changed = () => news.installedChanged();
    unsubscribe = [onDevSetupDetected(changed), onClisDetected(changed)];
  }
  news.start();
}

function pause(): void {
  for (const off of unsubscribe) off();
  unsubscribe = [];
  service?.stop();
}

/**
 * Starts polling, and re-matching whenever Dev Setup or CLI Manager detects something, unless
 * news is turned off in Settings.
 */
export async function startNews(): Promise<void> {
  started = true;
  applyNewsSettings(await store.getSettings());
}

/** Follows Show news after a change in Settings or a restore. */
export function applyNewsSettings(settings: AppSettings): void {
  if (!started) return;
  if (newsSettingsOf(settings).enabled) resume();
  else pause();
}

/** Stops polling on quit. Does nothing when news never started. */
export function stopNews(): void {
  started = false;
  pause();
}
