import type { AppNotification, UpdateCheckSource } from '@runova/core';
import { AGENT_TOOL_REGISTRY, CLI_REGISTRY } from '@runova/core';
import { IPC } from '../../shared/ipcChannels';
import { detectAllClis } from '../ipc/cliDetection';
import { broadcastToWindows } from '../ipc/send';
import { detectAllTools } from '../ipc/tools';
import { compareVersions, fetchLatestVersion, releaseUrl } from '../registryVersions';
import { store } from '../store';
import { isCheckDue } from './schedule';

/** Hourly poll so a long-suspended laptop still catches up soon after waking; the daily
 * gate below is what actually decides whether a poll does anything. */
const POLL_MS = 60 * 60 * 1000;
const MAX_NOTIFICATIONS = 200;

let timer: NodeJS.Timeout | null = null;
let checking = false;

interface UpdatableEntry {
  id: string;
  name: string;
  updateCheck?: UpdateCheckSource;
}

function broadcastNotificationsChanged(): void {
  broadcastToWindows(IPC.appNotifications.onChanged);
}

async function appendUpdateNotification(
  entry: UpdatableEntry,
  currentVersion: string,
  latestVersion: string,
): Promise<boolean> {
  const items = await store.getAppNotifications();
  // Keyed on the version being announced, so the same release only ever notifies once,
  // and a later release for the same tool notifies again.
  const id = `tool-update:${entry.id}:${latestVersion}`;
  if (items.some((item) => item.id === id)) return false;
  const notification: AppNotification = {
    id,
    kind: 'tool-update-available',
    title: `${entry.name} update available`,
    body: `${currentVersion} → ${latestVersion}`,
    projectId: null,
    projectName: entry.name,
    htmlUrl: entry.updateCheck ? releaseUrl(entry.updateCheck) : null,
    createdAt: new Date().toISOString(),
    read: false,
  };
  items.unshift(notification);
  await store.setAppNotifications(items.slice(0, MAX_NOTIFICATIONS));
  return true;
}

async function checkEntryForUpdate(
  entry: UpdatableEntry,
  installedVersion: string | null,
): Promise<void> {
  if (!entry.updateCheck || !installedVersion) return;
  const latestVersion = await fetchLatestVersion(entry.updateCheck);
  if (!latestVersion) return;
  if (compareVersions(latestVersion, installedVersion) <= 0) return;
  const added = await appendUpdateNotification(entry, installedVersion, latestVersion);
  if (added) broadcastNotificationsChanged();
}

/** Runs the due-check, and the update sweep itself when it is actually due. Exported (rather
 * than only wired to the interval) so it can be driven directly, both by tests and by a
 * possible future "check now" trigger. */
export async function runToolUpdateCheck(now: Date = new Date()): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const settings = await store.getSettings();
    if (!settings.checkToolUpdatesEnabled) return;

    const watch = await store.getToolUpdateWatch();
    if (!isCheckDue(watch.lastCheckedAt, now)) return;

    const [clis, tools] = await Promise.all([detectAllClis(false), detectAllTools()]);
    const installedVersion = new Map<string, string | null>();
    for (const cli of clis) installedVersion.set(cli.id, cli.version);
    for (const tool of tools) installedVersion.set(tool.id, tool.version);

    for (const entry of [...CLI_REGISTRY, ...AGENT_TOOL_REGISTRY]) {
      await checkEntryForUpdate(entry, installedVersion.get(entry.id) ?? null);
    }

    await store.setToolUpdateWatch({ lastCheckedAt: now.toISOString() });
  } finally {
    checking = false;
  }
}

export function startToolUpdateWatcher(): void {
  if (timer) return;
  timer = setInterval(() => void runToolUpdateCheck(), POLL_MS);
  void runToolUpdateCheck();
}

export function stopToolUpdateWatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
