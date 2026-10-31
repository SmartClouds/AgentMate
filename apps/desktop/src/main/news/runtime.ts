import type { NewsLocalState } from '@runova/core';
import { app } from 'electron';
import { IPC } from '../../shared/ipcChannels';
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
 * notification, and the detections Dev Setup and CLI Manager already remember.
 */

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
  });
}

let service: NewsService | null = null;
let unsubscribe: (() => void)[] = [];

export function getNewsService(): NewsService {
  service ??= createService();
  return service;
}

/** Starts polling, and re-matching whenever Dev Setup or CLI Manager detects something. */
export function startNews(): void {
  const news = getNewsService();
  if (unsubscribe.length === 0) {
    const changed = () => news.installedChanged();
    unsubscribe = [onDevSetupDetected(changed), onClisDetected(changed)];
  }
  news.start();
}

/** Stops polling on quit. Does nothing when news never started. */
export function stopNews(): void {
  for (const off of unsubscribe) off();
  unsubscribe = [];
  service?.stop();
}
