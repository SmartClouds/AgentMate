import { describe, expect, it, vi } from 'vitest';
import type {
  AuditEventInfo,
  AuditPage,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { DeploySecurity, type DeploySecurityDeps, MAX_EXPORT_EVENTS } from './security';

/**
 * The Security area's calls to a core: users (for an Owner), devices and sessions, enrollment
 * codes and the audit trail. Each goes over one short hub connection; passwords pass straight
 * through to the core, and anything that may have ended this computer's own session makes the
 * next access check ask the core again.
 */

const PASSWORD = 'another long passphrase';

function event(id: number): AuditEventInfo {
  return { id, atUnixMs: id * 1000, action: 'auth.login', result: 'success' };
}

function setup(overrides: Partial<DeploySecurityDeps> = {}) {
  const hub = {
    listUsers: vi.fn(async () => [{ id: 'u1', userName: 'maria' }]),
    createUser: vi.fn(async () => ({ id: 'u2', userName: 'sam' })),
    setUserRole: vi.fn(async () => ({ id: 'u2', role: 'admin' })),
    setUserDisabled: vi.fn(async () => ({ id: 'u2', disabled: true })),
    resetUserPassword: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
    createEnrollmentCode: vi.fn(async () => ({
      code: 'ABCDE-FGHIJ',
      userName: 'sam',
      expiresAtUnixMs: 1,
    })),
    listDevices: vi.fn(async () => []),
    revokeDevice: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    revokeSession: vi.fn(async () => undefined),
    revokeOtherSessions: vi.fn(async () => 2),
    queryAudit: vi.fn(async (): Promise<AuditPage> => ({ events: [event(1)] })),
    verifyAudit: vi.fn(async () => ({ intact: true, checked: 3 })),
  };
  const connections: string[] = [];
  const written: Array<{ path: string; content: string }> = [];
  const deps: DeploySecurityDeps = {
    withHub: async (serverId, work) => {
      connections.push(serverId);
      return work(hub as unknown as ICoreHub);
    },
    forgetTokens: vi.fn(),
    serverName: async () => 'Prod / EU',
    pickExportPath: vi.fn(async (_format, suggested) => `/exports/${suggested}`),
    writeFile: async (path, content) => {
      written.push({ path, content });
    },
    now: () => Date.UTC(2026, 9, 1, 12, 0, 0),
    ...overrides,
  };
  return { security: new DeploySecurity(deps), hub, connections, written, deps };
}

describe('DeploySecurity users', () => {
  it('passes each change to the core as it was asked for, the password included, and nothing more', async () => {
    const { security, hub, connections } = setup();

    await security.listUsers('srv-1');
    await security.createUser({
      serverId: 'srv-1',
      userName: 'sam',
      password: PASSWORD,
      role: 'operator',
    });
    await security.setUserDisabled({ serverId: 'srv-1', userId: 'u2', disabled: true });
    await security.resetUserPassword({ serverId: 'srv-1', userId: 'u2', password: PASSWORD });
    await security.deleteUser({ serverId: 'srv-1', userId: 'u2' });

    expect(hub.createUser).toHaveBeenCalledWith({
      userName: 'sam',
      password: PASSWORD,
      role: 'operator',
    });
    expect(hub.setUserDisabled).toHaveBeenCalledWith('u2', true);
    expect(hub.resetUserPassword).toHaveBeenCalledWith({ userId: 'u2', password: PASSWORD });
    expect(hub.deleteUser).toHaveBeenCalledWith('u2');
    expect(connections).toEqual(['srv-1', 'srv-1', 'srv-1', 'srv-1', 'srv-1']);
  });

  it('asks the core again who is signed in after a role change, which may be the own one', async () => {
    const { security, hub, deps } = setup();

    await security.setUserRole({ serverId: 'srv-1', userId: 'u2', role: 'admin' });

    expect(hub.setUserRole).toHaveBeenCalledWith('u2', 'admin');
    expect(deps.forgetTokens).toHaveBeenCalledWith('srv-1');
  });

  it('mints an enrollment code for a user, or for the signed-in user when none is named', async () => {
    const { security, hub } = setup();

    await security.createEnrollmentCode({ serverId: 'srv-1', userName: 'sam', validMinutes: 60 });
    await security.createEnrollmentCode({ serverId: 'srv-1' });

    expect(hub.createEnrollmentCode).toHaveBeenNthCalledWith(1, {
      userName: 'sam',
      validMinutes: 60,
    });
    expect(hub.createEnrollmentCode).toHaveBeenNthCalledWith(2, {});
  });
});

describe('DeploySecurity devices and sessions', () => {
  it('lists them and, after a revocation, makes the next access check ask the core', async () => {
    const { security, hub, deps } = setup();

    await security.listDevices('srv-1');
    await security.listSessions('srv-1');
    expect(deps.forgetTokens).not.toHaveBeenCalled();
    await security.revokeDevice('srv-1', 'd1');
    await security.revokeSession('srv-1', 's1');

    expect(hub.revokeDevice).toHaveBeenCalledWith('d1');
    expect(hub.revokeSession).toHaveBeenCalledWith('s1');
    expect(deps.forgetTokens).toHaveBeenCalledTimes(2);
  });

  it('ends every other session and says how many', async () => {
    const { security } = setup();

    expect(await security.revokeOtherSessions('srv-1')).toBe(2);
  });
});

describe('DeploySecurity audit', () => {
  it('queries with only the filters given', async () => {
    const { security, hub } = setup();

    await security.queryAudit({ serverId: 'srv-1', result: 'failed', beforeId: 40, limit: 50 });

    expect(hub.queryAudit).toHaveBeenCalledWith({ result: 'failed', beforeId: 40, limit: 50 });
  });

  it('checks the chain', async () => {
    const { security } = setup();

    expect(await security.verifyAudit('srv-1')).toEqual({ intact: true, checked: 3 });
  });

  it('exports every page that matches, over one connection, to the file the user picked', async () => {
    const { security, hub, written, connections, deps } = setup();
    hub.queryAudit
      .mockResolvedValueOnce({ events: [event(3), event(2)], nextBeforeId: 2 })
      .mockResolvedValueOnce({ events: [event(1)] });

    const result = await security.exportAudit({
      serverId: 'srv-1',
      format: 'csv',
      filter: { action: 'auth.' },
    });

    expect(deps.pickExportPath).toHaveBeenCalledWith('csv', 'runova-audit-Prod-EU-2026-10-01.csv');
    expect(hub.queryAudit).toHaveBeenNthCalledWith(1, { action: 'auth.', limit: 200 });
    expect(hub.queryAudit).toHaveBeenNthCalledWith(2, { action: 'auth.', limit: 200, beforeId: 2 });
    expect(connections).toEqual(['srv-1']);
    expect(result).toEqual({
      saved: true,
      path: '/exports/runova-audit-Prod-EU-2026-10-01.csv',
      count: 3,
      truncated: false,
    });
    expect(written[0].content.split('\r\n').filter(Boolean)).toHaveLength(4);
  });

  it('writes JSON with what was asked for', async () => {
    const { security, written } = setup();

    await security.exportAudit({ serverId: 'srv-1', format: 'json', filter: { result: 'denied' } });

    const file = JSON.parse(written[0].content) as { server: string; filter: unknown };
    expect(written[0].path).toMatch(/\.json$/);
    expect(file.server).toBe('Prod / EU');
    expect(file.filter).toEqual({ result: 'denied' });
  });

  it('asks the core nothing when the save dialog is cancelled', async () => {
    const { security, hub, written } = setup({ pickExportPath: async () => null });

    expect(await security.exportAudit({ serverId: 'srv-1', format: 'json', filter: {} })).toEqual({
      saved: false,
    });
    expect(hub.queryAudit).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it('stops at its limit and says the file holds the newest events only', async () => {
    const { security, hub } = setup();
    let next = MAX_EXPORT_EVENTS + 500;
    hub.queryAudit.mockImplementation(async () => {
      const events = Array.from({ length: 200 }, () => event(next--));
      return { events, nextBeforeId: next + 1 };
    });

    const result = await security.exportAudit({ serverId: 'srv-1', format: 'csv', filter: {} });

    expect(result.count).toBe(MAX_EXPORT_EVENTS);
    expect(result.truncated).toBe(true);
  });
});
