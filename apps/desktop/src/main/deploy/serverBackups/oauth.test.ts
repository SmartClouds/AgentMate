import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { authorizationUrl, CLOUD_PROVIDERS, signInWithLoopback } from './oauth';

/**
 * Google Drive and OneDrive sign in with the user's own OAuth client over a loopback redirect
 * with PKCE. The browser is a fake that follows the redirect with a real request to the loopback
 * listener; the token endpoint is a fake fetch.
 */

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

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

describe('authorizationUrl', () => {
  it('asks Google for an offline refresh token on the drive.file scope', () => {
    const url = new URL(
      authorizationUrl('googleDrive', {
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:5000/callback',
        state: 'st',
        challenge: 'ch',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('asks Microsoft for the app folder and offline access', () => {
    const url = new URL(
      authorizationUrl('oneDrive', {
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:5000/callback',
        state: 'st',
        challenge: 'ch',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')).toBe('Files.ReadWrite.AppFolder offline_access');
    expect(CLOUD_PROVIDERS.oneDrive.tokenUrl).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    );
  });
});

describe('signInWithLoopback', () => {
  it('opens the browser, takes the code on the loopback and trades it for a refresh token', async () => {
    let page = { status: 0, body: '' };
    let opened = '';
    const fetch = tokenFetch({ access_token: 'a', refresh_token: 'refresh-1' });
    const result = await signInWithLoopback(
      {
        fetch,
        openExternal: async (url) => {
          opened = url;
          const asked = new URL(url);
          const redirect = asked.searchParams.get('redirect_uri') ?? '';
          const state = asked.searchParams.get('state') ?? '';
          // The browser comes back a moment later, as it would.
          setTimeout(() => {
            void get(`${redirect}?code=code-1&state=${state}`).then((answer) => {
              page = answer;
            });
          }, 5);
        },
      },
      { kind: 'googleDrive', clientId: 'client-1', clientSecret: 'secret-1' },
    );

    expect(result).toEqual({ refreshToken: 'refresh-1' });
    const asked = new URL(opened);
    expect(asked.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret-1');
    expect(body.get('redirect_uri')).toBe(asked.searchParams.get('redirect_uri'));
    // The verifier hashes to the challenge the browser was given.
    const verifier = body.get('code_verifier') ?? '';
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(base64url(createHash('sha256').update(verifier).digest())).toBe(
      asked.searchParams.get('code_challenge'),
    );
    await vi.waitFor(() => expect(page.status).toBe(200));
    expect(page.body).toMatch(/You can close this tab/);
  });

  it('sends no client secret for a public client', async () => {
    const fetch = tokenFetch({ refresh_token: 'r' });
    await signInWithLoopback(
      {
        fetch,
        openExternal: async (url) => {
          const asked = new URL(url);
          setTimeout(() => {
            void get(
              `${asked.searchParams.get('redirect_uri')}?code=c&state=${asked.searchParams.get('state')}`,
            );
          }, 5);
        },
      },
      { kind: 'oneDrive', clientId: 'client-2' },
    );
    const body = new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.has('client_secret')).toBe(false);
  });

  it('ignores a callback with the wrong state and reports a refusal in words', async () => {
    const fetch = tokenFetch({ refresh_token: 'r' });
    let wrong = { status: 0, body: '' };
    const signIn = signInWithLoopback(
      {
        fetch,
        openExternal: async (url) => {
          const asked = new URL(url);
          const redirect = asked.searchParams.get('redirect_uri');
          setTimeout(() => {
            void get(`${redirect}?code=c&state=forged`).then((answer) => {
              wrong = answer;
              return get(
                `${redirect}?error=access_denied&error_description=The+user+said+no&state=${asked.searchParams.get('state')}`,
              );
            });
          }, 5);
        },
      },
      { kind: 'googleDrive', clientId: 'c', clientSecret: 's' },
    );
    await expect(signIn).rejects.toThrow(/The user said no/);
    expect(wrong.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says what the token endpoint refused', async () => {
    const fetch = tokenFetch({ error: 'invalid_client', error_description: 'Unknown client' }, 401);
    const signIn = signInWithLoopback(
      {
        fetch,
        openExternal: async (url) => {
          const asked = new URL(url);
          setTimeout(() => {
            void get(
              `${asked.searchParams.get('redirect_uri')}?code=c&state=${asked.searchParams.get('state')}`,
            );
          }, 5);
        },
      },
      { kind: 'googleDrive', clientId: 'c', clientSecret: 's' },
    );
    await expect(signIn).rejects.toThrow(/Unknown client/);
  });

  it('wants a refresh token, not just an access token', async () => {
    const fetch = tokenFetch({ access_token: 'a' });
    const signIn = signInWithLoopback(
      {
        fetch,
        openExternal: async (url) => {
          const asked = new URL(url);
          setTimeout(() => {
            void get(
              `${asked.searchParams.get('redirect_uri')}?code=c&state=${asked.searchParams.get('state')}`,
            );
          }, 5);
        },
      },
      { kind: 'oneDrive', clientId: 'c' },
    );
    await expect(signIn).rejects.toThrow(/refresh token/);
  });

  it('gives up when nobody signs in in time, and when cancelled', async () => {
    await expect(
      signInWithLoopback(
        { fetch: tokenFetch({}), openExternal: async () => undefined, timeoutMs: 30 },
        { kind: 'oneDrive', clientId: 'c' },
      ),
    ).rejects.toThrow(/did not finish/);

    const controller = new AbortController();
    const signIn = signInWithLoopback(
      {
        fetch: tokenFetch({}),
        openExternal: async () => {
          setTimeout(() => controller.abort(), 5);
        },
        signal: controller.signal,
      },
      { kind: 'oneDrive', clientId: 'c' },
    );
    await expect(signIn).rejects.toThrow(/cancelled/);
  });
});
