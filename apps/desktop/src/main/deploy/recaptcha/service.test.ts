import { describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import type {
  RecaptchaKey,
  RecaptchaKeyInput,
  RecaptchaSetupProgress,
} from '../../../shared/deployRecaptchaTypes';
import { encodeRecaptchaError, recaptchaErrorCode } from '../../../shared/recaptchaErrors';
import { GOOGLE_CLOUD_PROVIDER } from '../../google/provider';
import { GoogleCloudState, type GoogleCloudStatePort } from '../../google/state';
import { GoogleTokens } from '../../google/tokens';
import type { LoopbackSignInRequest, LoopbackTokens } from '../../oauth/loopback';
import type { RecaptchaApi } from './service';
import { RecaptchaService } from './service';

/**
 * The reCAPTCHA page's main-process side: Google sign-ins kept sealed, a project made ready, and
 * the project's keys managed. No token ever comes back out of it.
 */

function memoryPort(): GoogleCloudStatePort & { value: unknown } {
  const port = {
    value: null as unknown,
    read: async () => port.value,
    write: async (value: unknown) => {
      port.value = JSON.parse(JSON.stringify(value));
    },
  };
  return port;
}

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

const KEY: RecaptchaKey = {
  id: '6LcKey1',
  name: 'Shop',
  type: 'score',
  domains: ['shop.com'],
  allowAllDomains: false,
  challenge: null,
  createdAt: '2026-10-01T10:00:00Z',
};

class FakeGoogle implements RecaptchaApi {
  enabled = new Set<string>(['ready-project']);
  keyList: RecaptchaKey[] = [KEY];
  tokensSeen: string[] = [];
  failWith: Error | null = null;
  constructor(private readonly accessToken: () => Promise<string>) {}
  private async touch(): Promise<void> {
    this.tokensSeen.push(await this.accessToken());
    if (this.failWith) throw this.failWith;
  }
  projects = vi.fn(async () => {
    await this.touch();
    return [{ projectId: 'ready-project', name: 'Ready' }];
  });
  createProject = vi.fn(async (projectId: string, name: string) => {
    await this.touch();
    return { projectId, name };
  });
  apiEnabled = vi.fn(async (projectId: string) => {
    await this.touch();
    return this.enabled.has(projectId);
  });
  enableApi = vi.fn(async (projectId: string) => {
    await this.touch();
    this.enabled.add(projectId);
  });
  keys = vi.fn(async (_projectId: string) => {
    await this.touch();
    return this.keyList;
  });
  createKey = vi.fn(async (_projectId: string, input: RecaptchaKeyInput) => {
    await this.touch();
    return { ...KEY, id: '6LcNew', name: input.name, domains: input.domains, type: input.type };
  });
  updateKey = vi.fn(async () => {
    await this.touch();
    return KEY;
  });
  deleteKey = vi.fn(async () => {
    await this.touch();
  });
  legacySecret = vi.fn(async () => {
    await this.touch();
    return '6LcSecret';
  });
  metrics = vi.fn(async (_projectId: string, keyId: string) => {
    await this.touch();
    return {
      startTime: '2026-10-01T07:00:00Z',
      scoreMetrics: [
        { overallMetrics: { scoreBuckets: { '50': keyId === '6LcKey1' ? '40' : '2' } } },
      ],
    };
  });
}

function setup(options: { runovaClient?: boolean; locked?: () => boolean } = {}) {
  const port = memoryPort();
  const state = new GoogleCloudState(port);
  const refreshFetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ access_token: 'renewed-access', expires_in: 3600 }), {
        status: 200,
      }),
  );
  const tokens = new GoogleTokens({ fetch: refreshFetch, now: () => 0 });
  let google: FakeGoogle | null = null;
  const signIn = vi.fn(
    async (_request: LoopbackSignInRequest, _signal: AbortSignal): Promise<LoopbackTokens> => ({
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresIn: 3600,
      idToken: idToken({ email: 'amin@example.com' }),
    }),
  );
  const revoke = vi.fn(async (_token: string) => undefined);
  const progress: RecaptchaSetupProgress[] = [];
  const service = new RecaptchaService({
    state,
    tokens,
    seal: async (plain): Promise<SecretEnvelope> => ({
      mode: 'safeStorage',
      ciphertext: Buffer.from(plain).toString('base64'),
    }),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    isLocked: () => options.locked?.() ?? false,
    signIn,
    revoke,
    runovaClient:
      options.runovaClient === false
        ? null
        : { clientId: 'runova.apps.googleusercontent.com', clientSecret: 'GOCSPX-runova' },
    client: (accessToken) => {
      google ??= new FakeGoogle(accessToken);
      return google;
    },
    onProgress: (event) => progress.push(event),
    now: () => new Date('2026-10-02T18:00:00Z'),
  });
  return {
    service,
    port,
    state,
    signIn,
    revoke,
    refreshFetch,
    progress,
    google: () => {
      if (!google) throw new Error('no client made yet');
      return google;
    },
  };
}

