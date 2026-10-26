import { readFileSync } from 'node:fs';
import type { AppNotification, HealthIncident, Project } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { electronState, FakeBrowserWindow } from '../../test/main/electronMock';
import { withPlatform } from '../../test/main/fixtures';
import { useTempUserData } from '../../test/main/ipcHarness';
import type { HealthTransition } from './alerts';
import type { StoredHealthTarget } from './store';

/**
 * What the user hears about a healthcheck: an OS notification and an inbox entry when a target is
 * confirmed down, and again when it is confirmed back up. Both open the target on the Health page.
 */

const userData = useTempUserData();
const OPENED = 1_760_000_000_000;

const target = { id: 't1', name: 'API' } as StoredHealthTarget;
const project = { id: 'p1', name: 'Shop' } as Project;
const incident: HealthIncident = {
  id: 'i1',
  targetId: 't1',
  openedAt: OPENED,
  resolvedAt: null,
  state: 'fail',
  summary: 'postgres:connection: connect ECONNREFUSED',
  failingServices: ['postgres:connection'],
  diagnosis: null,
};

function opened(): HealthTransition {
  return { kind: 'opened', target, project, incident };
}

function resolved(after: number): HealthTransition {
  return {
    kind: 'resolved',
    target,
    project,
    incident: { ...incident, resolvedAt: OPENED + after },
  };
}

async function alerts() {
  const toast = vi.fn();
  const add = vi.fn(async (_notification: AppNotification) => undefined);
  const { createHealthAlerts } = await import('./alerts');
  return { toast, add, announce: createHealthAlerts({ toast, inbox: { add }, now: () => OPENED }) };
}

describe('createHealthAlerts', () => {
  it('announces a target that went down, with a link to it', async () => {
    const { toast, add, announce } = await alerts();
    await announce(opened());
    expect(toast).toHaveBeenCalledWith({
      title: 'API is down',
      body: 'Shop: postgres:connection: connect ECONNREFUSED',
      route: '/monitoring?target=t1',
    });
    expect(add).toHaveBeenCalledWith({
      id: 'health:t1:i1:failure',
      kind: 'health-failure',
      title: 'API is down',
      body: 'Shop: postgres:connection: connect ECONNREFUSED',
      projectId: 'p1',
      projectName: 'Shop',
      htmlUrl: null,
      route: '/monitoring?target=t1',
      createdAt: new Date(OPENED).toISOString(),
      read: false,
    });
  });

  it('announces a target that came back, as good news already read', async () => {
    const { toast, add, announce } = await alerts();
    await announce(resolved(5 * 60_000));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'API is back up', body: 'Shop: back after 5 min' }),
    );
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'health:t1:i1:recovered',
        kind: 'health-recovered',
        read: true,
      }),
    );
  });

  it.each([
    [20_000, 'less than a minute'],
    [90 * 60_000, '1 h 30 min'],
    [2 * 60 * 60_000, '2 h'],
    [26 * 60 * 60_000, '1 day 2 h'],
    [3 * 24 * 60 * 60_000, '3 days'],
  ])('says how long it was down (%i ms)', async (after, words) => {
    const { toast, announce } = await alerts();
    await announce(resolved(after));
    expect(toast.mock.calls[0][0].body).toBe(`Shop: back after ${words}`);
  });

  it('encodes the target id in the link', async () => {
    const { toast, announce } = await alerts();
    await announce({ ...opened(), target: { ...target, id: 'a b&c' } });
    expect(toast.mock.calls[0][0].route).toBe('/monitoring?target=a%20b%26c');
  });
});

describe('announceHealthTransition', () => {
  it('writes the inbox entry, tells the windows, and shows the notification', async () => {
    const window = new FakeBrowserWindow();
    const { announceHealthTransition } = await import('./alerts');
    await withPlatform('linux', () => announceHealthTransition(opened()));

    const inbox = JSON.parse(
      readFileSync(userData.dataFile('app-notifications.json'), 'utf-8'),
    ) as AppNotification[];
    expect(inbox.map((entry) => [entry.id, entry.kind])).toEqual([
      ['health:t1:i1:failure', 'health-failure'],
    ]);
    expect(window.webContents.sentOn(IPC.appNotifications.onChanged)).toHaveLength(1);
    expect(electronState.notifications).toEqual([
      expect.objectContaining({ title: 'API is down' }),
    ]);

    // The same transition again adds nothing.
    await withPlatform('linux', () => announceHealthTransition(opened()));
    expect(
      JSON.parse(readFileSync(userData.dataFile('app-notifications.json'), 'utf-8')),
    ).toHaveLength(1);
  });
});
