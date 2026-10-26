import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ErrorConnectInput,
  ErrorConnectionSummary,
  ErrorIssueQuery,
  ErrorProjectLink,
} from '../../shared/errorTrackingTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import {
  FAKE_EMAIL,
  FAKE_TOKEN,
  type FakeSentry,
  fakeIssue,
  startFakeSentry,
} from '../../test/main/fakeSentry';
import { json, tempDir } from '../../test/main/fixtures';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * The error tracking service (E24) against a Sentry on loopback, with the real store and the real
 * vault (the electron mock's keychain). It checks a token before saving it, keeps it sealed, asks
 * each connection only for the projects linked to it, and keeps answering when one of them fails.
 */

const userData = useTempUserData();

// The first import pulls in all of @runova/core, which can take longer than a hook is allowed
// on a busy machine. Paying for it once up front keeps the per-test re-imports quick.
beforeAll(async () => {
  await import('./service');
}, 120_000);

let module: typeof import('./service');
let vault: typeof import('../ssh/vault');
let service: ReturnType<typeof import('./service').createErrorTrackingService>;
let fake: FakeSentry;
let clock: number;

const NOW = Date.parse('2026-10-18T10:00:00Z');
const FILE = 'error-tracking.json';

beforeEach(async () => {
  clock = NOW;
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
    { id: 'p2', name: 'Blog', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
  ]);
  fake = await startFakeSentry();
  module = await import('./service');
  vault = await import('../ssh/vault');
  service = module.createErrorTrackingService({
    transport: (url, init) => fetch(url, init),
    now: () => clock,
  });
  return () => fake.close();
});

function input(overrides: Partial<ErrorConnectInput> = {}): ErrorConnectInput {
  return { provider: 'sentry', host: fake.url, token: FAKE_TOKEN, orgSlug: 'acme', ...overrides };
}

function link(
  connection: ErrorConnectionSummary,
  overrides: Partial<ErrorProjectLink> = {},
): ErrorProjectLink {
  return {
    projectId: 'p1',
    connectionId: connection.id,
    remoteProjectId: '102',
    remoteSlug: 'storefront-api',
    remoteName: 'storefront-api',
    ...overrides,
  };
}

function query(overrides: Partial<ErrorIssueQuery> = {}): ErrorIssueQuery {
  return { status: 'unresolved', period: '7d', sort: 'lastSeen', ...overrides };
}

/** Connects acme and links storefront-api to Shop and storefront-web to Blog. */
async function linked() {
  const connection = await service.addConnection(input());
  await service.setLinks('p1', [link(connection)]);
  await service.setLinks('p2', [
    link(connection, {
      projectId: 'p2',
      remoteProjectId: '101',
      remoteSlug: 'storefront-web',
      remoteName: 'storefront-web',
    }),
  ]);
  return connection;
}

function issueRequests(target: FakeSentry = fake) {
  return target.requests.filter((request) => /\/issues\/(\?|$)/.test(request.url));
}

function onDisk(): string {
  return readFileSync(userData.dataFile(FILE), 'utf-8');
}

function expectNoToken(payload: unknown) {
  const text = JSON.stringify(payload);
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain('tokenEnvelope');
  expect(text).not.toContain('ciphertext');
}

