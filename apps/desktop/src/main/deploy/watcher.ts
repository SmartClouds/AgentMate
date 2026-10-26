import type { AppNotification } from '@runova/core';
import type {
  AlertInfo,
  AlertSeverity,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { CoreLinks } from './live/coreLinks';
import { AlertsFeed } from './live/feeds';
import type { DeployState } from './state';

/**
 * Turns every enrolled server's alerts into inbox entries (the `deploy-*` kinds) and, while the
 * app is in the background, OS toasts (E05 T9). Each server gets an alerts stream of its own on
 * its lasting connection, starting after the last revision handled, which is saved before
 * anything is announced: a restart repeats nothing, and a crash costs an announcement rather
 * than repeating them all. An alert that only moves on (one more percent of disk) stays quiet,
 * one that gets worse is announced again, and one resolved or acknowledged (here or on another
 * computer) has its entries marked read.
 */

const MAX_NOTIFICATIONS = 200;

export interface NotificationInbox {
  add: (notification: AppNotification) => Promise<void>;
  /** Marks read every entry whose id starts with `prefix`. */
  markRead: (prefix: string) => Promise<void>;
}

export interface AlertWatcherDeps {
  links: Pick<CoreLinks, 'attachAlerts'>;
  state: Pick<DeployState, 'alertMark' | 'setAlertMark'>;
  /** The servers to watch: a core installed and this computer enrolled on it. */
  servers: () => Promise<Array<{ id: string; name: string }>>;
  inbox: NotificationInbox;
  toast: (toast: { title: string; body: string; route: string }) => void;
  /** Whether the app's window has focus; its in-app message covers the alert then. */
  focused: () => boolean;
  now?: () => number;
}

interface Watched {
  name: string;
  detach: () => void;
}

function rank(severity: AlertSeverity): number {
  return severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0;
}

function titleOf(alert: AlertInfo, server: string): string {
  switch (alert.kind) {
    case 'diskPressure':
      return alert.severity === 'critical'
        ? `A disk is nearly full on ${server}`
        : `A disk is filling up on ${server}`;
    case 'jobFailed':
      return `A job failed on ${server}`;
    case 'rebootRequired':
      return `${server} needs a reboot`;
    case 'certificateRenewalFailed':
      return `A certificate did not renew on ${server}`;
    case 'firewallRolledBack':
      return `A firewall change was rolled back on ${server}`;
    case 'firewallRollbackFailed':
      return `A firewall change could not be rolled back on ${server}`;
    case 'originLockRefreshFailed':
      return `The Cloudflare lock could not be refreshed on ${server}`;
    case 'backupFailed':
      return `A backup failed on ${server}`;
    case 'containerCrashLoop':
      return `A container keeps restarting on ${server}`;
    default:
      return `Alert on ${server}`;
  }
}

/** Where an alert's inbox entries start, whatever revision announced them. */
function entryPrefix(serverId: string, alertId: number): string {
  return `deploy-alert:${serverId}:${alertId}:`;
}

export class DeployAlertWatcher {
  private readonly watched = new Map<string, Watched>();
  private syncing: Promise<void> = Promise.resolve();
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: AlertWatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Watches the servers there are now: new ones start, ones that went away stop. */
  sync(): Promise<void> {
    this.stopped = false;
    const next = this.syncing.then(() => this.syncOnce());
    this.syncing = next.catch(() => undefined);
    return next;
  }

  stop(): void {
    this.stopped = true;
    for (const watched of this.watched.values()) watched.detach();
    this.watched.clear();
  }

  private async syncOnce(): Promise<void> {
    const wanted = new Map((await this.deps.servers()).map((server) => [server.id, server.name]));
    for (const [serverId, watched] of [...this.watched]) {
      const name = wanted.get(serverId);
      if (name === undefined) {
        watched.detach();
        this.watched.delete(serverId);
      } else {
        watched.name = name;
      }
    }
    for (const [serverId, name] of wanted) {
      if (this.watched.has(serverId)) continue;
      const mark = await this.deps.state.alertMark(serverId);
      if (this.stopped) return;
      const feed = new AlertsFeed(mark ? { afterRevision: mark.revision } : {});
      feed.listen((alert) => this.enqueue(serverId, alert));
      this.watched.set(serverId, { name, detach: this.deps.links.attachAlerts(serverId, feed) });
    }
  }

  private enqueue(serverId: string, alert: AlertInfo): void {
    // One at a time, so marks and the inbox are read and written in order.
    this.chain = this.chain.then(() => this.handle(serverId, alert)).catch(() => undefined);
  }

  private async handle(serverId: string, alert: AlertInfo): Promise<void> {
    const mark = (await this.deps.state.alertMark(serverId)) ?? { revision: 0, open: {} };
    if (alert.revision <= mark.revision) return;
    const key = String(alert.id);
    const known = mark.open[key];
    const open = { ...mark.open };
    let announce = false;
    let settled = false;
    if (alert.resolvedAtUnixMs) {
      delete open[key];
      settled = true;
    } else {
      open[key] = alert.severity;
      if (alert.acknowledgedAtUnixMs) settled = true;
      else announce = known === undefined || rank(alert.severity) > rank(known);
    }
    await this.deps.state.setAlertMark(serverId, { revision: alert.revision, open });
    if (settled && known !== undefined) {
      await this.deps.inbox.markRead(entryPrefix(serverId, alert.id));
    }
    if (announce) await this.announce(serverId, alert);
  }

  private async announce(serverId: string, alert: AlertInfo): Promise<void> {
    const name = this.watched.get(serverId)?.name ?? serverId;
    const title = titleOf(alert, name);
    const route = `/deploy?server=${encodeURIComponent(serverId)}`;
    await this.deps.inbox.add({
      id: `${entryPrefix(serverId, alert.id)}${alert.revision}`,
      kind: `deploy-${alert.severity}`,
      title,
      body: alert.message,
      projectId: null,
      projectName: name,
      htmlUrl: null,
      route,
      createdAt: new Date(this.now()).toISOString(),
      read: false,
    });
    if (alert.severity !== 'info' && !this.deps.focused()) {
      this.deps.toast({ title, body: alert.message, route });
    }
  }
}

/** The app's notification inbox as the watcher uses it, over the store that keeps it. */
export function appNotificationInbox(port: {
  list: () => Promise<AppNotification[]>;
  save: (items: AppNotification[]) => Promise<void>;
  /** Tells the windows the inbox changed. */
  changed: () => void;
}): NotificationInbox {
  return {
    add: async (notification) => {
      const items = await port.list();
      if (items.some((item) => item.id === notification.id)) return;
      await port.save([notification, ...items].slice(0, MAX_NOTIFICATIONS));
      port.changed();
    },
    markRead: async (prefix) => {
      const items = await port.list();
      let changed = false;
      const next = items.map((item) => {
        if (item.read || !item.id.startsWith(prefix)) return item;
        changed = true;
        return { ...item, read: true };
      });
      if (!changed) return;
      await port.save(next);
      port.changed();
    },
  };
}
