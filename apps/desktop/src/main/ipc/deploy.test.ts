import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { DeployService } from '../deploy/service';
import { registerDeployHandlers } from './deploy';

/**
 * The Deploy channels only answer the app's main window (a browser tab or widget sharing the
 * preload gets an error), and every argument is checked before it reaches the service.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const service = {
    listServers: vi.fn(async () => []),
    preflight: vi.fn(async () => ({})),
    install: vi.fn(async () => ({ version: '1.53.0' })),
    uninstall: vi.fn(async () => undefined),
    health: vi.fn(async () => ({ version: '1.53.0' })),
    access: vi.fn(async () => ({ state: 'signed-in' })),
    enroll: vi.fn(async () => ({ state: 'signed-in' })),
    signIn: vi.fn(async () => ({ state: 'signed-in' })),
    signOut: vi.fn(async () => undefined),
    account: vi.fn(async () => ({})),
    stepUp: vi.fn(async () => ({})),
    stepUpWithSavedPassword: vi.fn(async () => null),
    rememberPassword: vi.fn(async () => undefined),
    forgetPassword: vi.fn(async () => undefined),
    beginTotp: vi.fn(async () => ({})),
    confirmTotp: vi.fn(async () => ({ codes: [] })),
    disableTotp: vi.fn(async () => undefined),
    connection: vi.fn(() => ({ serverId: 'srv-1', state: 'online', since: 1 })),
    reconnect: vi.fn(() => ({ serverId: 'srv-1', state: 'connecting', since: 2 })),
  };
  registerDeployHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    service: service as unknown as DeployService,
    guard: () => trusted,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { service, call, handlers };
}

const ACCOUNT = { userName: 'maria', password: 'correct horse battery staple' };

describe('registerDeployHandlers', () => {
  it('handles every invoke channel in the deploy group', () => {
    const { handlers } = harness();
    const invokes = Object.entries(IPC.deploy)
      .filter(([name]) => !name.startsWith('on'))
      .map(([, channel]) => channel);

    expect([...handlers.keys()].sort()).toEqual(invokes.sort());
  });

  it('passes checked arguments through to the service', async () => {
    const { service, call } = harness();

    await call(IPC.deploy.listServers);
    await call(IPC.deploy.preflight, 'srv-1');
    await call(IPC.deploy.install, { serverId: 'srv-1', sudoPassword: 'pw' });
    await call(IPC.deploy.uninstall, { serverId: 'srv-1', sudoPassword: null, keepData: true });
    await call(IPC.deploy.health, 'srv-1');

    expect(service.listServers).toHaveBeenCalled();
    expect(service.preflight).toHaveBeenCalledWith('srv-1');
    expect(service.install).toHaveBeenCalledWith({ serverId: 'srv-1', sudoPassword: 'pw' });
    expect(service.uninstall).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sudoPassword: null,
      keepData: true,
    });
    expect(service.health).toHaveBeenCalledWith('srv-1');
  });

  it('answers only the main window', async () => {
    const { service, call } = harness(false);

    await expect(call(IPC.deploy.listServers)).rejects.toThrow(/main window/);
    await expect(
      call(IPC.deploy.install, { serverId: 'srv-1', sudoPassword: 'pw' }),
    ).rejects.toThrow(/main window/);
    expect(service.listServers).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });

  it('refuses arguments that are not what the channel takes', async () => {
    const { service, call } = harness();

    for (const serverId of [42, '', 'x'.repeat(200), '../etc', null]) {
      await expect(call(IPC.deploy.health, serverId)).rejects.toThrow(/server/);
    }
    await expect(call(IPC.deploy.install, { serverId: 'srv-1', sudoPassword: 7 })).rejects.toThrow(
      /password/,
    );
    await expect(
      call(IPC.deploy.install, { serverId: 'srv-1', sudoPassword: 'a'.repeat(5000) }),
    ).rejects.toThrow(/password/);
    await expect(
      call(IPC.deploy.uninstall, { serverId: 'srv-1', sudoPassword: null, keepData: 'yes' }),
    ).rejects.toThrow(/keep/);
    await expect(call(IPC.deploy.install, null)).rejects.toThrow();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.uninstall).not.toHaveBeenCalled();
    expect(service.health).not.toHaveBeenCalled();
  });

  it('passes the account and sign-in calls through once their arguments check out', async () => {
    const { service, call } = harness();

    await call(IPC.deploy.install, { serverId: 'srv-1', sudoPassword: null, account: ACCOUNT });
    await call(IPC.deploy.enroll, { serverId: 'srv-1', sudoPassword: 'pw', account: ACCOUNT });
    await call(IPC.deploy.signIn, { serverId: 'srv-1', password: 'pw', totpCode: '123456' });
    await call(IPC.deploy.stepUp, { serverId: 'srv-1', totpCode: '123456' });
    await call(IPC.deploy.confirmTotp, 'srv-1', '123 456');
    await call(IPC.deploy.access, 'srv-1');

    expect(service.install).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sudoPassword: null,
      account: ACCOUNT,
    });
    expect(service.enroll).toHaveBeenCalledWith({
      serverId: 'srv-1',
      sudoPassword: 'pw',
      account: ACCOUNT,
    });
    expect(service.signIn).toHaveBeenCalledWith({
      serverId: 'srv-1',
      password: 'pw',
      totpCode: '123456',
    });
    expect(service.stepUp).toHaveBeenCalledWith({ serverId: 'srv-1', totpCode: '123456' });
    expect(service.confirmTotp).toHaveBeenCalledWith('srv-1', '123 456');
    expect(service.access).toHaveBeenCalledWith('srv-1');
  });

  it('keeps, uses and forgets a remembered password through the service only', async () => {
    const { service, call } = harness();

    expect(await call(IPC.deploy.stepUpSaved, 'srv-1')).toBeNull();
    await call(IPC.deploy.rememberPassword, { serverId: 'srv-1', password: 'pw' });
    await call(IPC.deploy.forgetPassword, 'srv-1');

    expect(service.stepUpWithSavedPassword).toHaveBeenCalledWith('srv-1');
    expect(service.rememberPassword).toHaveBeenCalledWith({ serverId: 'srv-1', password: 'pw' });
    expect(service.forgetPassword).toHaveBeenCalledWith('srv-1');
  });

  it('refuses a remembered-password call with a bad server or password', async () => {
    const { service, call } = harness();

    await expect(call(IPC.deploy.stepUpSaved, '../x')).rejects.toThrow(/server/);
    await expect(call(IPC.deploy.forgetPassword, 42)).rejects.toThrow(/server/);
    await expect(
      call(IPC.deploy.rememberPassword, { serverId: 'srv-1', password: 'a'.repeat(5000) }),
    ).rejects.toThrow(/password/);
    expect(service.stepUpWithSavedPassword).not.toHaveBeenCalled();
    expect(service.rememberPassword).not.toHaveBeenCalled();
    expect(service.forgetPassword).not.toHaveBeenCalled();
  });

  it('keeps the remembered password to the main window', async () => {
    const { service, call } = harness(false);

    await expect(call(IPC.deploy.stepUpSaved, 'srv-1')).rejects.toThrow(/main window/);
    await expect(
      call(IPC.deploy.rememberPassword, { serverId: 'srv-1', password: 'pw' }),
    ).rejects.toThrow(/main window/);
    await expect(call(IPC.deploy.forgetPassword, 'srv-1')).rejects.toThrow(/main window/);
    expect(service.stepUpWithSavedPassword).not.toHaveBeenCalled();
    expect(service.rememberPassword).not.toHaveBeenCalled();
  });

  it("tells a server's connection state, and tries it again on request", async () => {
    const { service, call } = harness();

    expect(await call(IPC.deploy.connection, 'srv-1')).toMatchObject({ state: 'online' });
    expect(await call(IPC.deploy.reconnect, 'srv-1')).toMatchObject({ state: 'connecting' });
    await expect(call(IPC.deploy.reconnect, '../x')).rejects.toThrow(/server/);

    expect(service.connection).toHaveBeenCalledWith('srv-1');
    expect(service.reconnect).toHaveBeenCalledTimes(1);
  });

  it('refuses account and sign-in arguments of the wrong shape', async () => {
    const { service, call } = harness();

    await expect(
      call(IPC.deploy.enroll, { serverId: 'srv-1', sudoPassword: null }),
    ).rejects.toThrow(/account/);
    await expect(
      call(IPC.deploy.install, {
        serverId: 'srv-1',
        sudoPassword: null,
        account: { userName: 7, password: 'x' },
      }),
    ).rejects.toThrow(/user name/);
    await expect(call(IPC.deploy.signIn, { serverId: 'srv-1' })).rejects.toThrow(/password/);
    await expect(
      call(IPC.deploy.signIn, { serverId: 'srv-1', password: 'pw', totpCode: 'x'.repeat(40) }),
    ).rejects.toThrow(/code/);
    await expect(call(IPC.deploy.confirmTotp, 'srv-1', 42)).rejects.toThrow(/code/);
    expect(service.enroll).not.toHaveBeenCalled();
    expect(service.signIn).not.toHaveBeenCalled();
    expect(service.confirmTotp).not.toHaveBeenCalled();
  });
});
