import { encodeRecaptchaError } from '../../shared/recaptchaErrors';

/**
 * Google access tokens for the signed-in accounts (E40). They last an hour and live in memory
 * only. Each is renewed with the account's refresh token a minute before it runs out, and one
 * renewal is shared by every call waiting on it. The refresh token is unsealed only when a renewal
 * actually runs. Google refusing it (`invalid_grant`: revoked, expired, or the password changed)
 * comes out as the `reauth` code, so the page can offer a fresh sign-in.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const RENEW_MARGIN_MS = 60_000;

export interface GoogleCredentials {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

export interface GoogleTokensDeps {
  fetch: typeof fetch;
  now?: () => number;
  tokenUrl?: string;
}

interface Held {
  token: string;
  expiresAt: number;
}

export class GoogleTokens {
  private readonly held = new Map<string, Held>();
  private readonly renewing = new Map<string, Promise<string>>();
  private readonly now: () => number;

  constructor(private readonly deps: GoogleTokensDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Keeps the access token a sign-in just handed out, so the first call needs no renewal. */
  remember(accountId: string, token: string, expiresIn: number): void {
    this.held.set(accountId, { token, expiresAt: this.now() + expiresIn * 1000 });
  }

  forget(accountId: string): void {
    this.held.delete(accountId);
  }

  clear(): void {
    this.held.clear();
  }

  /** A token with more than a minute left: the one in hand, or a renewed one. */
  accessToken(accountId: string, load: () => Promise<GoogleCredentials>): Promise<string> {
    const current = this.held.get(accountId);
    if (current && current.expiresAt - this.now() > RENEW_MARGIN_MS) {
      return Promise.resolve(current.token);
    }
    const running = this.renewing.get(accountId);
    if (running) return running;
    const next = this.renew(accountId, load).finally(() => this.renewing.delete(accountId));
    this.renewing.set(accountId, next);
    return next;
  }

  private async renew(accountId: string, load: () => Promise<GoogleCredentials>): Promise<string> {
    const credentials = await load();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      ...(credentials.clientSecret ? { client_secret: credentials.clientSecret } : {}),
    });
    const response = await this.deps.fetch(this.deps.tokenUrl ?? GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      // The status below says enough.
    }
    if (!response.ok) {
      if (json.error === 'invalid_grant') {
        this.held.delete(accountId);
        throw new Error(
          encodeRecaptchaError(
            'reauth',
            'Google no longer accepts this sign-in. Sign in to Google again to keep managing your keys.',
          ),
        );
      }
      const reason =
        typeof json.error_description === 'string'
          ? json.error_description
          : typeof json.error === 'string'
            ? json.error
            : `HTTP ${response.status}`;
      throw new Error(`Google refused to renew the sign-in: ${reason}`);
    }
    if (typeof json.access_token !== 'string' || !json.access_token) {
      throw new Error('Google renewed the sign-in but sent no access token. Try again.');
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    this.remember(accountId, json.access_token, expiresIn);
    return json.access_token;
  }
}
