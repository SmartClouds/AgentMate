import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import { coreErrorCode, coreErrorMessage } from '../../../shared/coreErrors';
import type {
  AuthErrorCode,
  ChallengeRequest,
  LoginRequest,
  RenewRequest,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { CoreHttpError } from '../connection/coreHttp';
import { LEGACY_CORE, RUNOVA_CORE } from '../coreLayout';
import { DeployState } from '../state';
import { type CoreRest, CoreSessions } from './coreSessions';
import { authMessage, createDeviceKey } from './deviceKey';

/**
 * Signing in to a server core and staying signed in: the device key signs every challenge, the
 * password is only ever sent to sign in, and a token is renewed with a fresh signature a minute
 * before it runs out. What the core refuses comes back as a code the Deploy page can act on.
 */

const MINUTE = 60_000;

/** Enough of the core's sign-in to check what the app sends, signatures included. */
function fakeCore(publicKey: string, clock: { now: number }) {
  const issued = new Map<
    string,
    { nonce: string; deviceId: string; purpose: string; sessionId: string | null }
  >();
  const seen: Array<{ path: string; body: unknown }> = [];
  let refuse: AuthErrorCode | null = null;
  let totpRequired = false;
  let tokenCount = 0;
  const key = createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });

  const refusal = (code: AuthErrorCode) =>
    new CoreHttpError('The server core refused (401).', 401, { code, message: `refused: ${code}` });

  const signedCorrectly = (
    challengeId: string,
    deviceId: string,
    purpose: 'login' | 'renew',
    sessionId: string | null,
    signature: string,
  ) => {
    const challenge = issued.get(challengeId);
    issued.delete(challengeId);
    if (!challenge || challenge.purpose !== purpose || challenge.deviceId !== deviceId)
      return false;
    // Like the core, either prefix: the app signs with the old one until it knows the core is new.
    return [RUNOVA_CORE.authPrefix, LEGACY_CORE.authPrefix].some((prefix) =>
      verify(
        'sha256',
        Buffer.from(
          authMessage(purpose, challengeId, challenge.nonce, deviceId, sessionId, prefix),
        ),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64'),
      ),
    );
  };

  const rest: CoreRest = {
    post: async <T>(path: string, body: unknown): Promise<T> => {
      seen.push({ path, body });
      if (refuse) throw refusal(refuse);
      if (path === '/api/v1/auth/challenge') {
        const request = body as ChallengeRequest;
        const challengeId = randomUUID();
        issued.set(challengeId, {
          nonce: `nonce-${challengeId.slice(0, 4)}`,
          deviceId: request.deviceId,
          purpose: request.purpose,
          sessionId: request.sessionId ?? null,
        });
        return {
          challengeId,
          nonce: issued.get(challengeId)!.nonce,
          expiresAtUnixMs: clock.now + MINUTE,
        } as T;
      }
      tokenCount += 1;
      const answer = (sessionId: string) =>
        ({
          sessionId,
          accessToken: `token-${tokenCount}`,
          accessTokenExpiresAtUnixMs: clock.now + 15 * MINUTE,
          user: { id: 'u1', userName: 'maria', roles: ['owner'], twoFactorEnabled: totpRequired },
        }) as T;
      if (path === '/api/v1/auth/login') {
        const request = body as LoginRequest;
        if (
          !signedCorrectly(request.challengeId, request.deviceId, 'login', null, request.signature)
        ) {
          throw refusal('invalidCredentials');
        }
        if (request.password !== 'correct horse battery staple')
          throw refusal('invalidCredentials');
        if (totpRequired && !request.totpCode) throw refusal('totpRequired');
        return answer('session-1');
      }
      if (path === '/api/v1/auth/renew') {
        const request = body as RenewRequest;
        const deviceId = [...seen]
          .reverse()
          .find((entry) => entry.path === '/api/v1/auth/challenge')!.body as ChallengeRequest;
        if (
          !signedCorrectly(
            request.challengeId,
            deviceId.deviceId,
            'renew',
            request.sessionId,
            request.signature,
          )
        ) {
          throw refusal('invalidCredentials');
        }
        return answer(request.sessionId);
      }
      throw new Error(`unexpected ${path}`);
    },
  };

  return {
    rest,
    seen,
    refuse: (code: AuthErrorCode | null) => {
      refuse = code;
    },
    requireTotp: () => {
      totpRequired = true;
    },
  };
}

