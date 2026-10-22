import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { ServerRestores } from '../deploy/serverBackups/restore';
import type { ServerBackups } from '../deploy/serverBackups/service';
import { registerDeployServerBackupsHandlers } from './deployServerBackups';

/**
 * The Backups section's channels (E28) answer only the main window and check every argument
 * before the core hears of it: ids are GUIDs, a destination's kind and settings have the shapes
 * the core takes, a plan's numbers are in range, and a restore names a picked file by its token.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ID = '00000000-0000-4000-9000-000000000001';
const ID2 = '00000000-0000-4000-9000-000000000002';
const C = IPC.deployServerBackups;

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const answer = vi.fn(async (..._args: unknown[]) => ({}));
  const backups = new Proxy(
    {},
    { get: (_target, property) => (property === 'then' ? undefined : answer) },
  ) as unknown as ServerBackups;
  const restoreCalls = { restore: vi.fn(async () => ({})), bringUp: vi.fn(async () => ({})) };
  registerDeployServerBackupsHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    backups,
    restores: restoreCalls as unknown as ServerRestores,
    guard: () => trusted,
  });
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, answer, restoreCalls, call };
}

const FOLDER = {
  serverId: 'srv-1',
  destination: { name: 'Disk', kind: 'folder', settings: { path: '/srv/backups' } },
};

describe('deployServerBackups handlers', () => {
  it('registers every invoke channel of the group', () => {
    const { handlers } = harness();
    const invokes = Object.entries(C)
      .filter(([key]) => !key.startsWith('on'))
      .map(([, channel]) => channel);
    expect([...handlers.keys()].sort()).toEqual(invokes.sort());
  });

  it('answers only the main window', async () => {
    const { call, answer } = harness(false);
    await expect(call(C.getSecret, 'srv-1')).rejects.toThrow(/main window/);
    expect(answer).not.toHaveBeenCalled();
  });

  it('checks a destination before it goes to the core', async () => {
    const { call, answer } = harness();
    await call(C.saveDestination, FOLDER);
    expect(answer).toHaveBeenCalledWith({
      serverId: 'srv-1',
      destination: { name: 'Disk', kind: 'folder', settings: { path: '/srv/backups' } },
    });
    await expect(
      call(C.saveDestination, {
        ...FOLDER,
        destination: { ...FOLDER.destination, kind: 'dropbox' },
      }),
    ).rejects.toThrow(/kind/);
    await expect(
      call(C.saveDestination, {
        ...FOLDER,
        destination: { ...FOLDER.destination, settings: { port: 70000 } },
      }),
    ).rejects.toThrow(/port/i);
    await expect(
      call(C.saveDestination, { ...FOLDER, destination: { ...FOLDER.destination, id: 'nope' } }),
    ).rejects.toThrow(/destination/);
  });

  it('passes a destination secret through and drops unknown fields', async () => {
    const { call, answer } = harness();
    await call(C.testDestination, {
      serverId: 'srv-1',
      destination: {
        name: 'Box',
        kind: 'sftp',
        settings: { host: 'box.example', port: 22, userName: 'u', path: '/b', extra: 'x' },
        secret: { password: 'pw', evil: 'x' },
        maxPartBytes: 1024 * 1024 * 1024,
      },
    });
    expect(answer).toHaveBeenCalledWith({
      serverId: 'srv-1',
      destination: {
        name: 'Box',
        kind: 'sftp',
        settings: { host: 'box.example', port: 22, userName: 'u', path: '/b' },
        secret: { password: 'pw' },
        maxPartBytes: 1024 * 1024 * 1024,
      },
    });
  });

  it('keeps a plan in range', async () => {
    const { call, answer } = harness();
    const plan = {
      name: 'Nightly',
      enabled: true,
      cron: '30 3 * * *',
      timeZone: 'Europe/Berlin',
      keepLast: 7,
      destinationIds: [ID],
    };
    await call(C.savePlan, { serverId: 'srv-1', plan });
    expect(answer).toHaveBeenCalledWith('srv-1', plan);
    await expect(
      call(C.savePlan, { serverId: 'srv-1', plan: { ...plan, keepLast: 0 } }),
    ).rejects.toThrow(/keep/i);
    await expect(
      call(C.savePlan, { serverId: 'srv-1', plan: { ...plan, destinationIds: [] } }),
    ).rejects.toThrow(/destination/);
    await expect(
      call(C.savePlan, { serverId: 'srv-1', plan: { ...plan, timeZone: 'Mars; rm -rf' } }),
    ).rejects.toThrow(/time zone/);
  });

  it('checks Back up now and the history limit', async () => {
    const { call, answer } = harness();
    await call(C.runNow, { serverId: 'srv-1', destinationIds: [ID, ID2], download: false });
    expect(answer).toHaveBeenCalledWith({
      serverId: 'srv-1',
      destinationIds: [ID, ID2],
      download: false,
    });
    await expect(
      call(C.runNow, { serverId: 'srv-1', destinationIds: ['x'], download: false }),
    ).rejects.toThrow();
    await call(C.listRuns, 'srv-1', 20);
    expect(answer).toHaveBeenLastCalledWith('srv-1', 20);
    await expect(call(C.listRuns, 'srv-1', 100_000)).rejects.toThrow();
  });

  it('checks the Telegram login', async () => {
    const { call, answer } = harness();
    await call(C.startTelegramLogin, {
      serverId: 'srv-1',
      apiId: 12345,
      apiHash: '0123456789abcdef0123456789abcdef',
      phoneNumber: '+49 151 2345678',
    });
    expect(answer).toHaveBeenCalled();
    await expect(
      call(C.startTelegramLogin, {
        serverId: 'srv-1',
        apiId: 12345,
        apiHash: 'short',
        phoneNumber: '+49 151 2345678',
      }),
    ).rejects.toThrow(/api_hash/);
    await expect(
      call(C.continueTelegramLogin, {
        serverId: 'srv-1',
        loginId: 'l1',
        code: '1234567890123456789',
      }),
    ).rejects.toThrow();
  });

  it('checks a cloud drive sign-in', async () => {
    const { call, answer } = harness();
    await call(C.connectCloudDrive, {
      serverId: 'srv-1',
      name: 'Drive',
      kind: 'googleDrive',
      clientId: 'abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-x',
      folderName: 'AgentMate',
    });
    expect(answer).toHaveBeenCalled();
    await expect(
      call(C.connectCloudDrive, {
        serverId: 'srv-1',
        name: 'Drive',
        kind: 'ftp',
        clientId: 'a',
        folderName: 'b',
      }),
    ).rejects.toThrow(/Google Drive or OneDrive/);
  });

  it('checks a restore and names a picked file by its token', async () => {
    const { call, restoreCalls } = harness();
    const base = {
      serverId: 'srv-1',
      secret: 'orange tractor lamp',
      sudoPassword: null,
      userName: 'maria',
      password: 'pw',
    };
    await call(C.restore, { ...base, source: { kind: 'file', fileToken: ID } });
    await call(C.restore, {
      ...base,
      source: { kind: 'destination', serverId: 'srv-2', destinationId: ID, backupId: ID2 },
    });
    expect(restoreCalls.restore).toHaveBeenCalledTimes(2);
    await expect(
      call(C.restore, { ...base, source: { kind: 'file', path: 'C:/x.ambackup' } }),
    ).rejects.toThrow(/again/);
    await expect(
      call(C.restore, { ...base, userName: 'a b', source: { kind: 'file', fileToken: ID } }),
    ).rejects.toThrow(/user name/);
    await expect(
      call(C.restore, { ...base, secret: 'two\nlines', source: { kind: 'file', fileToken: ID } }),
    ).rejects.toThrow(/secret/);
  });

  it('checks bringing the server up', async () => {
    const { call, restoreCalls } = harness();
    await call(C.bringUp, { serverId: 'srv-1', moveAddresses: true, password: 'pw' });
    expect(restoreCalls.bringUp).toHaveBeenCalledWith({
      serverId: 'srv-1',
      moveAddresses: true,
      password: 'pw',
    });
    await expect(call(C.bringUp, { serverId: 'srv-1' })).rejects.toThrow(/address/);
  });
});
