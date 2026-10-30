import { describe, expect, it, vi } from 'vitest';
import { recaptchaErrorCode } from '../../../shared/recaptchaErrors';
import { RecaptchaClient } from './client';

/**
 * The thin REST client over Resource Manager, Service Usage and reCAPTCHA. Every call carries the
 * account's access token; reCAPTCHA calls also name the project as the one to bill.
 */

type Route = (url: URL, init: RequestInit) => { status?: number; body?: unknown } | undefined;

function fakeGoogle(routes: Record<string, Route>) {
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url, init });
    const route = routes[`${method} ${url.origin}${url.pathname}`];
    const answer = route?.(url, init) ?? { status: 404, body: { error: { message: 'no route' } } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetch, calls };
}

function client(fetch: typeof globalThis.fetch) {
  return new RecaptchaClient({
    fetch,
    accessToken: async () => 'access-1',
    sleep: async () => undefined,
  });
}

const RM = 'https://cloudresourcemanager.googleapis.com';
const SU = 'https://serviceusage.googleapis.com';
const RC = 'https://recaptchaenterprise.googleapis.com';

const WEB_KEY = {
  name: 'projects/my-project/keys/6LcKey1',
  displayName: 'Shop',
  createTime: '2026-10-01T10:00:00Z',
  webSettings: {
    integrationType: 'CHECKBOX',
    allowedDomains: ['shop.com', 'www.shop.com'],
    challengeSecurityPreference: 'BALANCE',
  },
};

describe('projects', () => {
  it('lists every active project across pages, by name', async () => {
    const google = fakeGoogle({
      [`GET ${RM}/v3/projects:search`]: (url) =>
        url.searchParams.get('pageToken') === 'next'
          ? { body: { projects: [{ projectId: 'b-proj', displayName: 'Beta' }] } }
          : {
              body: {
                projects: [{ projectId: 'z-proj', displayName: 'Zeta' }, { projectId: 'no-name' }],
                nextPageToken: 'next',
              },
            },
    });
    const projects = await client(google.fetch).projects();
    expect(projects).toEqual([
      { projectId: 'b-proj', name: 'Beta' },
      { projectId: 'no-name', name: 'no-name' },
      { projectId: 'z-proj', name: 'Zeta' },
    ]);
    expect(google.calls[0]?.url.searchParams.get('query')).toBe('state:ACTIVE');
    expect(new Headers(google.calls[0]?.init.headers).get('authorization')).toBe('Bearer access-1');
    expect(new Headers(google.calls[0]?.init.headers).has('x-goog-user-project')).toBe(false);
  });

  it('creates a project and waits for Google to finish it', async () => {
    let polls = 0;
    const google = fakeGoogle({
      [`POST ${RM}/v3/projects`]: () => ({ body: { name: 'operations/cp.1', done: false } }),
      [`GET ${RM}/v3/operations/cp.1`]: () =>
        ++polls < 3
          ? { body: { name: 'operations/cp.1', done: false } }
          : {
              body: {
                name: 'operations/cp.1',
                done: true,
                response: { projectId: 'runova-recaptcha-ab12', displayName: 'Runova reCAPTCHA' },
              },
            },
    });
    const project = await client(google.fetch).createProject(
      'runova-recaptcha-ab12',
      'Runova reCAPTCHA',
    );
    expect(project).toEqual({ projectId: 'runova-recaptcha-ab12', name: 'Runova reCAPTCHA' });
    expect(JSON.parse(String(google.calls[0]?.init.body))).toEqual({
      projectId: 'runova-recaptcha-ab12',
      displayName: 'Runova reCAPTCHA',
    });
    expect(polls).toBe(3);
  });

  it('reports a finished operation that failed', async () => {
    const google = fakeGoogle({
      [`POST ${RM}/v3/projects`]: () => ({
        body: {
          name: 'operations/cp.2',
          done: true,
          error: { code: 6, message: 'The project ID is taken.' },
        },
      }),
    });
    await expect(client(google.fetch).createProject('taken', 'x')).rejects.toThrow(
      /The project ID is taken/,
    );
  });
});

