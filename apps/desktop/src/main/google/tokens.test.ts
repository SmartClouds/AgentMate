import { describe, expect, it, vi } from 'vitest';
import { recaptchaErrorCode } from '../../shared/recaptchaErrors';
import { type GoogleCredentials, GoogleTokens } from './tokens';

/**
 * Google access tokens last an hour. They are kept in memory only, renewed with the sealed refresh
 * token a minute before they run out, and one renewal is shared by every call waiting on it.
 */

const CREDENTIALS: GoogleCredentials = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  refreshToken: 'refresh-1',
};

function tokenFetch(...answers: { body: unknown; status?: number }[]) {
  let call = 0;
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const answer = answers[Math.min(call++, answers.length - 1)] ?? { body: {} };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('GoogleTokens', () => {
  it('renews with the refresh token, then reuses the access token until near its end', async () => {
    let now = 1_000_000;
    const fetch = tokenFetch(
      { body: { access_token: 'access-1', expires_in: 3600 } },
      { body: { access_token: 'access-2', expires_in: 3600 } },
    );
    const load = vi.fn(async () => CREDENTIALS);
    const tokens = new GoogleTokens({ fetch, now: () => now });

    expect(await tokens.accessToken('a', load)).toBe('access-1');
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'client-1',
      client_secret: 'secret-1',
    });

    now += 3_500_000;
    expect(await tokens.accessToken('a', load)).toBe('access-1');
    expect(load).toHaveBeenCalledTimes(1);
    // Less than a minute left: renew.
    now += 50_000;
    expect(await tokens.accessToken('a', load)).toBe('access-2');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('starts from the access token a sign-in just handed out', async () => {
    const fetch = tokenFetch({ body: {} });
    const tokens = new GoogleTokens({ fetch, now: () => 0 });
    tokens.remember('a', 'fresh', 3600);
    expect(await tokens.accessToken('a', async () => CREDENTIALS)).toBe('fresh');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shares one renewal between calls that arrive together', async () => {
    const fetch = tokenFetch({ body: { access_token: 'shared', expires_in: 3600 } });
    const tokens = new GoogleTokens({ fetch });
    const all = await Promise.all(
      [1, 2, 3].map(() => tokens.accessToken('a', async () => CREDENTIALS)),
    );
    expect(all).toEqual(['shared', 'shared', 'shared']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends no client secret for a client without one', async () => {
    const fetch = tokenFetch({ body: { access_token: 'x', expires_in: 3600 } });
    await new GoogleTokens({ fetch }).accessToken('a', async () => ({
      clientId: 'c',
      refreshToken: 'r',
    }));
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).has('client_secret')).toBe(
      false,
    );
  });

  it('asks for a fresh sign-in when Google refuses the refresh token', async () => {
    const fetch = tokenFetch({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    });
    const error = await new GoogleTokens({ fetch })
      .accessToken('a', async () => CREDENTIALS)
      .catch((caught: unknown) => caught);
    expect(recaptchaErrorCode(error)).toBe('reauth');
    expect(String(error)).toMatch(/Sign in to Google again/);
    expect(String(error)).not.toContain('refresh-1');
  });

  it('says what else went wrong, and tries again on the next call', async () => {
    const fetch = tokenFetch(
      {
        status: 401,
        body: { error: 'invalid_client', error_description: 'The OAuth client was not found.' },
      },
      { body: { access_token: 'later', expires_in: 3600 } },
    );
    const tokens = new GoogleTokens({ fetch });
    await expect(tokens.accessToken('a', async () => CREDENTIALS)).rejects.toThrow(
      /The OAuth client was not found/,
    );
    expect(await tokens.accessToken('a', async () => CREDENTIALS)).toBe('later');
  });

  it('refuses a renewal that brings no access token', async () => {
    const tokens = new GoogleTokens({ fetch: tokenFetch({ body: { expires_in: 3600 } }) });
    await expect(tokens.accessToken('a', async () => CREDENTIALS)).rejects.toThrow(
      /sent no access token/,
    );
  });

  it('keeps an hour when Google does not say how long the token lasts', async () => {
    let now = 0;
    const fetch = tokenFetch({ body: { access_token: 'x' } }, { body: { access_token: 'y' } });
    const tokens = new GoogleTokens({ fetch, now: () => now });
    expect(await tokens.accessToken('a', async () => CREDENTIALS)).toBe('x');
    now += 3_000_000;
    expect(await tokens.accessToken('a', async () => CREDENTIALS)).toBe('x');
  });

  it('forgets an account, so the next call renews', async () => {
    const fetch = tokenFetch({ body: { access_token: 'renewed', expires_in: 3600 } });
    const tokens = new GoogleTokens({ fetch, now: () => 0 });
    tokens.remember('a', 'old', 3600);
    tokens.forget('a');
    expect(await tokens.accessToken('a', async () => CREDENTIALS)).toBe('renewed');
  });

  it('forgets every account at once', async () => {
    const fetch = tokenFetch({ body: { access_token: 'renewed', expires_in: 3600 } });
    const tokens = new GoogleTokens({ fetch, now: () => 0 });
    tokens.remember('a', 'old-a', 3600);
    tokens.remember('b', 'old-b', 3600);
    tokens.clear();
    expect(await tokens.accessToken('b', async () => CREDENTIALS)).toBe('renewed');
  });

  it('uses another token endpoint when given one', async () => {
    const fetch = tokenFetch({ body: { access_token: 'x', expires_in: 3600 } });
    await new GoogleTokens({ fetch, tokenUrl: 'http://127.0.0.1:9/token' }).accessToken(
      'a',
      async () => CREDENTIALS,
    );
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9/token');
  });
});
