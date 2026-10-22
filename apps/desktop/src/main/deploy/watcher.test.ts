import type { AppNotification } from '@agentmat/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '../../shared/deploy/testing/fakeCore';
import { CoreLinks } from './live/coreLinks';
import { DeployState } from './state';
import { fakeLiveHubs } from './testing/fakeLiveHub';
import { appNotificationInbox, DeployAlertWatcher } from './watcher';

/**
 * Alerts from every enrolled server become inbox entries and, while the app is in the
 * background, OS toasts: once each, a restart included. An alert that only moves on (one more
 * percent of disk) stays quiet; one that gets worse speaks up again; one that is resolved or
 * acknowledged takes its entry off the unread count.
 */

let links: CoreLinks | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  links?.closeAll();
  links = null;
  vi.useRealTimers();
});

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function memoryState() {
  let content: unknown = null;
  return new DeployState({
    read: async () => content,
    write: async (value) => {
      content = JSON.parse(JSON.stringify(value));
    },
  });
}

function setup(options: { state?: DeployState; core?: FakeCore; focused?: boolean } = {}) {
  const core = options.core ?? new FakeCore(() => Date.now());
  const hubs = fakeLiveHubs(core);
  links?.closeAll();
  links = new CoreLinks({ open: () => hubs.open() });
  const state = options.state ?? memoryState();
  const inbox: AppNotification[] = [];
  const toasts: Array<{ title: string; body: string; route: string }> = [];
  let servers = [{ id: 'srv-1', name: 'Production' }];
  const watcher = new DeployAlertWatcher({
    links,
    state,
    servers: async () => servers,
    inbox: appNotificationInbox({
      list: async () => inbox.map((item) => ({ ...item })),
      save: async (items) => {
        inbox.splice(0, inbox.length, ...items);
      },
      changed: () => undefined,
    }),
    toast: (toast) => toasts.push(toast),
    focused: () => options.focused ?? false,
  });
  return {
    core,
    hubs,
    state,
    inbox,
    toasts,
    watcher,
    setServers: (next: typeof servers) => {
      servers = next;
    },
  };
}

