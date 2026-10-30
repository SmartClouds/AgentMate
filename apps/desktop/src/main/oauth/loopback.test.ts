import { request } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { authorizationUrl, type OAuthProvider, signInWithLoopback } from './loopback';

/**
 * The loopback sign-in works for any OAuth provider: the caller names the endpoints and the
 * scope, and gets back every token the provider handed out, not just the refresh token.
 */

const PROVIDER: OAuthProvider = {
  authorizeUrl: 'https://accounts.example.test/auth',
  tokenUrl: 'https://accounts.example.test/token',
  scope: 'openid email https://www.googleapis.com/auth/cloud-platform',
  extra: { access_type: 'offline', prompt: 'select_account consent' },
  label: 'Example',
};

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    })
      .on('error', reject)
      .end();
  });
}

function tokenFetch(answer: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(answer), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

/** A browser that consents at once and follows the redirect back to the loopback. */
async function consent(url: string): Promise<void> {
  const asked = new URL(url);
  setTimeout(() => {
    void get(
      `${asked.searchParams.get('redirect_uri')}?code=c&state=${asked.searchParams.get('state')}`,
    );
  }, 5);
}

describe('authorizationUrl', () => {
  it('uses the provider endpoint, scope and extra parameters', () => {
    const url = new URL(
      authorizationUrl(PROVIDER, {
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:5000/callback',
        state: 'st',
        challenge: 'ch',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.example.test/auth');
    expect(url.searchParams.get('scope')).toBe(PROVIDER.scope);
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
  });
});

describe('signInWithLoopback', () => {
  it('gives back the refresh token, the access token, its lifetime and the id token', async () => {
    const fetch = tokenFetch({
      refresh_token: 'refresh-1',
      access_token: 'access-1',
      expires_in: 3599,
      id_token: 'header.payload.signature',
    });
    const tokens = await signInWithLoopback(
      { fetch, openExternal: consent },
      { provider: PROVIDER, clientId: 'client-1', clientSecret: 'secret-1' },
    );
    expect(tokens).toEqual({
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresIn: 3599,
      idToken: 'header.payload.signature',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://accounts.example.test/token');
  });

  it('leaves out what the provider did not send', async () => {
    const tokens = await signInWithLoopback(
      { fetch: tokenFetch({ refresh_token: 'r', expires_in: 'soon' }), openExternal: consent },
      { provider: PROVIDER, clientId: 'c' },
    );
    expect(tokens).toEqual({ refreshToken: 'r' });
  });

  it('names the provider when no refresh token comes back', async () => {
    const signIn = signInWithLoopback(
      { fetch: tokenFetch({ access_token: 'a' }), openExternal: consent },
      { provider: PROVIDER, clientId: 'c' },
    );
    await expect(signIn).rejects.toThrow(/Example signed in but gave no refresh token/);
  });

  it('answers nothing but its one callback, and waits out a callback without a code', async () => {
    const pages: { status: number; body: string }[] = [];
    const tokens = await signInWithLoopback(
      {
        fetch: tokenFetch({ refresh_token: 'r' }),
        openExternal: async (url) => {
          const asked = new URL(url);
          const redirect = new URL(asked.searchParams.get('redirect_uri') ?? '');
          const state = asked.searchParams.get('state');
          setTimeout(() => {
            void (async () => {
              pages.push(await get(`${redirect.origin}/favicon.ico`));
              pages.push(await get(`${redirect}?state=${state}`));
              await get(`${redirect}?code=c&state=${state}`);
            })();
          }, 5);
        },
      },
      { provider: PROVIDER, clientId: 'c' },
    );
    expect(tokens.refreshToken).toBe('r');
    expect(pages.map((page) => page.status)).toEqual([404, 400]);
    expect(pages[1]?.body).toMatch(/No code/);
  });

  it('names the provider when the sign-in times out', async () => {
    await expect(
      signInWithLoopback(
        { fetch: tokenFetch({}), openExternal: async () => undefined, timeoutMs: 30 },
        { provider: PROVIDER, clientId: 'c' },
      ),
    ).rejects.toThrow(/The Example sign-in did not finish/);
  });
});