describe('the reCAPTCHA API in a project', () => {
  it('tells whether it is on', async () => {
    const google = fakeGoogle({
      [`GET ${SU}/v1/projects/p1/services/recaptchaenterprise.googleapis.com`]: () => ({
        body: { state: 'ENABLED' },
      }),
      [`GET ${SU}/v1/projects/p2/services/recaptchaenterprise.googleapis.com`]: () => ({
        body: { state: 'DISABLED' },
      }),
    });
    expect(await client(google.fetch).apiEnabled('p1')).toBe(true);
    expect(await client(google.fetch).apiEnabled('p2')).toBe(false);
  });

  it('turns it on and waits for the operation', async () => {
    let polls = 0;
    const google = fakeGoogle({
      [`POST ${SU}/v1/projects/p1/services/recaptchaenterprise.googleapis.com:enable`]: () => ({
        body: { name: 'operations/acf.1' },
      }),
      [`GET ${SU}/v1/operations/acf.1`]: () => ({ body: { done: ++polls >= 2 } }),
    });
    await client(google.fetch).enableApi('p1');
    expect(polls).toBe(2);
  });

  it('gives up waiting after a while', async () => {
    const google = fakeGoogle({
      [`POST ${SU}/v1/projects/p1/services/recaptchaenterprise.googleapis.com:enable`]: () => ({
        body: { name: 'operations/slow' },
      }),
      [`GET ${SU}/v1/operations/slow`]: () => ({ body: { done: false } }),
    });
    await expect(client(google.fetch).enableApi('p1')).rejects.toThrow(/taking longer/);
  });
});