describe('checkToken', () => {
  it('reports organizations and scopes and saves nothing', async () => {
    const check = await service.checkToken({
      provider: 'sentry',
      host: fake.url,
      token: FAKE_TOKEN,
    });
    expect(check).toEqual({
      host: fake.url,
      organizations: [
        { slug: 'acme', name: 'Acme', regionUrl: null },
        { slug: 'side-project', name: 'Side Project', regionUrl: null },
      ],
      scopes: ['org:read', 'project:read', 'event:read', 'event:write'],
      missingScopes: [],
      canWrite: true,
      warning: null,
    });
    expect(() => onDisk()).toThrow();
  });

  it('names the read scopes a token lacks, and that it cannot write', async () => {
    fake.state.scopes = ['org:read', 'project:read'];
    const check = await service.checkToken({
      provider: 'sentry',
      host: fake.url,
      token: FAKE_TOKEN,
    });
    expect(check.missingScopes).toEqual(['event:read']);
    expect(check.canWrite).toBe(false);
  });

  it('leaves scopes unknown when the provider will not say', async () => {
    fake.state.scopes = null;
    const check = await service.checkToken({
      provider: 'sentry',
      host: fake.url,
      token: FAKE_TOKEN,
    });
    expect(check).toMatchObject({ scopes: null, missingScopes: [], canWrite: null });
  });

  it('warns about an organization auth token', async () => {
    fake.state.token = 'sntrys_orgtoken';
    fake.state.scopes = null;
    const check = await service.checkToken({
      provider: 'sentry',
      host: fake.url,
      token: 'sntrys_orgtoken',
    });
    expect(check.warning).toMatch(/organization auth token/);
  });

  it('explains an organization auth token that Sentry refused', async () => {
    await expect(
      service.checkToken({ provider: 'sentry', host: fake.url, token: 'sntrys_orgtoken' }),
    ).rejects.toThrow(/organization auth token/);
  });

  it('warns when the token sees no organization', async () => {
    fake.state.organizations = [];
    const check = await service.checkToken({
      provider: 'sentry',
      host: fake.url,
      token: FAKE_TOKEN,
    });
    expect(check.warning).toMatch(/no organization/);
  });

  it('refuses a bad host, an empty token and a rejected token', async () => {
    await expect(
      service.checkToken({ provider: 'sentry', host: 'http://sentry.example.com', token: 'x' }),
    ).rejects.toThrow(/https/);
    await expect(
      service.checkToken({ provider: 'sentry', host: fake.url, token: '   ' }),
    ).rejects.toThrow(/token/);
    await expect(
      service.checkToken({ provider: 'sentry', host: fake.url, token: 'sntryu_wrong' }),
    ).rejects.toThrow(/Sentry rejected the token/);
  });
});

