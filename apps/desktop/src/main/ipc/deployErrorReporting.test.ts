import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { DeployErrorReporting } from '../deploy/errorReporting/service';
import { registerDeployErrorReportingHandlers } from './deployErrorReporting';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const KEY = 'd4e5f60718293a4b5c6d7e8f90a1b2c3';
const DSN = `https://${KEY}@o1.ingest.sentry.io/42`;

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const errorReporting = {
    status: vi.fn(async () => ({})),
    save: vi.fn(async (_input: unknown) => ({ problems: [], status: null })),
    remove: vi.fn(async () => ({})),
    test: vi.fn(async () => ({})),
  };
  registerDeployErrorReportingHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    errorReporting: errorReporting as unknown as DeployErrorReporting,
    guard: () => trusted,
  });
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, errorReporting, call };
}

const GOOD = {
  serverId: 'srv-1',
  dsn: DSN,
  enabled: true,
  environment: 'staging',
  serverName: 'web-1',
  level: 'warning',
};

describe('registerDeployErrorReportingHandlers', () => {
  it('handles every channel of the group', () => {
    const { handlers } = harness();

    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC.deployErrorReporting).sort());
  });

  it('answers only the main window', async () => {
    const { call, errorReporting } = harness(false);

    await expect(call(IPC.deployErrorReporting.status, 'srv-1')).rejects.toThrow(/main window/);
    await expect(call(IPC.deployErrorReporting.save, GOOD)).rejects.toThrow(/main window/);
    expect(errorReporting.status).not.toHaveBeenCalled();
    expect(errorReporting.save).not.toHaveBeenCalled();
  });

  it('passes reads and the test with a checked server', async () => {
    const { call, errorReporting } = harness();

    await call(IPC.deployErrorReporting.status, 'srv-1');
    await call(IPC.deployErrorReporting.test, 'srv-1');

    expect(errorReporting.status).toHaveBeenCalledWith('srv-1');
    expect(errorReporting.test).toHaveBeenCalledWith('srv-1');
    await expect(call(IPC.deployErrorReporting.status, '../etc')).rejects.toThrow(/saved server/);
    await expect(call(IPC.deployErrorReporting.test, 7)).rejects.toThrow(/saved server/);
  });

  it('passes a checked setup with its step-up proof, and nothing else', async () => {
    const { call, errorReporting } = harness();

    await call(IPC.deployErrorReporting.save, {
      ...GOOD,
      dsn: `  ${DSN}  `,
      environment: '',
      password: 'secret',
      extra: 'dropped',
    });

    expect(errorReporting.save).toHaveBeenCalledWith({
      serverId: 'srv-1',
      password: 'secret',
      dsn: DSN,
      enabled: true,
      environment: 'production',
      serverName: 'web-1',
      level: 'warning',
    });
  });

  it('keeps the stored DSN when none is sent', async () => {
    const { call, errorReporting } = harness();

    await call(IPC.deployErrorReporting.save, { ...GOOD, dsn: undefined, level: 'error' });
    await call(IPC.deployErrorReporting.save, { ...GOOD, dsn: '', level: 'error' });

    for (const [sent] of errorReporting.save.mock.calls) {
      expect(sent).not.toHaveProperty('dsn');
      expect(sent).toMatchObject({ level: 'error' });
    }
  });

  it.each([
    [{ dsn: 'http://example.com/1' }, /DSN|https/],
    [{ dsn: 5 }, /DSN/],
    [{ enabled: 'yes' }, /on or paused/],
    [{ environment: 'no good' }, /Environment/],
    [{ environment: 7 }, /Environment/],
    [{ serverName: 'a\nb' }, /Server name/],
    [{ serverName: 7 }, /Server name/],
    [{ level: 'loud' }, /Warnings and errors/],
    [{ level: undefined }, /Warnings and errors/],
  ])('refuses %o without telling the core', async (fields, reason) => {
    const { call, errorReporting } = harness();

    await expect(call(IPC.deployErrorReporting.save, { ...GOOD, ...fields })).rejects.toThrow(
      reason,
    );
    expect(errorReporting.save).not.toHaveBeenCalled();
  });

  it('never repeats the key when it refuses a DSN', async () => {
    const { call } = harness();

    const error = await call(IPC.deployErrorReporting.save, {
      ...GOOD,
      dsn: `https://${KEY}@sentry.example.com/not-a-number`,
    }).catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('removes with a checked server and its step-up proof', async () => {
    const { call, errorReporting } = harness();

    await call(IPC.deployErrorReporting.remove, { serverId: 'srv-1', totpCode: '123456' });

    expect(errorReporting.remove).toHaveBeenCalledWith({ serverId: 'srv-1', totpCode: '123456' });
    await expect(call(IPC.deployErrorReporting.remove, { serverId: '../x' })).rejects.toThrow(
      /saved server/,
    );
    await expect(call(IPC.deployErrorReporting.remove, 'srv-1')).rejects.toThrow();
  });
});
