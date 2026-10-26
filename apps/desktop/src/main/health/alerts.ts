import type { AppNotification, HealthIncident, Project } from '@runova/core';
import { IPC } from '../../shared/ipcChannels';
import { appNotificationInbox } from '../deploy/watcher';
import { broadcastToWindows } from '../ipc/send';
import { type OsNotificationInput, showOsNotification } from '../notifications/osNotification';
import { store } from '../store';
import type { StoredHealthTarget } from './store';

/**
 * Tells the user when a healthcheck target is confirmed down or back up (E22): an OS notification
 * and an entry in the app's inbox, both opening the target on the Monitoring page. Only transitions
 * reach here, so a target that stays down is announced once, not on every probe.
 */

export interface HealthTransition {
  kind: 'opened' | 'resolved';
  target: StoredHealthTarget;
  project: Project;
  incident: HealthIncident;
}

export interface HealthAlertDeps {
  toast: (input: Pick<OsNotificationInput, 'title' | 'body' | 'route'>) => void;
  inbox: { add: (notification: AppNotification) => Promise<void> };
  now?: () => number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "5 min", "1 h 30 min", "1 day 2 h". */
function formatDowntime(ms: number): string {
  if (ms < MINUTE) return 'less than a minute';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms % HOUR) / MINUTE);
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.round((ms % DAY) / HOUR);
  return hours > 0 ? `${plural(days, 'day')} ${hours} h` : plural(days, 'day');
}

export function healthRoute(targetId: string): string {
  return `/monitoring?target=${encodeURIComponent(targetId)}`;
}

export function createHealthAlerts(deps: HealthAlertDeps) {
  const now = deps.now ?? Date.now;
  return async (transition: HealthTransition): Promise<void> => {
    const { target, project, incident } = transition;
    const down = transition.kind === 'opened';
    const title = down ? `${target.name} is down` : `${target.name} is back up`;
    const body = down
      ? `${project.name}: ${incident.summary}`
      : `${project.name}: back after ${formatDowntime((incident.resolvedAt ?? now()) - incident.openedAt)}`;
    const route = healthRoute(target.id);

    await deps.inbox.add({
      id: `health:${target.id}:${incident.id}:${down ? 'failure' : 'recovered'}`,
      kind: down ? 'health-failure' : 'health-recovered',
      title,
      body,
      projectId: project.id,
      projectName: project.name,
      htmlUrl: null,
      route,
      createdAt: new Date(now()).toISOString(),
      // Coming back is good news to look back on, not something to clear.
      read: !down,
    });
    deps.toast({ title, body, route });
  };
}

/** The app's own wiring: the OS notification and the inbox in app-notifications.json. */
export const announceHealthTransition = createHealthAlerts({
  toast: (input) => {
    showOsNotification(input);
  },
  inbox: appNotificationInbox({
    list: () => store.getAppNotifications(),
    save: (items) => store.setAppNotifications(items),
    changed: () => broadcastToWindows(IPC.appNotifications.onChanged),
  }),
});