describe('connections', () => {
  it('saves a checked connection with its token sealed, and says so', async () => {
    const window = new FakeBrowserWindow();
    const connection = await service.addConnection(input({ token: `  ${FAKE_TOKEN}  ` }));
    expect(connection).toEqual({
      id: expect.any(String),
      provider: 'sentry',
      label: 'Acme',
      host: fake.url,
      apiBase: fake.url,
      orgSlug: 'acme',
      orgName: 'Acme',
      scopes: ['org:read', 'project:read', 'event:read', 'event:write'],
      canWrite: true,
      locked: false,
      createdAt: NOW,
      checkedAt: NOW,
      problem: null,
    } satisfies ErrorConnectionSummary);
    expectNoToken(connection);
    expect(onDisk()).not.toContain(FAKE_TOKEN);
    expect(await service.listConnections()).toEqual([connection]);
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toEqual([
      [{ reason: 'connections' }],
    ]);
  });

  it('serves the organization from its data region', async () => {
    const region = await startFakeSentry();
    fake.state.regionUrl = region.url;
    try {
      const connection = await service.addConnection(input({ label: '  Acme EU  ' }));
      expect(connection).toMatchObject({ host: fake.url, apiBase: region.url, label: 'Acme EU' });
      await service.remoteProjects(connection.id);
      expect(region.requestsTo('/api/0/organizations/acme/projects/')).toHaveLength(1);
      expect(fake.requestsTo('/api/0/organizations/acme/projects/')).toHaveLength(0);
    } finally {
      await region.close();
    }
  });

  it('ignores a region that would send the token over plain http', async () => {
    fake.state.regionUrl = 'http://sentry.example.com';
    expect((await service.addConnection(input())).apiBase).toBe(fake.url);
    fake.state.regionUrl = 'not a url';
    expect((await service.addConnection(input({ orgSlug: 'side-project' }))).apiBase).toBe(
      fake.url,
    );
  });

  it('ignores a region on another host, so the token stays where the user sent it', async () => {
    fake.state.regionUrl = 'https://collector.example.net';
    expect((await service.addConnection(input())).apiBase).toBe(fake.url);
  });

  it('takes a region only from the same host or, within sentry.io, any sentry.io region', () => {
    expect(module.regionBase('https://de.sentry.io', 'https://sentry.io')).toBe(
      'https://de.sentry.io',
    );
    expect(module.regionBase('https://us.sentry.io/', 'https://sentry.io')).toBe(
      'https://us.sentry.io',
    );
    // The EU option of the dialog is de.sentry.io; a US org picked there lives on us.sentry.io.
    expect(module.regionBase('https://us.sentry.io', 'https://de.sentry.io')).toBe(
      'https://us.sentry.io',
    );
    expect(module.regionBase('https://sentry.io.evil.com', 'https://sentry.io')).toBeNull();
    expect(module.regionBase('https://sentry.io.evil.com', 'https://de.sentry.io')).toBeNull();
    expect(module.regionBase('https://evil.com', 'https://sentry.io')).toBeNull();
    expect(
      module.regionBase('https://sentry.corp.example:9443', 'https://sentry.corp.example'),
    ).toBe('https://sentry.corp.example:9443');
    expect(
      module.regionBase('https://other.corp.example', 'https://sentry.corp.example'),
    ).toBeNull();
    expect(module.regionBase(null, 'https://sentry.io')).toBeNull();
  });

  it('assumes it can write when the scopes are unknown', async () => {
    fake.state.scopes = null;
    expect(await service.addConnection(input())).toMatchObject({ scopes: null, canWrite: true });
  });

  it('refuses a token without the read scopes, an organization it cannot see and a duplicate', async () => {
    fake.state.scopes = ['org:read'];
    await expect(service.addConnection(input())).rejects.toThrow(/project:read, event:read/);
    fake.state.scopes = ['org:read', 'project:read', 'event:read'];
    await expect(service.addConnection(input({ orgSlug: 'nope' }))).rejects.toThrow(/nope/);
    expect(() => onDisk()).toThrow();
    await service.addConnection(input());
    await expect(service.addConnection(input())).rejects.toThrow(/already connected/);
  });

  it('refuses an organization auth token even when the scopes are unknown', async () => {
    fake.state.token = 'sntrys_orgtoken';
    fake.state.scopes = null;
    await expect(service.addConnection(input({ token: 'sntrys_orgtoken' }))).rejects.toThrow(
      /organization auth token/,
    );
  });

  it('removes a connection with its links', async () => {
    const connection = await linked();
    const other = await service.addConnection(input({ orgSlug: 'side-project' }));
    const window = new FakeBrowserWindow();
    await service.removeConnection(connection.id);
    expect((await service.listConnections()).map((one) => one.id)).toEqual([other.id]);
    expect(await service.listLinks()).toEqual([]);
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toEqual([
      [{ reason: 'connections' }],
    ]);
  });

  it('replaces a token only after the new one checks out', async () => {
    const connection = await service.addConnection(input());
    const before = JSON.parse(onDisk()).connections[0].tokenEnvelope;
    await expect(service.replaceToken(connection.id, 'sntryu_wrong')).rejects.toThrow(/rejected/);
    expect(JSON.parse(onDisk()).connections[0].tokenEnvelope).toEqual(before);

    fake.state.token = 'sntryu_newtoken';
    fake.state.scopes = ['org:read', 'project:read', 'event:read'];
    clock += 5_000;
    const replaced = await service.replaceToken(connection.id, 'sntryu_newtoken');
    expect(replaced).toMatchObject({ id: connection.id, canWrite: false, checkedAt: clock });
    expect(replaced.scopes).toEqual(['org:read', 'project:read', 'event:read']);
    expectNoToken(replaced);
    expect(onDisk()).not.toContain('sntryu_newtoken');
    expect((await service.remoteProjects(connection.id)).length).toBe(3);
  });

  it('refuses a new token that lacks scopes or the organization', async () => {
    const connection = await service.addConnection(input());
    fake.state.scopes = ['org:read'];
    await expect(service.replaceToken(connection.id, FAKE_TOKEN)).rejects.toThrow(/event:read/);
    fake.state.scopes = null;
    fake.state.organizations = [];
    await expect(service.replaceToken(connection.id, FAKE_TOKEN)).rejects.toThrow(/acme/);
    await expect(service.replaceToken('missing', FAKE_TOKEN)).rejects.toThrow(/no longer exists/);
  });

  it('reports a connection as locked while the vault is', async () => {
    const connection = await linked();
    const { errorTrackingSealedKeys } = await import('./store');
    const unregister = vault.registerSealedSecretStore(errorTrackingSealedKeys);
    try {
      expect((await vault.setPasskey('a servers passkey')).ok).toBe(true);
      vault.lockVault();
      expect((await service.listConnections())[0]).toMatchObject({ locked: true });
      await expect(service.remoteProjects(connection.id)).rejects.toThrow(/Unlock the vault/);
      await expect(
        service.getIssue({ connectionId: connection.id, issueId: '4501' }),
      ).rejects.toThrow(/Unlock the vault/);
      const page = await service.listIssues(query());
      expect(page.failures).toEqual([
        {
          connectionId: connection.id,
          label: 'Acme',
          message: expect.stringMatching(/Unlock the vault/),
          locked: true,
        },
      ]);
      expect(await service.environments()).toEqual([]);
      expect(await vault.unlockVault('a servers passkey')).toBe(true);
      expect((await service.listConnections())[0].locked).toBe(false);
      expect((await service.remoteProjects(connection.id)).length).toBe(3);
    } finally {
      unregister();
      await vault.setPasskey(null);
    }
  });
});