describe('DeployAlertWatcher', () => {
  it('announces an open alert it has not seen, in the inbox and as a toast', async () => {
    const { core, inbox, toasts, watcher } = setup();
    core.raise('diskPressure', '/', 'warning', '/ is 91% full: 7 GB of 80 GB left.');

    await watcher.sync();
    await settle();

    expect(inbox).toEqual([
      expect.objectContaining({
        id: 'deploy-alert:srv-1:1:1',
        kind: 'deploy-warning',
        title: 'A disk is filling up on Production',
        body: '/ is 91% full: 7 GB of 80 GB left.',
        projectName: 'Production',
        route: '/deploy?server=srv-1',
        read: false,
      }),
    ]);
    expect(toasts).toEqual([
      {
        title: 'A disk is filling up on Production',
        body: '/ is 91% full: 7 GB of 80 GB left.',
        route: '/deploy?server=srv-1',
      },
    ]);
  });

  it('puts a failed certificate renewal in the inbox (E11 AC3)', async () => {
    const { core, inbox, toasts, watcher } = setup();
    core.raise(
      'certificateRenewalFailed',
      'shop.example.com',
      'critical',
      'Renewing the certificate for shop.example.com failed 3 times: port 80 did not answer.',
    );

    await watcher.sync();
    await settle();

    expect(inbox).toEqual([
      expect.objectContaining({
        title: 'A certificate did not renew on Production',
        body: 'Renewing the certificate for shop.example.com failed 3 times: port 80 did not answer.',
        route: '/deploy?server=srv-1',
        read: false,
      }),
    ]);
    expect(toasts).toHaveLength(1);
  });

  it('names failed backups and crash loops in the inbox (E30)', async () => {
    const { core, inbox, watcher } = setup();
    core.raise(
      'backupFailed',
      'backup-plan:1',
      'critical',
      'Nightly: the archive could not be built.',
    );
    core.raise('containerCrashLoop', 'shop-api-1', 'critical', 'shop-api-1 keeps restarting.');

    await watcher.sync();
    await settle();

    expect(inbox.map((entry) => entry.title).sort()).toEqual([
      'A backup failed on Production',
      'A container keeps restarting on Production',
    ]);
  });

  it('names the firewall and Cloudflare alerts in the inbox', async () => {
    const { core, inbox, watcher } = setup();
    core.raise('firewallRolledBack', 'change-7', 'warning', 'Nobody kept change 7.');
    core.raise('firewallRollbackFailed', 'change-8', 'critical', 'Change 8 could not be undone.');
    core.raise('originLockRefreshFailed', 'cloudflare', 'warning', 'The ranges did not load.');

    await watcher.sync();
    await settle();

    expect(inbox.map((entry) => entry.title).sort()).toEqual([
      'A firewall change could not be rolled back on Production',
      'A firewall change was rolled back on Production',
      'The Cloudflare lock could not be refreshed on Production',
    ]);
  });

  it('leaves the toast to the app while its window has focus', async () => {
    const { core, inbox, toasts, watcher } = setup({ focused: true });
    await watcher.sync();
    await settle();

    core.raise('rebootRequired', 'system', 'warning', 'A reboot is needed.');
    await settle();

    expect(inbox.map((item) => item.title)).toEqual(['Production needs a reboot']);
    expect(toasts).toEqual([]);
  });

  it('repeats nothing after a restart, and still hears what comes next', async () => {
    const first = setup();
    first.core.raise('jobFailed', 'packagesUpgrade', 'warning', 'Upgrade all packages failed.');
    await first.watcher.sync();
    await settle();
    first.watcher.stop();

    const again = setup({ state: first.state, core: first.core });
    await again.watcher.sync();
    await settle();
    again.core.raise('diskPressure', '/', 'critical', '/ is 97% full.');
    await settle();

    expect(first.inbox.map((item) => item.title)).toEqual(['A job failed on Production']);
    expect(again.inbox.map((item) => item.title)).toEqual(['A disk is nearly full on Production']);
    expect(again.hubs.latest()?.requested).toEqual([
      { kind: 'alerts', args: [{ afterRevision: 1 }] },
    ]);
  });

  it('stays quiet while an alert only moves on, and speaks up when it gets worse', async () => {
    const { core, inbox, toasts, watcher } = setup();
    await watcher.sync();
    await settle();

    core.raise('diskPressure', '/', 'warning', '/ is 91% full.');
    core.raise('diskPressure', '/', 'warning', '/ is 92% full.');
    core.raise('diskPressure', '/', 'warning', '/ is 93% full.');
    await settle();
    core.raise('diskPressure', '/', 'critical', '/ is 96% full.');
    await settle();

    expect(inbox.map((item) => [item.id, item.kind])).toEqual([
      ['deploy-alert:srv-1:1:4', 'deploy-critical'],
      ['deploy-alert:srv-1:1:1', 'deploy-warning'],
    ]);
    expect(toasts).toHaveLength(2);
  });

  it('takes an alert off the unread count once it is resolved or acknowledged', async () => {
    const { core, inbox, watcher } = setup();
    await watcher.sync();
    await settle();
    core.raise('diskPressure', '/', 'warning', '/ is 91% full.');
    core.raise('rebootRequired', 'system', 'warning', 'A reboot is needed.');
    await settle();

    core.resolve(1);
    core.acknowledge(2);
    await settle();

    expect(inbox.map((item) => item.read)).toEqual([true, true]);
  });

  it('keeps an acknowledged or informational alert out of the toasts', async () => {
    const { core, inbox, toasts, watcher } = setup();
    const quietOne = core.raise('diskPressure', '/data', 'warning', '/data is 90% full.');
    core.acknowledge(quietOne.id);
    await watcher.sync();
    await settle();

    core.raise('rebootRequired', 'system', 'info', 'A reboot would finish an update.');
    await settle();

    expect(inbox.map((item) => [item.kind, item.read])).toEqual([['deploy-info', false]]);
    expect(toasts).toEqual([]);
  });

  it('stops watching a server that is no longer enrolled, and names an alert it does not know', async () => {
    const { core, hubs, inbox, setServers, watcher } = setup();
    await watcher.sync();
    await settle();
    core.raise('somethingNew' as never, 'x', 'warning', 'Something new happened.');
    await settle();
    expect(inbox[0].title).toBe('Alert on Production');

    setServers([]);
    await watcher.sync();
    await settle();

    expect(hubs.latest()?.openStreams('alerts')).toBe(0);
  });
});

describe('appNotificationInbox', () => {
  function inbox(initial: AppNotification[] = []) {
    let items = initial;
    const changed = vi.fn();
    const port = appNotificationInbox({
      list: async () => items,
      save: async (next) => {
        items = next;
      },
      changed,
    });
    return { port, changed, items: () => items };
  }

  const entry = (id: string, read = false): AppNotification => ({
    id,
    kind: 'deploy-warning',
    title: id,
    body: '',
    projectId: null,
    projectName: 'Production',
    htmlUrl: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    read,
  });

  it('adds an entry once, newest first, and keeps the inbox to 200', async () => {
    const { port, changed, items } = inbox(
      Array.from({ length: 200 }, (_, n) => entry(`old-${n}`)),
    );

    await port.add(entry('new'));
    await port.add(entry('new'));

    expect(items()[0].id).toBe('new');
    expect(items()).toHaveLength(200);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('marks the entries of one alert read, and says so only when something changed', async () => {
    const { port, changed, items } = inbox([
      entry('deploy-alert:srv-1:1:4'),
      entry('deploy-alert:srv-1:1:1'),
      entry('deploy-alert:srv-1:12:5'),
    ]);

    await port.markRead('deploy-alert:srv-1:1:');
    await port.markRead('deploy-alert:srv-1:1:');

    expect(items().map((item) => item.read)).toEqual([true, true, false]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