async function setup(options: { enrolled?: boolean; sessionId?: string } = {}) {
  const key = createDeviceKey();
  const clock = { now: 1_700_000_000_000 };
  let content: unknown = null;
  const state = new DeployState({
    read: async () => content,
    write: async (value) => {
      content = value;
    },
  });
  if (options.enrolled !== false) {
    await state.setDevice('srv-1', {
      deviceId: 'device-1',
      userName: 'maria',
      privateKey: {
        mode: 'safeStorage',
        ciphertext: Buffer.from(key.privateKeyPem).toString('base64'),
      },
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    });
  }
  const core = fakeCore(key.publicKey, clock);
  const sessions = new CoreSessions({
    state,
    unseal: async (envelope: SecretEnvelope) =>
      Buffer.from(envelope.ciphertext, 'base64').toString(),
    withCore: (_serverId, work) => work(core.rest),
    now: () => clock.now,
  });
  return { sessions, state, core, clock };
}

const PASSWORD = 'correct horse battery staple';

describe('CoreSessions.signIn', () => {
  it('signs a login challenge with the device key and keeps the new session', async () => {
    const { sessions, state, core } = await setup();

    const user = await sessions.signIn('srv-1', { password: PASSWORD });

    expect(user.userName).toBe('maria');
    expect(core.seen.map((entry) => entry.path)).toEqual([
      '/api/v1/auth/challenge',
      '/api/v1/auth/login',
    ]);
    expect(core.seen[0].body).toEqual({ deviceId: 'device-1', purpose: 'login' });
    expect((await state.device('srv-1'))?.sessionId).toBe('session-1');
    expect(await sessions.accessToken('srv-1')).toBe('token-1');
  });

  it('passes on what the core refused, as a code', async () => {
    const { sessions, core } = await setup();
    core.requireTotp();

    const failure = await sessions
      .signIn('srv-1', { password: PASSWORD })
      .catch((error: unknown) => error);

    expect(coreErrorCode(failure)).toBe('totpRequired');
  });

  it('says so when this computer has no device on the core', async () => {
    const { sessions } = await setup({ enrolled: false });

    const failure = await sessions
      .signIn('srv-1', { password: PASSWORD })
      .catch((error: unknown) => error);

    expect(coreErrorCode(failure)).toBe('notEnrolled');
  });
});

describe('CoreSessions.accessToken', () => {
  it('reuses a token while it has more than a minute left', async () => {
    const { sessions, core, clock } = await setup();
    await sessions.signIn('srv-1', { password: PASSWORD });
    clock.now += 13 * MINUTE;

    expect(await sessions.accessToken('srv-1')).toBe('token-1');
    expect(core.seen).toHaveLength(2);
  });

  it('renews with a fresh signature, and no password, when the token is about to run out', async () => {
    const { sessions, core, clock } = await setup();
    await sessions.signIn('srv-1', { password: PASSWORD });
    clock.now += 14.5 * MINUTE;

    const token = await sessions.accessToken('srv-1');

    expect(token).toBe('token-2');
    const renewal = core.seen.at(-1)!;
    expect(renewal.path).toBe('/api/v1/auth/renew');
    expect(JSON.stringify(renewal.body)).not.toContain(PASSWORD);
    expect(core.seen.at(-2)?.body).toEqual({
      deviceId: 'device-1',
      purpose: 'renew',
      sessionId: 'session-1',
    });
  });

  it('renews a session kept from an earlier run of the app', async () => {
    const { sessions } = await setup({ sessionId: 'session-9' });

    expect(await sessions.accessToken('srv-1')).toBe('token-1');
  });

  it('needs a sign-in when there is no session, and forgets one the core ended', async () => {
    const withoutSession = await setup();
    expect(
      coreErrorCode(await withoutSession.sessions.accessToken('srv-1').catch((e: unknown) => e)),
    ).toBe('sessionExpired');

    const { sessions, state, core } = await setup({ sessionId: 'session-9' });
    core.refuse('sessionRevoked');
    expect(coreErrorCode(await sessions.accessToken('srv-1').catch((e: unknown) => e))).toBe(
      'sessionRevoked',
    );
    expect((await state.device('srv-1'))?.sessionId).toBeUndefined();
  });

  it('tells a revoked device to enroll again', async () => {
    const { sessions, core } = await setup({ sessionId: 'session-9' });
    core.refuse('deviceRevoked');

    expect(coreErrorCode(await sessions.accessToken('srv-1').catch((e: unknown) => e))).toBe(
      'deviceRevoked',
    );
  });

  it('asks the core once when several callers need a token at the same time', async () => {
    const { sessions, core } = await setup({ sessionId: 'session-9' });

    const tokens = await Promise.all([
      sessions.accessToken('srv-1'),
      sessions.accessToken('srv-1'),
    ]);

    expect(tokens).toEqual(['token-1', 'token-1']);
    expect(core.seen.filter((entry) => entry.path === '/api/v1/auth/renew')).toHaveLength(1);
  });

  it('drops the token when told to forget the server', async () => {
    const { sessions } = await setup();
    await sessions.signIn('srv-1', { password: PASSWORD });

    sessions.forget('srv-1');

    expect(sessions.user('srv-1')).toBeNull();
  });
});