describe('links', () => {
  it('replaces one project links, and says so', async () => {
    const connection = await service.addConnection(input());
    const window = new FakeBrowserWindow();
    const saved = await service.setLinks('p1', [
      link(connection),
      link(connection),
      link(connection, { projectId: 'p2', remoteProjectId: '101' }),
    ]);
    expect(saved).toEqual([link(connection), link(connection, { remoteProjectId: '101' })]);
    await service.setLinks('p2', [link(connection, { projectId: 'p2', remoteProjectId: '103' })]);
    expect((await service.listLinks({ projectId: 'p1' })).length).toBe(2);
    expect((await service.listLinks()).length).toBe(3);
    await service.setLinks('p1', []);
    expect(await service.listLinks({ projectId: 'p1' })).toEqual([]);
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toContainEqual([
      { reason: 'links' },
    ]);
  });

  it('refuses a project or a connection that does not exist', async () => {
    const connection = await service.addConnection(input());
    await expect(service.setLinks('gone', [])).rejects.toThrow(/project no longer exists/);
    await expect(
      service.setLinks('p1', [link(connection, { connectionId: 'gone' })]),
    ).rejects.toThrow(/connection no longer exists/);
  });

  it('lists the remote projects of a connection', async () => {
    const connection = await service.addConnection(input());
    expect((await service.remoteProjects(connection.id)).map((project) => project.slug)).toEqual([
      'storefront-web',
      'storefront-api',
      'billing-worker',
    ]);
    await expect(service.remoteProjects('gone')).rejects.toThrow(/no longer exists/);
  });

  it('lists the environments of the linked projects, without hidden ones', async () => {
    await linked();
    expect(await service.environments()).toEqual(['production', 'staging']);
    expect(await service.environments({ projectId: 'p2' })).toEqual(['production']);
  });

  it('skips a project whose environments cannot be read', async () => {
    const connection = await linked();
    await service.setLinks('p1', [
      link(connection),
      link(connection, { remoteProjectId: '999', remoteSlug: 'gone' }),
    ]);
    expect(await service.environments({ projectId: 'p1' })).toEqual(['production', 'staging']);
  });
});

