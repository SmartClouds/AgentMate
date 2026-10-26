import { afterEach, describe, expect, it } from 'vitest';
import {
  FAKE_EMAIL,
  FAKE_TOKEN,
  type FakeSentry,
  startFakeSentry,
} from '../../test/main/fakeSentry';
import { json } from '../../test/main/fixtures';
import {
  createSentryProvider,
  errorKind,
  SENTRY_SORT,
  sentryIssueQuery,
  sentryStatusBody,
} from './provider';

/**
 * The Sentry provider (E24): the client's raw JSON turned into Runova's own types by the core
 * parsers, the list filters turned into Sentry's query language, and the paging of long lists.
 */

const servers: FakeSentry[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function setup(options: Parameters<typeof startFakeSentry>[0] = {}) {
  const fake = await startFakeSentry(options);
  servers.push(fake);
  const provider = createSentryProvider({ transport: (url, init) => fetch(url, init) });
  return { fake, provider, access: { baseUrl: fake.url, token: FAKE_TOKEN } };
}

describe('filters in Sentry terms', () => {
  it('maps the status filter and appends the search', () => {
    expect(sentryIssueQuery('unresolved', '')).toBe('is:unresolved');
    expect(sentryIssueQuery('resolved', undefined)).toBe('is:resolved');
    expect(sentryIssueQuery('ignored', '  checkout  ')).toBe('is:ignored checkout');
    expect(sentryIssueQuery('all', '')).toBe('');
    expect(sentryIssueQuery('all', 'TypeError')).toBe('TypeError');
  });

  it('maps the sort', () => {
    expect(SENTRY_SORT).toEqual({ lastSeen: 'date', events: 'freq', users: 'user', newest: 'new' });
  });

  it('builds the status change body', () => {
    expect(sentryStatusBody('resolved', null)).toEqual({ status: 'resolved' });
    expect(sentryStatusBody('unresolved', 60)).toEqual({ status: 'unresolved' });
    expect(sentryStatusBody('ignored', 60)).toEqual({ status: 'ignored', ignoreDuration: 60 });
    expect(sentryStatusBody('ignored', null)).toEqual({
      status: 'ignored',
      substatus: 'archived_forever',
    });
    expect(sentryStatusBody('ignored', undefined)).toEqual({
      status: 'ignored',
      substatus: 'archived_forever',
    });
  });

  it('reads the kind of a provider error, and nothing from anything else', () => {
    expect(errorKind(Object.assign(new Error('x'), { kind: 'forbidden' }))).toBe('forbidden');
    expect(errorKind(new Error('x'))).toBeNull();
    expect(errorKind('x')).toBeNull();
  });
});

describe('createSentryProvider', () => {
  it('knows its scopes, hosts and the token that cannot read issues', async () => {
    const { provider } = await setup();
    expect(provider.id).toBe('sentry');
    expect(provider.readScopes).toEqual(['org:read', 'project:read', 'event:read']);
    expect(provider.writeScope).toBe('event:write');
    expect(provider.normalizeHost('acme.sentry.io')).toEqual({
      baseUrl: 'https://sentry.io',
      orgSlugHint: 'acme',
    });
    expect(provider.tokenWarning('sntrys_abc')).toMatch(/organization auth token/);
    expect(provider.tokenWarning(FAKE_TOKEN)).toBeNull();
  });

  it('reads scopes, organizations, projects and environments', async () => {
    const { provider, access, fake } = await setup({ regionUrl: 'https://de.sentry.io' });
    expect(await provider.scopes(access)).toEqual([
      'org:read',
      'project:read',
      'event:read',
      'event:write',
    ]);
    expect(await provider.organizations(access)).toEqual([
      { slug: 'acme', name: 'Acme', regionUrl: 'https://de.sentry.io' },
      { slug: 'side-project', name: 'Side Project', regionUrl: 'https://de.sentry.io' },
    ]);
    expect((await provider.projects(access, 'acme')).map((project) => project.slug)).toEqual([
      'storefront-web',
      'storefront-api',
      'billing-worker',
    ]);
    expect(await provider.environments(access, 'acme', 'storefront-web')).toEqual(['production']);
    expect(fake.requestsTo('/api/0/projects/acme/storefront-web/environments/')).toHaveLength(1);
  });

  it('follows the project list across pages, up to a limit', async () => {
    const { provider, access, fake } = await setup();
    fake.state.override = (_request, response, url) => {
      if (!url.pathname.endsWith('/projects/')) return false;
      const page = Number(url.searchParams.get('cursor') ?? '0');
      response.writeHead(200, {
        'content-type': 'application/json',
        link: `<x>; rel="next"; results="true"; cursor="${page + 1}"`,
      });
      response.end(JSON.stringify([{ id: String(page), slug: `p${page}`, name: `P${page}` }]));
      return true;
    };
    const projects = await provider.projects(access, 'acme');
    expect(projects.map((project) => project.id)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });

  it('lists issues with the filters and the next cursor', async () => {
    const { provider, access, fake } = await setup();
    fake.state.issueLink =
      '<https://sentry.io/x>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/x>; rel="next"; results="true"; cursor="0:25:0"';
    const page = await provider.issues(access, 'acme', {
      projects: [{ id: '102', slug: 'storefront-api' }],
      status: 'unresolved',
      period: '7d',
      environment: 'production',
      sort: 'events',
      search: 'checkout',
      cursor: null,
      limit: 25,
    });
    expect(page.next).toBe('0:25:0');
    expect(page.issues).toHaveLength(1);
    expect(page.issues[0]).toMatchObject({
      id: '4501',
      shortId: 'STOREFRONT-API-3F',
      count: 1287,
      remoteProjectId: '102',
      trend: [3, 0, 12, 40],
    });
    const sent = new URL(fake.requests[0].url, 'http://x').searchParams;
    expect(sent.get('query')).toBe('is:unresolved checkout');
    expect(sent.get('sort')).toBe('freq');
    expect(sent.get('statsPeriod')).toBe('7d');
    expect(sent.get('environment')).toBe('production');
  });

  it('reads one issue and redacts it', async () => {
    const { provider, access } = await setup();
    const issue = await provider.issue(access, 'acme', '4502');
    expect(issue.id).toBe('4502');
    expect(JSON.stringify(issue)).not.toContain(FAKE_EMAIL);
  });

  it('refuses an issue it cannot read', async () => {
    const { provider, access, fake } = await setup();
    fake.state.override = (_request, response, url) => {
      if (!url.pathname.endsWith('/issues/9/')) return false;
      json(response, { nonsense: true });
      return true;
    };
    await expect(provider.issue(access, 'acme', '9')).rejects.toThrow(/could not read/);
  });

  it('reads the latest event, or null when there is none', async () => {
    const { provider, access } = await setup();
    const event = await provider.latestEvent(access, 'acme', '4501');
    expect(event?.eventId).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(event?.userId).toBe('usr_8812');
    expect(JSON.stringify(event)).not.toContain(FAKE_EMAIL);
    expect(await provider.latestEvent(access, 'acme', '4502')).toBeNull();
  });

  it('passes on other failures of the latest event', async () => {
    const { provider } = await setup();
    const fake = servers[0];
    await expect(
      provider.latestEvent({ baseUrl: fake.url, token: 'sntryu_wrong' }, 'acme', '4501'),
    ).rejects.toThrow(/rejected the token/);
  });

  it('changes the status of an issue', async () => {
    const { provider, access, fake } = await setup();
    await provider.setStatus(access, 'acme', '4501', { status: 'ignored', ignoreMinutes: 60 });
    const [put] = fake.requestsTo('/api/0/organizations/acme/issues/4501/', 'PUT');
    expect(JSON.parse(put.body)).toEqual({ status: 'ignored', ignoreDuration: 60 });
  });
});