describe('CoreSessions.expiresAt', () => {
  it('says when the token in hand runs out, so a lasting connection can move to a fresh one', async () => {
    const { sessions, clock } = await setup();
    expect(sessions.expiresAt('srv-1')).toBeNull();
    const signedInAt = clock.now;

    await sessions.signIn('srv-1', { password: PASSWORD });
    expect(sessions.expiresAt('srv-1')).toBe(signedInAt + 15 * MINUTE);

    clock.now += 14.5 * MINUTE;
    await sessions.accessToken('srv-1');
    expect(sessions.expiresAt('srv-1')).toBe(clock.now + 15 * MINUTE);

    sessions.forget('srv-1');
    expect(sessions.expiresAt('srv-1')).toBeNull();
  });
});

describe('CoreSessions.patchUser', () => {
  it('keeps what the app shows about the user current after a change on the core', async () => {
    const { sessions } = await setup();
    await sessions.signIn('srv-1', { password: PASSWORD });

    sessions.patchUser('srv-1', { twoFactorEnabled: true });

    expect(sessions.user('srv-1')).toMatchObject({ userName: 'maria', twoFactorEnabled: true });
  });

  it('leaves a server with no one signed in alone', async () => {
    const { sessions } = await setup();

    sessions.patchUser('srv-1', { twoFactorEnabled: true });

    expect(sessions.user('srv-1')).toBeNull();
  });
});

describe('CoreSessions refusals', () => {
  /** A core that fails every request the same way, on the real clock. */
  async function failingWith(error: unknown): Promise<unknown> {
    const { state } = await setup();
    const sessions = new CoreSessions({
      state,
      unseal: async (envelope: SecretEnvelope) =>
        Buffer.from(envelope.ciphertext, 'base64').toString(),
      withCore: (_serverId, work) =>
        work({
          post: async () => {
            throw error;
          },
        }),
    });
    return sessions.signIn('srv-1', { password: PASSWORD }).catch((failure: unknown) => failure);
  }

  it('keeps the code of a refusal that comes without words', async () => {
    const failure = await failingWith(
      new CoreHttpError('The server core refused (401).', 401, { code: 'invalidCredentials' }),
    );

    expect(coreErrorCode(failure)).toBe('invalidCredentials');
    expect(coreErrorMessage(failure)).toBe('The server core refused (401).');
  });

  it('passes on a refusal without a code it knows just as it came', async () => {
    const unknownCode = new CoreHttpError('The server core refused (400).', 400, {
      code: 'launchRockets',
      message: 'No.',
    });
    const plainText = new CoreHttpError('The server core answered 502.', 502, 'Bad gateway');

    expect(await failingWith(unknownCode)).toBe(unknownCode);
    expect(await failingWith(plainText)).toBe(plainText);
  });

  it('passes on a failure that never reached the core just as it came', async () => {
    const offline = new Error('Could not open a tunnel to /run/runova-core/core.sock');

    expect(await failingWith(offline)).toBe(offline);
  });
});