describe('listIssues', () => {
  it('asks each connection for its linked projects and names where each issue came from', async () => {
    const connection = await linked();
    const page = await service.listIssues(query());
    const [sent] = issueRequests();
    const params = new URL(sent.url, 'http://x').searchParams;
    expect(params.getAll('project').sort()).toEqual(['101', '102']);
    expect(params.get('query')).toBe('is:unresolved');
    expect(params.get('statsPeriod')).toBe('7d');
    expect(page).toEqual({
      issues: [
        expect.objectContaining({
          id: '4501',
          connectionId: connection.id,
          projectId: 'p1',
          isNew: true,
          count: 1287,
        }),
        expect.objectContaining({
          id: '4502',
          connectionId: connection.id,
          projectId: 'p2',
          isNew: false,
        }),
      ],
      nextCursor: null,
      failures: [],
      fetchedAt: NOW,
    });
    expect(JSON.stringify(page)).not.toContain(FAKE_EMAIL);
  });

  it('asks only for one project when the query names it', async () => {
    await linked();
    const page = await service.listIssues(
      query({ projectId: 'p2', status: 'all', search: 'checkout', environment: 'production' }),
    );
    expect(page.issues.map((issue) => issue.id)).toEqual(['4502']);
    const params = new URL(issueRequests()[0].url, 'http://x').searchParams;
    expect(params.getAll('project')).toEqual(['101']);
    expect(params.get('query')).toBe('checkout');
    expect(params.get('environment')).toBe('production');
  });

  it('answers empty without asking anyone when nothing is linked', async () => {
    await service.addConnection(input());
    expect(await service.listIssues(query())).toEqual({
      issues: [],
      nextCursor: null,
      failures: [],
      fetchedAt: NOW,
    });
    expect(issueRequests()).toHaveLength(0);
  });

  it.each([
    ['lastSeen', ['4501', '4502']],
    ['events', ['4501', '4502']],
    ['users', ['4501', '4502']],
    ['newest', ['4501', '4502']],
  ] as const)('sorts by %s across connections', async (sort, ids) => {
    await linked();
    const page = await service.listIssues(query({ sort }));
    expect(page.issues.map((issue) => issue.id)).toEqual(ids);
  });

  it('merges connections and sorts the result as one list', async () => {
    const acme = await service.addConnection(input());
    const side = await service.addConnection(input({ orgSlug: 'side-project' }));
    fake.state.issues.push(
      fakeIssue({
        id: '7001',
        count: '5000',
        userCount: 1,
        firstSeen: '2026-10-18T09:00:00Z',
        lastSeen: '2026-10-18T09:59:00Z',
        project: { id: '201', slug: 'side', name: 'side' },
      }),
    );
    await service.setLinks('p1', [link(acme)]);
    await service.setLinks('p2', [
      link(side, { projectId: 'p2', remoteProjectId: '201', remoteSlug: 'side' }),
    ]);
    const byEvents = await service.listIssues(query({ sort: 'events', refresh: true }));
    expect(byEvents.issues.map((issue) => [issue.id, issue.connectionId])).toEqual([
      ['7001', side.id],
      ['4501', acme.id],
    ]);
    const byUsers = await service.listIssues(query({ sort: 'users', refresh: true }));
    expect(byUsers.issues.map((issue) => issue.id)).toEqual(['4501', '7001']);
    const byNewest = await service.listIssues(query({ sort: 'newest', refresh: true }));
    expect(byNewest.issues.map((issue) => issue.id)).toEqual(['7001', '4501']);
    const byLastSeen = await service.listIssues(query({ sort: 'lastSeen', refresh: true }));
    expect(byLastSeen.issues.map((issue) => issue.id)).toEqual(['7001', '4501']);
  });

  it('keeps answering when one connection fails, and records the problem on it', async () => {
    const acme = await service.addConnection(input());
    const side = await service.addConnection(input({ orgSlug: 'side-project' }));
    await service.setLinks('p1', [link(acme)]);
    await service.setLinks('p2', [link(side, { projectId: 'p2', remoteProjectId: '101' })]);
    fake.state.override = (_request, response, url) => {
      if (!url.pathname.startsWith('/api/0/organizations/side-project/issues/')) return false;
      json(response, { detail: 'down' }, 503);
      return true;
    };
    clock += 120_000;
    const page = await service.listIssues(query());
    expect(page.issues.map((issue) => issue.id)).toEqual(['4501']);
    expect(page.failures).toEqual([
      {
        connectionId: side.id,
        label: 'Side Project',
        message: expect.stringMatching(/HTTP 503/),
        locked: false,
      },
    ]);
    const connections = await service.listConnections();
    expect(connections.find((one) => one.id === side.id)?.problem).toMatch(/HTTP 503/);
    expect(connections.find((one) => one.id === acme.id)).toMatchObject({
      problem: null,
      checkedAt: clock,
    });

    fake.state.override = null;
    await service.listIssues(query({ refresh: true }));
    expect((await service.listConnections()).find((one) => one.id === side.id)?.problem).toBeNull();
  });

  it('keeps a short cache, skipped by refresh and dropped after a minute', async () => {
    await linked();
    const first = await service.listIssues(query());
    expect(await service.listIssues(query())).toEqual(first);
    expect(issueRequests()).toHaveLength(1);
    await service.listIssues(query({ refresh: true }));
    expect(issueRequests()).toHaveLength(2);
    clock += 61_000;
    await service.listIssues(query());
    expect(issueRequests()).toHaveLength(3);
    await service.listIssues(query({ status: 'resolved' }));
    expect(issueRequests()).toHaveLength(4);
  });

  it('does not cache a page with a failure', async () => {
    await linked();
    fake.state.override = (_request, response, url) => {
      if (!url.pathname.endsWith('/issues/')) return false;
      json(response, {}, 500);
      return true;
    };
    await service.listIssues(query());
    await service.listIssues(query());
    expect(issueRequests()).toHaveLength(2);
  });

  it('drops the cache when links change', async () => {
    const connection = await linked();
    await service.listIssues(query());
    await service.setLinks('p1', [link(connection)]);
    await service.listIssues(query());
    expect(issueRequests()).toHaveLength(2);
    service.clearCache();
    await service.listIssues(query());
    expect(issueRequests()).toHaveLength(3);
  });

  it('pages with an opaque cursor that asks only the connections with more', async () => {
    const acme = await service.addConnection(input());
    const side = await service.addConnection(input({ orgSlug: 'side-project' }));
    await service.setLinks('p1', [link(acme)]);
    await service.setLinks('p2', [link(side, { projectId: 'p2', remoteProjectId: '101' })]);
    fake.state.override = (_request, response, url) => {
      if (!url.pathname.startsWith('/api/0/organizations/acme/issues/')) return false;
      const cursor = url.searchParams.get('cursor');
      response.writeHead(200, {
        'content-type': 'application/json',
        link: `<x>; rel="next"; results="${cursor ? 'false' : 'true'}"; cursor="0:50:0"`,
      });
      response.end(JSON.stringify(cursor ? [] : [fakeIssue()]));
      return true;
    };
    const first = await service.listIssues(query());
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain('0:50:0');
    const before = issueRequests().length;
    const second = await service.listIssues(query({ cursor: first.nextCursor }));
    const asked = issueRequests().slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toContain('/organizations/acme/');
    expect(asked[0].url).toContain('cursor=0%3A50%3A0');
    expect(second).toMatchObject({ issues: [], nextCursor: null });
  });

  it('refuses a cursor it did not make', async () => {
    await linked();
    await expect(service.listIssues(query({ cursor: 'garbage' }))).rejects.toThrow(/Refresh/);
    const wrongShape = Buffer.from(JSON.stringify(['x'])).toString('base64url');
    await expect(service.listIssues(query({ cursor: wrongShape }))).rejects.toThrow(/Refresh/);
  });

  it('leaves out an issue of a project nobody linked', async () => {
    await linked();
    fake.state.override = (_request, response, url) => {
      if (!url.pathname.endsWith('/issues/')) return false;
      json(response, [fakeIssue({ project: { id: '555', slug: 'x', name: 'x' } })]);
      return true;
    };
    expect((await service.listIssues(query())).issues).toEqual([]);
  });
});

