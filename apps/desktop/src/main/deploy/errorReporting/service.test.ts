import { describe, expect, it, vi } from 'vitest';
import { coreErrorCode } from '../../../shared/coreErrors';
import type {
  ErrorReportingRequest,
  ErrorReportingStatus,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { DeployErrorReporting } from './service';

const KEY = 'd4e5f60718293a4b5c6d7e8f90a1b2c3';
const DSN = `https://${KEY}@o1.ingest.sentry.io/42`;

const STATUS: ErrorReportingStatus = {
  configured: true,
  enabled: true,
  host: 'o1.ingest.sentry.io',
  projectId: '42',
  environment: 'staging',
  serverName: 'web-1',
  minLevel: 'warning',
  defaultServerName: 'web-1',
  sentCount: 3,
};

const BASE = {
  serverId: 'srv',
  enabled: true,
  environment: 'staging',
  serverName: 'web-1',
  level: 'warning',
} as const;

function setup(roles = ['owner'], hubOverrides: Partial<Record<string, unknown>> = {}) {
  const hub = {
    stepUp: vi.fn(async () => ({ stepUpUntilUnixMs: 1 })),
    getErrorReporting: vi.fn(async () => STATUS),
    saveErrorReporting: vi.fn(async (_request: ErrorReportingRequest) => ({
      problems: [],
      status: STATUS,
    })),
    removeErrorReporting: vi.fn(async () => ({ ...STATUS, configured: false, enabled: false })),
    sendErrorReportingTest: vi.fn(async () => ({
      delivered: true,
      httpStatus: 200,
      message: 'Sentry accepted the test event (HTTP 200).',
    })),
    ...hubOverrides,
  };
  const service = new DeployErrorReporting({
    links: { call: (_id, work) => work(hub as unknown as ICoreHub) },
    roles: () => roles,
  });
  return { service, hub };
}

describe('DeployErrorReporting', () => {
  it('reads how reporting stands', async () => {
    const { service, hub } = setup();

    expect(await service.status('srv')).toEqual(STATUS);
    expect(hub.getErrorReporting).toHaveBeenCalledOnce();
  });

  it('saves the setup, stepping up first when handed the password', async () => {
    const { service, hub } = setup();

    const result = await service.save({ ...BASE, dsn: DSN, password: 'pw' });

    expect(hub.stepUp).toHaveBeenCalledWith({ password: 'pw' });
    expect(hub.saveErrorReporting).toHaveBeenCalledWith({
      dsn: DSN,
      enabled: true,
      environment: 'staging',
      serverName: 'web-1',
      minLevel: 'warning',
    });
    expect(hub.stepUp.mock.invocationCallOrder[0]).toBeLessThan(
      hub.saveErrorReporting.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result).toEqual({ problems: [], status: STATUS });
  });

  it('tidies the pasted DSN and sends the options the core expects', async () => {
    const { service, hub } = setup();

    await service.save({
      ...BASE,
      dsn: `  ${DSN}\n`,
      environment: '',
      serverName: ' ',
      level: 'error',
      totpCode: '123456',
    });

    expect(hub.stepUp).toHaveBeenCalledWith({ totpCode: '123456' });
    expect(hub.saveErrorReporting).toHaveBeenCalledWith({
      dsn: DSN,
      enabled: true,
      environment: 'production',
      serverName: '',
      minLevel: 'error',
    });
  });

  it('keeps the stored DSN when none is given, so other settings can change', async () => {
    const { service, hub } = setup();

    await service.save({ ...BASE, level: 'error' });

    const sent = hub.saveErrorReporting.mock.calls[0]?.[0];
    expect(sent).not.toHaveProperty('dsn');
    expect(sent).toMatchObject({ minLevel: 'error' });
  });

  it('checks the DSN and options before the server sees them', async () => {
    const { service, hub } = setup();

    await expect(service.save({ ...BASE, dsn: 'http://example.com/1' })).rejects.toThrow(/DSN/);
    await expect(service.save({ ...BASE, dsn: DSN, environment: 'no good' })).rejects.toThrow(
      /Environment/,
    );
    await expect(service.save({ ...BASE, dsn: DSN, serverName: 'a\nb' })).rejects.toThrow(
      /Server name/,
    );
    expect(hub.saveErrorReporting).not.toHaveBeenCalled();
  });

  it('hands back what the core found wrong without saving', async () => {
    const { service } = setup(['owner'], {
      saveErrorReporting: vi.fn(async () => ({ problems: ['No such project.'] })),
    });

    expect(await service.save({ ...BASE, dsn: DSN })).toEqual({
      problems: ['No such project.'],
      status: null,
    });
  });

  it('removes the setup, stepping up first', async () => {
    const { service, hub } = setup();

    const status = await service.remove({ serverId: 'srv', password: 'pw' });

    expect(hub.stepUp).toHaveBeenCalledWith({ password: 'pw' });
    expect(hub.removeErrorReporting).toHaveBeenCalledOnce();
    expect(status.configured).toBe(false);
  });

  it('sends a test event and reports Sentry’s answer', async () => {
    const { service } = setup();

    expect(await service.test('srv')).toEqual({
      delivered: true,
      httpStatus: 200,
      message: 'Sentry accepted the test event (HTTP 200).',
    });
  });

  it('never puts the key in anything it returns', async () => {
    const { service } = setup();

    const saved = await service.save({ ...BASE, dsn: DSN });
    const status = await service.status('srv');

    expect(JSON.stringify([saved, status])).not.toContain(KEY);
  });

  it('asks an Owner for a step-up and tells an Admin the role is not enough', async () => {
    const refuse = vi.fn(async () => {
      throw new Error("Failed to invoke 'SaveErrorReporting' because user is unauthorized");
    });
    const owner = setup(['owner'], { saveErrorReporting: refuse });
    const admin = setup(['admin'], { saveErrorReporting: refuse });

    expect(coreErrorCode(await owner.service.save({ ...BASE, dsn: DSN }).catch((e) => e))).toBe(
      'stepUpRequired',
    );
    expect(coreErrorCode(await admin.service.save({ ...BASE, dsn: DSN }).catch((e) => e))).toBe(
      'forbidden',
    );
  });

  it('says so plainly when the server runs a core without error reporting', async () => {
    const older = vi.fn(async () => {
      throw new Error(
        "Failed to invoke 'GetErrorReporting' due to an error on the server. HubException: Method does not exist.",
      );
    });
    const { service } = setup(['owner'], {
      getErrorReporting: older,
      saveErrorReporting: older,
      removeErrorReporting: older,
      sendErrorReportingTest: older,
    });

    for (const run of [
      () => service.status('srv'),
      () => service.save({ ...BASE, dsn: DSN }),
      () => service.remove({ serverId: 'srv' }),
      () => service.test('srv'),
    ]) {
      await expect(run()).rejects.toThrow(/older core.*Update/);
    }
  });
});