async function signedIn(options: Parameters<typeof setup>[0] = {}) {
  const world = setup(options);
  const account = await world.service.signIn({ mode: 'runova' });
  return { ...world, account };
}

describe('status', () => {
  it('starts empty and says whether the one-click sign-in exists', async () => {
    expect(await setup().service.status()).toEqual({
      runovaClient: true,
      locked: false,
      accounts: [],
    });
    expect((await setup({ runovaClient: false }).service.status()).runovaClient).toBe(false);
  });
});

describe('signIn', () => {
  it('signs in with Runova client and the cloud-platform scope, and keeps the token sealed', async () => {
    const { service, signIn, port, account } = await signedIn();
    const [request] = signIn.mock.calls[0] ?? [];
    expect(request?.provider).toBe(GOOGLE_CLOUD_PROVIDER);
    expect(request?.provider.scope).toContain('https://www.googleapis.com/auth/cloud-platform');
    expect(request?.clientId).toBe('runova.apps.googleusercontent.com');
    expect(request?.clientSecret).toBe('GOCSPX-runova');
    expect(account).toMatchObject({
      email: 'amin@example.com',
      clientMode: 'runova',
      projectId: null,
    });

    const status = await service.status();
    expect(status.accounts).toEqual([account]);
    const disk = JSON.stringify(port.value);
    expect(disk).not.toContain('refresh-1');
    expect(disk).not.toContain('GOCSPX-runova');
    expect(JSON.stringify(status)).not.toMatch(/refresh-1|access-1|GOCSPX/);
  });

  it('signs in with the user own client and seals its secret too', async () => {
    const { service, signIn, port } = setup();
    const account = await service.signIn({
      mode: 'own',
      clientId: 'mine',
      clientSecret: 'my-secret',
    });
    expect(signIn.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'mine',
      clientSecret: 'my-secret',
    });
    expect(account.clientMode).toBe('own');
    expect(JSON.stringify(port.value)).not.toContain('my-secret');
  });

  it('needs the user own client in a build without Runova client', async () => {
    await expect(setup({ runovaClient: false }).service.signIn({ mode: 'runova' })).rejects.toThrow(
      /Use your own OAuth client/,
    );
  });

  it('signing in again as the same person refreshes the account in place', async () => {
    const { service, state, account } = await signedIn();
    await state.setProject(account.id, 'ready-project');
    await state.setNeedsSignIn(account.id, true);
    const again = await service.signIn({ mode: 'runova' });
    expect(again.id).toBe(account.id);
    expect(again).toMatchObject({ projectId: 'ready-project', needsSignIn: false });
    expect((await service.status()).accounts).toHaveLength(1);
  });

  it('names the account plainly when Google gives no email', async () => {
    const { service, signIn } = setup();
    signIn.mockResolvedValueOnce({ refreshToken: 'r', idToken: 'garbage' });
    expect((await service.signIn({ mode: 'runova' })).email).toBe('Google account');
  });

  it('cancels a sign-in that is waiting on the browser', async () => {
    const { service, signIn } = setup();
    signIn.mockImplementationOnce(
      (_request, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('The sign-in was cancelled.'))),
        ),
    );
    const waiting = service.signIn({ mode: 'runova' });
    await vi.waitFor(() => expect(signIn).toHaveBeenCalled());
    service.cancelSignIn();
    await expect(waiting).rejects.toThrow(/cancelled/);
  });
});

describe('calls on an account', () => {
  it('use the access token from the sign-in first, then renew with the sealed refresh token', async () => {
    const { service, account, google, refreshFetch } = await signedIn();
    await service.projects(account.id);
    expect(google().tokensSeen).toEqual(['access-1']);
    expect(refreshFetch).not.toHaveBeenCalled();
  });

  it('renews with the refresh token and the client secret after a restart', async () => {
    const world = setup();
    await world.state.save({
      id: 'acc',
      email: 'a@example.com',
      clientMode: 'own',
      clientId: 'mine',
      clientSecret: {
        mode: 'safeStorage',
        ciphertext: Buffer.from('my-secret').toString('base64'),
      },
      refreshToken: {
        mode: 'safeStorage',
        ciphertext: Buffer.from('refresh-9').toString('base64'),
      },
      projectId: null,
      needsSignIn: false,
      addedAt: '2026-10-01T00:00:00Z',
    });
    await world.service.projects('acc');
    const body = new URLSearchParams(String(world.refreshFetch.mock.calls[0]?.[1]?.body));
    expect(body.get('refresh_token')).toBe('refresh-9');
    expect(body.get('client_secret')).toBe('my-secret');
    expect(world.google().tokensSeen).toEqual(['renewed-access']);
  });

  it('refuse while the Servers vault is locked', async () => {
    let locked = false;
    const { service, account } = await signedIn({ locked: () => locked });
    locked = true;
    expect((await service.status()).locked).toBe(true);
    const error = await service
      .keys({ accountId: account.id, projectId: 'p' })
      .catch((e: unknown) => e);
    expect(recaptchaErrorCode(error)).toBe('locked');
  });

  it('refuse an account that is gone', async () => {
    const error = await setup()
      .service.projects('nobody')
      .catch((e: unknown) => e);
    expect(recaptchaErrorCode(error)).toBe('no-account');
  });

  it('mark the account when Google wants a fresh sign-in', async () => {
    const { service, account, google } = await signedIn();
    await service.projects(account.id);
    google().failWith = new Error(encodeRecaptchaError('reauth', 'Sign in again.'));
    await expect(service.projects(account.id)).rejects.toThrow(/Sign in again/);
    expect((await service.status()).accounts[0]?.needsSignIn).toBe(true);
  });
});