describe('one issue', () => {
  it('reads the issue with its latest event', async () => {
    const connection = await linked();
    const detail = await service.getIssue({ connectionId: connection.id, issueId: '4501' });
    expect(detail.issue).toMatchObject({
      id: '4501',
      projectId: 'p1',
      connectionId: connection.id,
    });
    expect(detail.event?.eventId).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(detail.canWrite).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(FAKE_EMAIL);
  });

  it('answers without an event when there is none, and without a project when none is linked', async () => {
    const connection = await service.addConnection(input());
    const detail = await service.getIssue({ connectionId: connection.id, issueId: '4502' });
    expect(detail.event).toBeNull();
    expect(detail.issue.projectId).toBe('');
  });

  it('refuses a connection that is gone, and passes on what Sentry said', async () => {
    const connection = await linked();
    await expect(service.getIssue({ connectionId: 'gone', issueId: '1' })).rejects.toThrow(
      /no longer exists/,
    );
    await expect(service.getIssue({ connectionId: connection.id, issueId: '1' })).rejects.toThrow(
      /could not find/,
    );
    expect((await service.listConnections())[0].problem).toBeNull();
  });

  it('builds the fix prompt and the copy with the project name', async () => {
    const connection = await linked();
    const result = await service.fixPrompt({ connectionId: connection.id, issueId: '4501' });
    expect(result.prompt).toContain('Shop');
    expect(result.prompt).toContain('computeTotals');
    expect(result.copy).toContain('computeTotals');
    expect(result.prompt).not.toBe(result.copy);
    expect(JSON.stringify(result)).not.toContain(FAKE_EMAIL);
  });

  it('names the provider project in the prompt when no project is linked', async () => {
    const connection = await service.addConnection(input());
    const result = await service.fixPrompt({ connectionId: connection.id, issueId: '4501' });
    expect(result.prompt).toContain('storefront-api');
  });
});

