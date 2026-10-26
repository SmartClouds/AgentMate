import type { SecretEnvelope } from '../../../shared/apiTypes';
import { coreErrorCode, encodeCoreError, isCoreErrorCode } from '../../../shared/coreErrors';
import type {
  ChallengeResponse,
  SignedInResponse,
  SignedInUser,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { CoreHttpError } from '../connection/coreHttp';
import { coreNames, layoutOf } from '../coreLayout';
import type { DeployState, DeviceCredentials } from '../state';
import { authMessage, signMessage } from './deviceKey';

/**
 * Signing in to each server core and staying signed in. Every step signs a single-use challenge
 * with this computer's device key; the password is only sent to sign in, and a token is renewed
 * with a fresh signature a minute before it runs out, so nothing reusable is ever stored. Tokens
 * live in memory only; the session id is kept so the next run of the app can renew it.
 */

export interface CoreRest {
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface SignInInput {
  password: string;
  totpCode?: string;
  recoveryCode?: string;
}

export interface CoreSessionsDeps {
  state: DeployState;
  /** Opens a sealed device key (Servers vault). */
  unseal: (envelope: SecretEnvelope) => Promise<string>;
  /** Reaches the server's core over its usual transport for the length of `work`. */
  withCore: <T>(serverId: string, work: (core: CoreRest) => Promise<T>) => Promise<T>;
  now?: () => number;
}

interface SignedIn {
  token: string;
  expiresAt: number;
  user: SignedInUser;
}

/** Renew this long before the token would run out, so a call never goes out with a dying one. */
const RENEW_MARGIN_MS = 60_000;

/** Turns the core's JSON refusal into an error that keeps its code across IPC. */
export async function coded<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof CoreHttpError && typeof error.body === 'object' && error.body !== null) {
      const { code, message } = error.body as { code?: unknown; message?: unknown };
      if (isCoreErrorCode(code)) {
        throw new Error(
          encodeCoreError(code, typeof message === 'string' ? message : error.message),
        );
      }
    }
    throw error;
  }
}

export class CoreSessions {
  private readonly signedIn = new Map<string, SignedIn>();
  private readonly renewing = new Map<string, Promise<string>>();
  private readonly now: () => number;

  constructor(private readonly deps: CoreSessionsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** A token with more than a minute left: the one in hand, or a renewed one. */
  accessToken(serverId: string): Promise<string> {
    const current = this.signedIn.get(serverId);
    if (current && current.expiresAt - this.now() > RENEW_MARGIN_MS) {
      return Promise.resolve(current.token);
    }
    const running = this.renewing.get(serverId);
    if (running) return running;
    const next = this.renew(serverId).finally(() => this.renewing.delete(serverId));
    this.renewing.set(serverId, next);
    return next;
  }

  /** When the token in hand runs out (the core's clock), or null when there is none. */
  expiresAt(serverId: string): number | null {
    return this.signedIn.get(serverId)?.expiresAt ?? null;
  }

  /** Who is signed in, when this run of the app has signed in or renewed. */
  user(serverId: string): SignedInUser | null {
    return this.signedIn.get(serverId)?.user ?? null;
  }

  /** The old prefix until the server is known to run the Runova layout; every newer core takes both. */
  private async authPrefix(serverId: string): Promise<string> {
    return coreNames(layoutOf(await this.deps.state.get(serverId))).authPrefix;
  }

  async signIn(serverId: string, input: SignInInput): Promise<SignedInUser> {
    const device = await this.enrolled(serverId);
    const privateKey = await this.deps.unseal(device.privateKey);
    const response = await this.deps.withCore(serverId, async (core) => {
      const challenge = await coded(
        core.post<ChallengeResponse>('/api/v1/auth/challenge', {
          deviceId: device.deviceId,
          purpose: 'login',
        }),
      );
      const message = authMessage(
        'login',
        challenge.challengeId,
        challenge.nonce,
        device.deviceId,
        null,
        await this.authPrefix(serverId),
      );
      return coded(
        core.post<SignedInResponse>('/api/v1/auth/login', {
          challengeId: challenge.challengeId,
          deviceId: device.deviceId,
          signature: signMessage(privateKey, message),
          userName: device.userName,
          password: input.password,
          totpCode: input.totpCode,
          recoveryCode: input.recoveryCode,
        }),
      );
    });
    await this.deps.state.setDevice(serverId, { ...device, sessionId: response.sessionId });
    this.keep(serverId, response);
    return response.user;
  }

  /** Keeps what the app shows about the user current after it changed on the core. */
  patchUser(serverId: string, patch: Partial<SignedInUser>): void {
    const current = this.signedIn.get(serverId);
    if (current) this.signedIn.set(serverId, { ...current, user: { ...current.user, ...patch } });
  }

  /** Drops this run's token; the stored session stays for the next renewal. */
  forget(serverId: string): void {
    this.signedIn.delete(serverId);
  }

  private async renew(serverId: string): Promise<string> {
    const device = await this.enrolled(serverId);
    const sessionId = device.sessionId;
    if (!sessionId) {
      throw new Error(encodeCoreError('sessionExpired', 'Sign in to this server core again.'));
    }
    const privateKey = await this.deps.unseal(device.privateKey);
    try {
      const response = await this.deps.withCore(serverId, async (core) => {
        const challenge = await coded(
          core.post<ChallengeResponse>('/api/v1/auth/challenge', {
            deviceId: device.deviceId,
            purpose: 'renew',
            sessionId,
          }),
        );
        const message = authMessage(
          'renew',
          challenge.challengeId,
          challenge.nonce,
          device.deviceId,
          sessionId,
          await this.authPrefix(serverId),
        );
        return coded(
          core.post<SignedInResponse>('/api/v1/auth/renew', {
            challengeId: challenge.challengeId,
            sessionId,
            signature: signMessage(privateKey, message),
          }),
        );
      });
      this.keep(serverId, response);
      return response.accessToken;
    } catch (error) {
      const code = coreErrorCode(error);
      if (code === 'sessionExpired' || code === 'sessionRevoked') {
        const { sessionId: _ended, ...rest } = device;
        await this.deps.state.setDevice(serverId, rest);
      }
      if (code) this.forget(serverId);
      throw error;
    }
  }

  private async enrolled(serverId: string): Promise<DeviceCredentials> {
    const device = await this.deps.state.device(serverId);
    if (!device) {
      throw new Error(
        encodeCoreError('notEnrolled', 'This computer is not enrolled on that server core yet.'),
      );
    }
    return device;
  }

  private keep(serverId: string, response: SignedInResponse): void {
    this.signedIn.set(serverId, {
      token: response.accessToken,
      expiresAt: response.accessTokenExpiresAtUnixMs,
      user: response.user,
    });
  }
}