describe('projects', () => {
  it('lists the projects', async () => {
    const { service, account } = await signedIn();
    expect(await service.projects(account.id)).toEqual([
      { projectId: 'ready-project', name: 'Ready' },
    ]);
  });

  it('creates a project with a fresh id and makes it the account project', async () => {
    const { service, account, google } = await signedIn();
    const project = await service.createProject(account.id);
    expect(project.projectId).toMatch(/^runova-recaptcha-[a-z0-9]{6}$/);
    expect(google().createProject).toHaveBeenCalledWith(project.projectId, 'Runova reCAPTCHA');
    expect((await service.status()).accounts[0]?.projectId).toBe(project.projectId);
  });

  it('turns reCAPTCHA on in a project where it is off, step by step', async () => {
    const { service, account, google, progress } = await signedIn();
    await service.prepareProject({ accountId: account.id, projectId: 'fresh' });
    expect(google().enableApi).toHaveBeenCalledWith('fresh');
    expect(progress.map((event) => `${event.step}:${event.state}`)).toEqual([
      'project:running',
      'project:done',
      'api:running',
      'api:done',
    ]);
    expect((await service.status()).accounts[0]?.projectId).toBe('fresh');
  });

  it('leaves a project alone when reCAPTCHA is already on', async () => {
    const { service, account, google, progress } = await signedIn();
    await service.prepareProject({ accountId: account.id, projectId: 'ready-project' });
    expect(google().enableApi).not.toHaveBeenCalled();
    expect(progress.map((event) => `${event.step}:${event.state}`)).toEqual([
      'project:running',
      'project:done',
      'api:done',
    ]);
  });
});

describe('keys', () => {
  const ref = (accountId: string) => ({ accountId, projectId: 'ready-project' });

  it('lists, creates, updates and deletes keys in the project', async () => {
    const { service, account, google } = await signedIn();
    expect(await service.keys(ref(account.id))).toEqual([KEY]);
    const made = await service.createKey(ref(account.id), {
      name: 'Blog',
      type: 'checkbox',
      domains: ['blog.com'],
    });
    expect(made).toMatchObject({ id: '6LcNew', name: 'Blog' });
    await service.updateKey({ ...ref(account.id), keyId: '6LcKey1' }, 'score', {
      name: 'Shop',
      domains: ['shop.com', 'www.shop.com'],
    });
    expect(google().updateKey).toHaveBeenCalledWith('ready-project', '6LcKey1', 'score', {
      name: 'Shop',
      domains: ['shop.com', 'www.shop.com'],
    });
    await service.deleteKey({ ...ref(account.id), keyId: '6LcKey1' });
    expect(google().deleteKey).toHaveBeenCalledWith('ready-project', '6LcKey1');
  });

  it('reads a key secret only when asked', async () => {
    const { service, account, google } = await signedIn();
    await service.keys(ref(account.id));
    expect(google().legacySecret).not.toHaveBeenCalled();
    expect(await service.secret({ ...ref(account.id), keyId: '6LcKey1' })).toBe('6LcSecret');
  });

  it('adds up this month checks across the project keys', async () => {
    const { service, account, google } = await signedIn();
    await service.keys(ref(account.id));
    google().keyList = [KEY, { ...KEY, id: '6LcKey2' }];
    expect(await service.usage(ref(account.id))).toEqual({ month: '2026-10', assessments: 42 });
  });
});

describe('removeAccount', () => {
  it('forgets the account and asks Google to drop the sign-in', async () => {
    const { service, account, revoke } = await signedIn();
    await service.removeAccount(account.id);
    expect(revoke).toHaveBeenCalledWith('refresh-1');
    expect((await service.status()).accounts).toEqual([]);
  });

  it('still forgets it when Google cannot be reached or the vault is locked', async () => {
    let locked = false;
    const { service, account, revoke } = await signedIn({ locked: () => locked });
    revoke.mockRejectedValueOnce(new Error('offline'));
    await service.removeAccount(account.id);
    expect((await service.status()).accounts).toEqual([]);

    const again = await service.signIn({ mode: 'runova' });
    locked = true;
    revoke.mockClear();
    await service.removeAccount(again.id);
    expect(revoke).not.toHaveBeenCalled();
    expect((await service.status()).accounts).toEqual([]);
  });
});