describe('setIssueStatus', () => {
  it('resolves, drops the cache and says the issues changed', async () => {
    const connection = await linked();
    await service.listIssues(query());
    const window = new FakeBrowserWindow();
    const issue = await service.setIssueStatus({
      connectionId: connection.id,
      issueId: '4501',
      status: 'resolved',
    });
    expect(issue).toMatchObject({ id: '4501', status: 'resolved', projectId: 'p1' });
    const [put] = fake.requestsTo('/api/0/organizations/acme/issues/4501/', 'PUT');
    expect(JSON.parse(put.body)).toEqual({ status: 'resolved' });
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toEqual([
      [{ reason: 'issues' }],
    ]);
    await service.listIssues(query());
    expect(issueRequests()).toHaveLength(2);
  });

  it('ignores for a while or for good', async () => {
    const connection = await linked();
    const ref = { connectionId: connection.id, issueId: '4501' };
    await service.setIssueStatus({ ...ref, status: 'ignored', ignoreMinutes: 60 });
    await service.setIssueStatus({ ...ref, status: 'ignored' });
    const bodies = fake
      .requestsTo('/api/0/organizations/acme/issues/4501/', 'PUT')
      .map((request) => JSON.parse(request.body));
    expect(bodies).toEqual([
      { status: 'ignored', ignoreDuration: 60 },
      { status: 'ignored', substatus: 'archived_forever' },
    ]);
  });

  it('learns from a refused write that the token cannot write', async () => {
    fake.state.scopes = null;
    const connection = await linked();
    fake.state.scopes = ['org:read', 'project:read', 'event:read'];
    const window = new FakeBrowserWindow();
    await expect(
      service.setIssueStatus({ connectionId: connection.id, issueId: '4501', status: 'resolved' }),
    ).rejects.toThrow(/event:write/);
    expect((await service.listConnections())[0].canWrite).toBe(false);
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toEqual([
      [{ reason: 'connections' }],
    ]);

    fake.state.scopes = null;
    await service.setIssueStatus({
      connectionId: connection.id,
      issueId: '4501',
      status: 'resolved',
    });
    expect((await service.listConnections())[0].canWrite).toBe(true);
  });

  it('passes on any other failure', async () => {
    const connection = await linked();
    await expect(
      service.setIssueStatus({ connectionId: connection.id, issueId: '999', status: 'resolved' }),
    ).rejects.toThrow(/could not find/);
  });
});

describe('the app service', () => {
  it('is one shared instance', () => {
    expect(module.getErrorTrackingService()).toBe(module.getErrorTrackingService());
  });
});