describe('keys', () => {
  it('lists the web keys across pages, billed to the project', async () => {
    const google = fakeGoogle({
      [`GET ${RC}/v1/projects/my-project/keys`]: (url) =>
        url.searchParams.get('pageToken')
          ? {
              body: {
                keys: [
                  {
                    name: 'projects/my-project/keys/6LcKey2',
                    displayName: 'Blog',
                    webSettings: { integrationType: 'SCORE', allowAllDomains: true },
                  },
                ],
              },
            }
          : {
              body: {
                keys: [
                  WEB_KEY,
                  {
                    name: 'projects/my-project/keys/android',
                    displayName: 'App',
                    androidSettings: {},
                  },
                ],
                nextPageToken: 't',
              },
            },
    });
    const keys = await client(google.fetch).keys('my-project');
    expect(keys).toEqual([
      {
        id: '6LcKey1',
        name: 'Shop',
        type: 'checkbox',
        domains: ['shop.com', 'www.shop.com'],
        allowAllDomains: false,
        challenge: 'balance',
        createdAt: '2026-10-01T10:00:00Z',
      },
      {
        id: '6LcKey2',
        name: 'Blog',
        type: 'score',
        domains: [],
        allowAllDomains: true,
        challenge: null,
        createdAt: null,
      },
    ]);
    expect(new Headers(google.calls[0]?.init.headers).get('x-goog-user-project')).toBe(
      'my-project',
    );
  });

  it('creates a key with only the settings its type takes', async () => {
    const google = fakeGoogle({
      [`POST ${RC}/v1/projects/my-project/keys`]: () => ({ body: WEB_KEY }),
    });
    const recaptcha = client(google.fetch);
    await recaptcha.createKey('my-project', {
      name: 'Shop',
      type: 'checkbox',
      domains: ['shop.com'],
      challenge: 'security',
    });
    await recaptcha.createKey('my-project', {
      name: 'Blog',
      type: 'score',
      domains: ['blog.com'],
      challenge: 'security',
    });
    expect(JSON.parse(String(google.calls[0]?.init.body))).toEqual({
      displayName: 'Shop',
      webSettings: {
        integrationType: 'CHECKBOX',
        allowedDomains: ['shop.com'],
        challengeSecurityPreference: 'SECURITY',
      },
    });
    expect(JSON.parse(String(google.calls[1]?.init.body))).toEqual({
      displayName: 'Blog',
      webSettings: { integrationType: 'SCORE', allowedDomains: ['blog.com'] },
    });
  });

  it('updates the name, domains and difficulty with a field mask', async () => {
    const google = fakeGoogle({
      [`PATCH ${RC}/v1/projects/my-project/keys/6LcKey1`]: () => ({ body: WEB_KEY }),
    });
    const recaptcha = client(google.fetch);
    await recaptcha.updateKey('my-project', '6LcKey1', 'checkbox', {
      name: 'Shop',
      domains: ['shop.com'],
      challenge: 'usability',
    });
    await recaptcha.updateKey('my-project', '6LcKey1', 'score', { name: 'S', domains: ['s.com'] });
    expect(google.calls[0]?.url.searchParams.get('updateMask')).toBe(
      'displayName,webSettings.allowedDomains,webSettings.challengeSecurityPreference',
    );
    expect(JSON.parse(String(google.calls[0]?.init.body))).toEqual({
      displayName: 'Shop',
      webSettings: {
        integrationType: 'CHECKBOX',
        allowedDomains: ['shop.com'],
        challengeSecurityPreference: 'USABILITY',
      },
    });
    expect(google.calls[1]?.url.searchParams.get('updateMask')).toBe(
      'displayName,webSettings.allowedDomains',
    );
  });

  it('deletes a key, reads its secret and its metrics', async () => {
    const google = fakeGoogle({
      [`DELETE ${RC}/v1/projects/my-project/keys/6LcKey1`]: () => ({ body: {} }),
      [`GET ${RC}/v1/projects/my-project/keys/6LcKey1:retrieveLegacySecretKey`]: () => ({
        body: { legacySecretKey: '6LcSecret' },
      }),
      [`GET ${RC}/v1/projects/my-project/keys/6LcKey1/metrics`]: () => ({
        body: { startTime: '2026-10-01T07:00:00Z', scoreMetrics: [] },
      }),
    });
    const recaptcha = client(google.fetch);
    await recaptcha.deleteKey('my-project', '6LcKey1');
    expect(await recaptcha.legacySecret('my-project', '6LcKey1')).toBe('6LcSecret');
    expect(await recaptcha.metrics('my-project', '6LcKey1')).toEqual({
      startTime: '2026-10-01T07:00:00Z',
      scoreMetrics: [],
    });
    expect(google.calls.map((call) => call.method)).toEqual(['DELETE', 'GET', 'GET']);
  });

  it('escapes ids so a path cannot be bent', async () => {
    const google = fakeGoogle({});
    await client(google.fetch)
      .deleteKey('my-project', '../../projects/other')
      .catch(() => undefined);
    expect(google.calls[0]?.url.pathname).toBe(
      '/v1/projects/my-project/keys/..%2F..%2Fprojects%2Fother',
    );
  });
});

describe('failures', () => {
  it('turns a Google error into a coded one', async () => {
    const google = fakeGoogle({
      [`GET ${RC}/v1/projects/p/keys`]: () => ({
        status: 403,
        body: { error: { status: 'PERMISSION_DENIED', message: 'Permission denied' } },
      }),
    });
    const error = await client(google.fetch)
      .keys('p')
      .catch((caught: unknown) => caught);
    expect(recaptchaErrorCode(error)).toBe('permission');
  });

  it('says when Google cannot be reached', async () => {
    const recaptcha = client(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(recaptcha.projects()).rejects.toThrow(/Could not reach Google/);
  });

  it('uses other API addresses when given them', async () => {
    const google = fakeGoogle({
      'GET http://127.0.0.1:9/rm/v3/projects:search': () => ({ body: { projects: [] } }),
    });
    const recaptcha = new RecaptchaClient({
      fetch: google.fetch,
      accessToken: async () => 'a',
      bases: {
        resourceManager: 'http://127.0.0.1:9/rm',
        serviceUsage: 'http://127.0.0.1:9/su',
        recaptcha: 'http://127.0.0.1:9/rc',
      },
    });
    expect(await recaptcha.projects()).toEqual([]);
  });
});
