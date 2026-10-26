import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope } from '../../shared/apiTypes';
import type {
  ChallengeResponse,
  SignedInResponse,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type { DeploySetupProgressEvent } from '../../shared/deployTypes';
import { tempDir } from '../../test/main/fixtures';
import type { CoreRest } from './auth/coreSessions';
import {
  ScriptedConnection,
  type ScriptedMachine,
  scriptedMachine,
} from './bootstrap/testing/scriptedServer';
import { CoreHttpError } from './connection/coreHttp';
import { DEV_SERVER_ID, DeployService, type DeployServiceDeps } from './service';
import { DeployState } from './state';

/**
 * This computer's access to a core: enrolled during the install (or later, over SSH), signed in
 * with the device key and a password, and able to manage two-factor through the hub. The device's
 * private key is sealed before it is stored and never goes anywhere else.
 */

const SHA = 'ab'.repeat(32);
const PASSWORD = 'correct horse battery staple';

const SAVED = [
  {
    id: 'srv-1',
    nickname: 'Production',
    host: 'prod.example',
    port: 22,
    username: 'deployer',
    authMethod: 'password' as const,
    secretEnvelope: { mode: 'safeStorage', ciphertext: 'x' },
  },
];

function releases() {
  const localPath = join(tempDir(), 'core.tar.gz');
  writeFileSync(localPath, 'tarball');
  return {
    release: async (rid: 'linux-x64' | 'linux-arm64') => ({
      version: '1.53.0',
      rid,
      file: `runova-core-1.53.0-${rid}.tar.gz`,
      sha256: SHA,
      localPath,
    }),
  };
}

/** Canned sign-in answers; the signatures themselves are checked in coreSessions.test.ts. */
function fakeRest() {
  const calls: Array<{ path: string; body: unknown }> = [];
  let refuse: string | null = null;
  let broken: string | null = null;
  const rest: CoreRest = {
    post: async <T>(path: string, body: unknown): Promise<T> => {
      calls.push({ path, body });
      if (broken) throw new Error(broken);
      if (refuse)
        throw new CoreHttpError('refused', 401, { code: refuse, message: `refused: ${refuse}` });
      if (path === '/api/v1/auth/challenge') {
        return {
          challengeId: 'c1',
          nonce: 'n1',
          expiresAtUnixMs: Date.now() + 60_000,
        } satisfies ChallengeResponse as T;
      }
      if (path === '/dev/enroll') return { deviceId: 'dev-device', userName: 'dev' } as T;
      return {
        sessionId: 'session-1',
        accessToken: 'token-1',
        accessTokenExpiresAtUnixMs: Date.now() + 15 * 60_000,
        user: { id: 'u1', userName: 'maria', roles: ['owner'], twoFactorEnabled: false },
      } satisfies SignedInResponse as T;
    },
  };
  return {
    rest,
    calls,
    refuse: (code: string | null) => {
      refuse = code;
    },
    breakWith: (message: string) => {
      broken = message;
    },
  };
}

function fakeHub() {
  const calls: string[] = [];
  const connections = { opened: 0, stopped: 0, refuse: [] as Error[] };
  const hub = {
    getAccount: vi.fn(async () => ({
      userName: 'maria',
      roles: ['owner'],
      twoFactorEnabled: false,
    })),
    signOut: vi.fn(async () => {
      calls.push('signOut');
    }),
    beginTotpSetup: vi.fn(async () => ({
      sharedKey: 'ABCD EFGH',
      authenticatorUri: 'otpauth://totp/Runova%3Amaria?secret=ABCDEFGH&issuer=Runova',
    })),
    confirmTotp: vi.fn(async (code: string) => {
      calls.push(`confirmTotp:${code}`);
      return { codes: ['aaaa-bbbb'] };
    }),
    disableTotp: vi.fn(async (code: string) => {
      calls.push(`disableTotp:${code}`);
    }),
    stepUp: vi.fn(async () => ({ stepUpUntilUnixMs: 1 })),
  } as unknown as ICoreHub;
  return { hub, calls, connections };
}

function setup(machine: Partial<ScriptedMachine> = {}, overrides: Partial<DeployServiceDeps> = {}) {
  const server = new ScriptedConnection(scriptedMachine(machine));
  const pool = {
    acquire: vi.fn(async () => ({ connection: server, release: () => undefined })),
    reset: vi.fn(),
  };
  let content: unknown = null;
  const state = new DeployState({
    read: async () => content,
    write: async (value) => {
      content = value;
    },
  });
  const sealed: string[] = [];
  const core = fakeRest();
  const hub = fakeHub();
  const events: DeploySetupProgressEvent[] = [];
  const transports: string[] = [];
  const deps: DeployServiceDeps = {
    servers: async () => SAVED,
    pool,
    state,
    releases: releases(),
    availableVersion: async () => '1.53.0',
    devCorePort: null,
    progress: (event) => events.push(event),
    healthOf: async () => ({ status: 'ok', version: '1.53.0', apiVersion: 1, startedAtUnixMs: 1 }),
    seal: async (plaintext) => {
      sealed.push(plaintext);
      return {
        mode: 'safeStorage',
        ciphertext: Buffer.from(plaintext).toString('base64'),
      } satisfies SecretEnvelope;
    },
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    deviceName: () => 'Maria-PC',
    rest: (transport) => {
      transports.push(transport.kind);
      return core.rest;
    },
    hub: async (transport, accessToken) => {
      transports.push(transport.kind);
      await accessToken();
      const refusal = hub.connections.refuse.shift();
      if (refusal) throw refusal;
      hub.connections.opened += 1;
      return {
        hub: hub.hub,
        stop: async () => {
          hub.connections.stopped += 1;
        },
      };
    },
    ...overrides,
  };
  return {
    service: new DeployService(deps),
    server,
    state,
    sealed,
    core,
    hub,
    events,
    transports,
  };
}

function signInStep(events: DeploySetupProgressEvent[]) {
  return events
    .map((event) => event.progress)
    .filter((progress) => progress.phase === 'sign-in')
    .at(-1);
}

describe('DeployService install with an account', () => {
  it('tells the alert watcher when the servers it should watch change', async () => {
    const serversChanged = vi.fn();
    const { service } = setup({}, { serversChanged });

    await service.install({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });
    expect(serversChanged).toHaveBeenCalledTimes(1);

    await service.uninstall({ serverId: 'srv-1', sudoPassword: 'deployer-pw', keepData: false });
    expect(serversChanged).toHaveBeenCalledTimes(2);
  });

  it('creates the owner, enrolls this computer and signs it in', async () => {
    const { service, server, state, sealed, events } = setup();

    const result = await service.install({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });

    expect(result.enrollmentError).toBeUndefined();
    const device = await state.device('srv-1');
    expect(device).toMatchObject({
      deviceId: 'device-1',
      userName: 'maria',
      sessionId: 'session-1',
    });
    // Only the sealed form of the key is stored, and it went through the vault.
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(JSON.stringify(device)).not.toContain('BEGIN PRIVATE KEY');
    expect(
      server.rootCommands.some((command) =>
        command.includes('enroll-device --user maria --name Maria-PC'),
      ),
    ).toBe(true);
    const phases = events
      .filter((event) => event.progress.status === 'done')
      .map((event) => event.progress.phase);
    expect(phases.slice(-3)).toEqual(['owner', 'enroll', 'sign-in']);
    expect(await service.access('srv-1')).toEqual({
      state: 'signed-in',
      user: { userName: 'maria', roles: ['owner'], twoFactorEnabled: false },
    });
    expect((await service.listServers())[0].enrolled).toBe(true);
  });

  it('keeps the install when the account cannot be set up, and says why', async () => {
    const { service, state } = setup({
      ownerPasswordRefusal: 'That password is too common; it appears in lists attackers try first.',
    });

    const result = await service.install({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });

    expect(result.version).toBe('1.53.0');
    expect(result.enrollmentError).toMatch(/too common/);
    expect(await state.get('srv-1')).not.toBeNull();
    expect((await service.access('srv-1')).state).toBe('not-enrolled');
  });
});

describe('DeployService enrollment, then the sign-in', () => {
  it('enrolls an account that has two-factor and leaves the code for the server card', async () => {
    const { service, core, events, state } = setup({
      coreUsers: [{ userName: 'maria', roles: ['owner'] }],
    });
    await service.install({ serverId: 'srv-1', sudoPassword: 'deployer-pw' });
    core.refuse('totpRequired');

    const access = await service.enroll({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });

    expect(signInStep(events)).toMatchObject({
      status: 'done',
      detail: 'Enter a code from your authenticator app on the server card to finish signing in.',
    });
    expect((await state.device('srv-1'))?.deviceId).toBe('device-1');
    expect(access.state).toBe('needs-sign-in');
  });

  it('keeps the install when the sign-in after enrolling is refused, and says why in words', async () => {
    const { service, core, events } = setup();
    core.refuse('rateLimited');

    const result = await service.install({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });

    expect(result.version).toBe('1.53.0');
    expect(result.enrollmentError).toBe('refused: rateLimited');
    expect(signInStep(events)).toMatchObject({ status: 'failed', detail: 'refused: rateLimited' });
  });
});

describe('DeployService access', () => {
  async function installed(machine: Partial<ScriptedMachine> = {}) {
    const context = setup(machine);
    await context.service.install({ serverId: 'srv-1', sudoPassword: 'deployer-pw' });
    return context;
  }

  it('is not enrolled until this computer has a device on the core', async () => {
    const { service } = await installed();

    expect((await service.access('srv-1')).state).toBe('not-enrolled');
  });

  it('enrolls over SSH later, for a user the core already has', async () => {
    const { service, state } = await installed({
      coreUsers: [{ userName: 'maria', roles: ['owner'] }],
    });

    const access = await service.enroll({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });

    expect(access.state).toBe('signed-in');
    expect((await state.device('srv-1'))?.deviceId).toBe('device-1');
  });

  it('asks for a sign-in once the session has ended, and a new enrollment for a revoked device', async () => {
    const { service, core } = await installed({
      coreUsers: [{ userName: 'maria', roles: ['owner'] }],
    });
    await service.enroll({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });
    await service.signOut('srv-1');

    expect((await service.access('srv-1')).state).toBe('needs-sign-in');

    await service.signIn({ serverId: 'srv-1', password: PASSWORD });
    service.forgetTokens('srv-1');
    core.refuse('deviceRevoked');
    expect((await service.access('srv-1')).state).toBe('needs-re-enroll');
  });

  it("passes a locked account's reason on in words, without the code", async () => {
    const { service, core } = await installed({
      coreUsers: [{ userName: 'maria', roles: ['owner'] }],
    });
    await service.enroll({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });
    service.forgetTokens('srv-1');
    core.refuse('lockedOut');

    expect(await service.access('srv-1')).toEqual({
      state: 'needs-sign-in',
      message: 'refused: lockedOut',
    });
  });

  it('passes a refused sign-in on as a code', async () => {
    const { service, core } = await installed({
      coreUsers: [{ userName: 'maria', roles: ['owner'] }],
    });
    await service.enroll({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });
    core.refuse('totpRequired');

    await expect(service.signIn({ serverId: 'srv-1', password: PASSWORD })).rejects.toThrow(
      '[core:totpRequired]',
    );
  });

  it('turns a new authenticator key into a QR code', async () => {
    const { service } = await installed({ coreUsers: [{ userName: 'maria', roles: ['owner'] }] });
    await service.enroll({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });

    const setupInfo = await service.beginTotp('srv-1');

    expect(setupInfo.sharedKey).toBe('ABCD EFGH');
    expect(setupInfo.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('enrolls with the DevHost by itself, since it has no SSH', async () => {
    const { service, core, state } = setup({}, { devCorePort: 7810 });

    const access = await service.access(DEV_SERVER_ID);

    expect(access.state).toBe('needs-sign-in');
    expect(core.calls[0].path).toBe('/dev/enroll');
    expect((await state.device(DEV_SERVER_ID))?.userName).toBe('dev');
  });

  it('says what went wrong when the core cannot be reached', async () => {
    const { service, core } = await installed({
      coreUsers: [{ userName: 'maria', roles: ['owner'] }],
    });
    await service.enroll({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });
    service.forgetTokens('srv-1');
    core.breakWith('Could not open a tunnel to /run/runova-core/core.sock');

    const access = await service.access('srv-1');

    expect(access).toEqual({
      state: 'unreachable',
      message: 'Could not open a tunnel to /run/runova-core/core.sock',
    });
  });
});

describe('DeployService account and two-factor', () => {
  async function signedIn(overrides: Partial<DeployServiceDeps> = {}) {
    const context = setup({ coreUsers: [{ userName: 'maria', roles: ['owner'] }] }, overrides);
    await context.service.install({ serverId: 'srv-1', sudoPassword: 'deployer-pw' });
    await context.service.enroll({
      serverId: 'srv-1',
      sudoPassword: 'deployer-pw',
      account: { userName: 'maria', password: PASSWORD },
    });
    return context;
  }

  it('turns two-factor on and off, and keeps the signed-in user current', async () => {
    const { service, hub } = await signedIn();

    expect(await service.confirmTotp('srv-1', '123456')).toEqual({ codes: ['aaaa-bbbb'] });
    expect((await service.access('srv-1')).user?.twoFactorEnabled).toBe(true);
    await service.disableTotp('srv-1', '654321');

    expect(hub.calls).toEqual(['confirmTotp:123456', 'disableTotp:654321']);
    expect((await service.access('srv-1')).user?.twoFactorEnabled).toBe(false);
  });

  it('steps up with the password or a code, whichever was given', async () => {
    const { service, hub } = await signedIn();

    await service.stepUp({ serverId: 'srv-1', password: PASSWORD });
    await service.stepUp({ serverId: 'srv-1', totpCode: '123456' });

    expect(hub.hub.stepUp).toHaveBeenNthCalledWith(1, { password: PASSWORD });
    expect(hub.hub.stepUp).toHaveBeenNthCalledWith(2, { totpCode: '123456' });
  });

  describe('a remembered password', () => {
    const HUB_REFUSAL = new Error(
      "An unexpected error occurred invoking 'StepUp' on the server. HubException: That is not right.",
    );

    it('is checked with the core, then kept sealed and never as plain text', async () => {
      const { service, hub, state, sealed } = await signedIn();

      await service.rememberPassword({ serverId: 'srv-1', password: PASSWORD });

      expect(hub.hub.stepUp).toHaveBeenCalledWith({ password: PASSWORD });
      expect(sealed).toContain(PASSWORD);
      const device = await state.device('srv-1');
      expect(device?.password).toMatchObject({ mode: 'safeStorage' });
      expect(JSON.stringify(device)).not.toContain(`"${PASSWORD}"`);
      expect(await service.access('srv-1')).toMatchObject({
        state: 'signed-in',
        passwordSaved: true,
      });
    });

    it('is not kept when the core says it is wrong', async () => {
      const { service, hub, state } = await signedIn();
      vi.mocked(hub.hub.stepUp).mockRejectedValueOnce(HUB_REFUSAL);

      await expect(
        service.rememberPassword({ serverId: 'srv-1', password: 'wrong' }),
      ).rejects.toThrow('That is not right.');

      expect((await state.device('srv-1'))?.password).toBeUndefined();
      expect((await service.access('srv-1')).passwordSaved).toBeUndefined();
    });

    it('answers the core for the user, so nobody is asked', async () => {
      const { service, hub } = await signedIn();
      await service.rememberPassword({ serverId: 'srv-1', password: PASSWORD });
      vi.mocked(hub.hub.stepUp).mockClear();

      await expect(service.stepUpWithSavedPassword('srv-1')).resolves.toEqual({
        stepUpUntilUnixMs: 1,
      });
      expect(hub.hub.stepUp).toHaveBeenCalledExactlyOnceWith({ password: PASSWORD });
    });

    it('has nothing to answer with when none was kept, and does not call the core', async () => {
      const { service, hub } = await signedIn();

      await expect(service.stepUpWithSavedPassword('srv-1')).resolves.toBeNull();
      expect(hub.hub.stepUp).not.toHaveBeenCalled();
    });

    it('is forgotten when the core no longer accepts it, so it is not tried over and over', async () => {
      const { service, hub, state } = await signedIn();
      await service.rememberPassword({ serverId: 'srv-1', password: PASSWORD });
      vi.mocked(hub.hub.stepUp).mockRejectedValueOnce(HUB_REFUSAL);

      await expect(service.stepUpWithSavedPassword('srv-1')).resolves.toBeNull();

      expect((await state.device('srv-1'))?.password).toBeUndefined();
      await expect(service.stepUpWithSavedPassword('srv-1')).resolves.toBeNull();
    });

    it('is kept when the core could not be reached, since the password may still be right', async () => {
      const { service, hub, state } = await signedIn();
      await service.rememberPassword({ serverId: 'srv-1', password: PASSWORD });
      vi.mocked(hub.hub.stepUp).mockRejectedValueOnce(new Error('WebSocket closed'));

      await expect(service.stepUpWithSavedPassword('srv-1')).resolves.toBeNull();

      expect((await state.device('srv-1'))?.password).toBeDefined();
    });

    it('asks instead when the vault is locked', async () => {
      let locked = false;
      const { service, hub } = await signedIn({
        unseal: async (envelope) => {
          if (locked) throw new Error('The vault is locked.');
          return Buffer.from(envelope.ciphertext, 'base64').toString();
        },
      });
      await service.rememberPassword({ serverId: 'srv-1', password: PASSWORD });
      vi.mocked(hub.hub.stepUp).mockClear();
      locked = true;

      await expect(service.stepUpWithSavedPassword('srv-1')).resolves.toBeNull();
      expect(hub.hub.stepUp).not.toHaveBeenCalled();
    });

    it('can be forgotten by the user', async () => {
      const { service, state } = await signedIn();
      await service.rememberPassword({ serverId: 'srv-1', password: PASSWORD });

      await service.forgetPassword('srv-1');

      expect((await state.device('srv-1'))?.password).toBeUndefined();
      expect((await service.access('srv-1')).passwordSaved).toBeUndefined();
      // The device itself stays enrolled.
      expect(await state.device('srv-1')).not.toBeNull();
    });

    it('goes with signing out, which leaves the device enrolled', async () => {
      const { service, state } = await signedIn();
      await service.rememberPassword({ serverId: 'srv-1', password: PASSWORD });

      await service.signOut('srv-1');

      const device = await state.device('srv-1');
      expect(device).not.toBeNull();
      expect(device?.password).toBeUndefined();
    });

    it('is not asked to be remembered without a password', async () => {
      const { service } = await signedIn();

      await expect(
        service.rememberPassword({ serverId: 'srv-1', totpCode: '123456' }),
      ).rejects.toThrow(/Enter your password/);
    });
  });

  it('reads the account through a hub connection it closes again', async () => {
    const { service, hub } = await signedIn();

    expect(await service.account('srv-1')).toMatchObject({ userName: 'maria' });
    expect(hub.connections).toMatchObject({ opened: 1, stopped: 1 });
  });

  it("passes on the core's own words when the hub refuses, and still closes the connection", async () => {
    const { service, hub } = await signedIn();
    vi.mocked(hub.hub.stepUp)
      .mockRejectedValueOnce(
        new Error(
          "An unexpected error occurred invoking 'StepUp' on the server. HubException: That is not right.",
        ),
      )
      .mockRejectedValueOnce(new Error('WebSocket closed with status code: 1006.'));

    await expect(service.stepUp({ serverId: 'srv-1', password: 'wrong' })).rejects.toThrow(
      /^That is not right\.$/,
    );
    await expect(service.stepUp({ serverId: 'srv-1', password: 'wrong' })).rejects.toThrow(
      /^WebSocket closed with status code: 1006\.$/,
    );
    expect(hub.connections).toMatchObject({ opened: 2, stopped: 2 });
  });

  it('signs out here even when the core cannot be told', async () => {
    const { service, hub, state } = await signedIn();
    vi.mocked(hub.hub.signOut).mockRejectedValueOnce(new Error('WebSocket closed'));

    await service.signOut('srv-1');

    expect((await state.device('srv-1'))?.sessionId).toBeUndefined();
    expect((await service.access('srv-1')).state).toBe('needs-sign-in');
    // A second sign-out has nothing left to end.
    await expect(service.signOut('srv-1')).resolves.toBeUndefined();
  });

  it('sends a code from the authenticator app, or a recovery code, along with the password', async () => {
    const { service, core } = await signedIn();

    await service.signIn({ serverId: 'srv-1', password: PASSWORD, totpCode: '123456' });
    await service.signIn({ serverId: 'srv-1', password: PASSWORD, recoveryCode: 'k3v9x-q2m7p' });

    const logins = core.calls
      .filter((call) => call.path === '/api/v1/auth/login')
      .map((call) => call.body);
    expect(logins.at(-2)).toMatchObject({ totpCode: '123456', recoveryCode: undefined });
    expect(logins.at(-1)).toMatchObject({ recoveryCode: 'k3v9x-q2m7p', totpCode: undefined });
  });

  it('reaches the core through the bridge once sshd stops allowing the tunnel', async () => {
    const { service, state, transports } = await signedIn();
    const record = await state.get('srv-1');
    if (!record) throw new Error('no core record');
    await state.set('srv-1', { ...record, transport: 'bridge' });
    transports.length = 0;

    await service.account('srv-1');

    expect(transports).toEqual(['bridge']);
  });

  it('says so when there is no core to ask', async () => {
    const { service } = setup();

    await expect(service.account('srv-1')).rejects.toThrow(
      'The server core is not installed on this server yet.',
    );
  });

  it('signs in to the DevHost over its loopback port and enrolls only once', async () => {
    const { service, core, transports } = setup({}, { devCorePort: 7810 });

    await service.access(DEV_SERVER_ID);
    const access = await service.signIn({
      serverId: DEV_SERVER_ID,
      password: 'runova-local-password',
    });
    await service.access(DEV_SERVER_ID);

    expect(access.state).toBe('signed-in');
    expect(core.calls.filter((call) => call.path === '/dev/enroll')).toHaveLength(1);
    expect(new Set(transports)).toEqual(new Set(['dev-tcp']));
  });

  it('finds out on its next hub call that the device was revoked, not only at renewal', async () => {
    const { service, hub, core } = await signedIn();
    // The core turns the connection away (its token outlived the device), then says why on renewal.
    hub.connections.refuse.push(new Error('WebSocket failed to connect.'));
    core.refuse('deviceRevoked');

    const failure = await service
      .stepUp({ serverId: 'srv-1', password: PASSWORD })
      .catch((error: unknown) => error);

    expect(String(failure)).toContain('[core:deviceRevoked]');
    expect((await service.access('srv-1')).state).toBe('needs-re-enroll');
  });

  it('tries a refused connection once more with a renewed token', async () => {
    const { service, hub, core } = await signedIn();
    hub.connections.refuse.push(new Error('WebSocket failed to connect.'));
    const renewals = () => core.calls.filter((call) => call.path === '/api/v1/auth/renew').length;
    const before = renewals();

    await expect(service.account('srv-1')).resolves.toMatchObject({ userName: 'maria' });

    expect(renewals()).toBe(before + 1);
  });

  it('gives up after the second refusal with what went wrong', async () => {
    const { service, hub } = await signedIn();
    hub.connections.refuse.push(
      new Error('WebSocket failed to connect.'),
      new Error('WebSocket failed to connect.'),
    );

    await expect(service.account('srv-1')).rejects.toThrow('WebSocket failed to connect.');
  });
});
