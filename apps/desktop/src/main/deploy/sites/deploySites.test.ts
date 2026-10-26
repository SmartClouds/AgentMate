import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreErrorCode, encodeCoreError } from '../../../shared/coreErrors';
import type { SiteSettings } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FAKE_CORE_PASSWORD, FakeCore } from '../../../shared/deploy/testing/fakeCore';
import { CoreLinks } from '../live/coreLinks';
import { fakeLiveHubs } from '../testing/fakeLiveHub';
import { DeploySites } from './deploySites';

/**
 * The Websites section's calls on the server's lasting connection: reading nginx, saving and
 * applying sites, and certificates. Removing a certificate needs a step-up the call can make on
 * the way; a refusal says whether the password or the role is missing.
 */

let links: CoreLinks | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  links?.closeAll();
  links = null;
  vi.useRealTimers();
});

function setup(roles: string[] | null = ['owner']) {
  const core = new FakeCore(() => Date.now());
  if (roles) core.roles = roles;
  const hubs = fakeLiveHubs(core);
  links = new CoreLinks({ open: () => hubs.open() });
  const sites = new DeploySites({ links, roles: () => roles });
  return { core, hubs, sites };
}

function blog(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
    id: 'blog',
    domains: ['blog.example.com'],
    upstream: {
      kind: 'servicePort',
      service: 'web',
      port: 3000,
      verifyCertificate: true,
      sendUpstreamHost: false,
    },
    websocket: false,
    gzip: true,
    http2: true,
    redirectToHttps: false,
    ...overrides,
  };
}

describe('DeploySites reads and changes', () => {
  it('installs nginx, saves a site, applies it and lists it live', async () => {
    const { core, sites } = setup();
    expect((await sites.status('srv-1')).managed).toBe(false);

    const job = await sites.install('srv-1');
    core.nginx.complete(job.id);
    expect((await sites.status('srv-1')).managed).toBe(true);

    const saved = await sites.saveSite('srv-1', blog());
    expect(saved.problems).toEqual([]);
    expect((await sites.sites('srv-1'))[0].applied).toBe(false);
    expect((await sites.status('srv-1')).pendingChanges).toBe(true);

    const applied = await sites.apply('srv-1');
    expect(applied).toMatchObject({ applied: true, release: 1 });
    expect((await sites.sites('srv-1'))[0].applied).toBe(true);
    expect((await sites.status('srv-1')).pendingChanges).toBe(false);
  });

  it('hands back the problems of a site it would not save', async () => {
    const { sites } = setup();
    const result = await sites.saveSite('srv-1', blog({ domains: ['not a domain'] }));
    expect(result.problems).toEqual([
      expect.objectContaining({ field: 'sites[blog].domains[0]', siteId: 'blog' }),
    ]);
    expect(await sites.sites('srv-1')).toEqual([]);
  });

  it('saves and deletes stream proxies and sites', async () => {
    const { sites } = setup();
    await sites.saveSite('srv-1', blog());
    const proxy = await sites.saveStream('srv-1', {
      id: 'pg',
      protocol: 'tcp',
      listenPort: 5432,
      upstream: {
        kind: 'endpoint',
        address: '127.0.0.1:5433',
        verifyCertificate: false,
        sendUpstreamHost: false,
      },
    });
    expect(proxy.proxy?.settings.listenPort).toBe(5432);
    expect(await sites.streams('srv-1')).toHaveLength(1);

    await sites.deleteStream('srv-1', 'pg');
    await sites.deleteSite('srv-1', 'blog');
    expect(await sites.streams('srv-1')).toEqual([]);
    expect(await sites.sites('srv-1')).toEqual([]);
    await expect(sites.deleteSite('srv-1', 'blog')).rejects.toThrow(/^There is no such site\.$/);
  });

  it('sets snippets for an Owner and maps a refused directive to its line', async () => {
    const { sites } = setup();
    await sites.saveSite('srv-1', blog());
    const refused = await sites.setSnippets('srv-1', {
      siteId: 'blog',
      locationSnippet: 'proxy_buffering off;\ninclude /etc/passwd;',
    });
    expect(refused.problems[0]).toMatchObject({ field: 'sites[blog].locationSnippet', line: 2 });

    const saved = await sites.setSnippets('srv-1', {
      siteId: 'blog',
      serverSnippet: 'charset utf-8;',
    });
    expect(saved.site?.serverSnippet).toBe('charset utf-8;');
  });
});

describe('DeploySites certificates', () => {
  it('issues with the terms accepted, renews, uploads and lists them', async () => {
    const { core, sites } = setup();
    await sites.saveSite('srv-1', blog());
    await expect(
      sites.issue({
        serverId: 'srv-1',
        siteId: 'blog',
        acceptTermsOfService: false,
        staging: false,
      }),
    ).rejects.toThrow(/terms of service/);

    const order = await sites.issue({
      serverId: 'srv-1',
      siteId: 'blog',
      acceptTermsOfService: true,
      staging: true,
      contactEmail: 'ops@example.com',
    });
    expect(order.kind).toBe('certificateIssue');
    core.nginx.complete(order.id);
    const [issued] = await sites.certificates('srv-1');
    expect(issued).toMatchObject({ siteId: 'blog', staging: true, lastJobId: order.id });

    const renewal = await sites.renew('srv-1', 'blog');
    expect(renewal.kind).toBe('certificateRenew');

    const upload = await sites.upload({
      serverId: 'srv-1',
      siteId: 'blog',
      certificatePem: '-----BEGIN CERTIFICATE-----',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----',
    });
    expect(upload.certificate?.source).toBe('uploaded');
  });

  it('removes a certificate with the password, after asking for it', async () => {
    const { core, sites } = setup(['admin']);
    core.nginx.status = { ...core.nginx.status, managed: true };
    await sites.saveSite('srv-1', blog());
    core.nginx.complete(
      (
        await sites.issue({
          serverId: 'srv-1',
          siteId: 'blog',
          acceptTermsOfService: true,
          staging: false,
        })
      ).id,
    );

    const refused = await sites
      .removeCertificate({
        serverId: 'srv-1',
        siteId: 'blog',
        revoke: false,
        reason: 'unspecified',
      })
      .catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('stepUpRequired');

    await expect(
      sites.removeCertificate({
        serverId: 'srv-1',
        siteId: 'blog',
        revoke: true,
        reason: 'superseded',
        password: 'wrong',
      }),
    ).rejects.toThrow(/^That password is not right\.$/);

    const removed = await sites.removeCertificate({
      serverId: 'srv-1',
      siteId: 'blog',
      revoke: true,
      reason: 'superseded',
      password: FAKE_CORE_PASSWORD,
    });
    expect(removed.applied).toBe(true);
    expect(await sites.certificates('srv-1')).toEqual([]);
  });

  it('steps up with an authenticator code when that is what it was handed', async () => {
    const { core, sites } = setup();
    await sites.saveSite('srv-1', blog());
    core.nginx.complete(
      (
        await sites.issue({
          serverId: 'srv-1',
          siteId: 'blog',
          acceptTermsOfService: true,
          staging: false,
        })
      ).id,
    );
    await expect(
      sites.removeCertificate({
        serverId: 'srv-1',
        siteId: 'blog',
        revoke: false,
        reason: 'unspecified',
        totpCode: '123456',
      }),
    ).rejects.toThrow(/password is not right/);
  });
});

describe('DeploySites refusals', () => {
  it('says the role is missing when an Operator changes a site', async () => {
    const { sites } = setup(['operator']);
    const refused = await sites.saveSite('srv-1', blog()).catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('forbidden');
    expect((refused as Error).message).toMatch(/\(operator\) cannot do that/);
  });

  it('says the role is missing, not the password, when an Operator removes a certificate', async () => {
    const { sites } = setup(['operator']);
    const refused = await sites
      .removeCertificate({
        serverId: 'srv-1',
        siteId: 'blog',
        revoke: false,
        reason: 'unspecified',
      })
      .catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('forbidden');
  });

  it('asks for the password when it does not know the roles', async () => {
    const { core, sites } = setup(null);
    core.roles = ['admin'];
    const refused = await sites
      .removeCertificate({
        serverId: 'srv-1',
        siteId: 'blog',
        revoke: false,
        reason: 'unspecified',
      })
      .catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('stepUpRequired');
  });

  it('names no roles when it knows of none, and passes coded refusals through', async () => {
    const { core, hubs, sites } = setup([]);
    core.roles = ['viewer'];
    const refused = await sites.apply('srv-1').catch((error: unknown) => error);
    expect((refused as Error).message).toMatch(/Your role on this server cannot do that/);

    links?.closeAll();
    const coded = new Error(encodeCoreError('sessionExpired', 'Sign in again.'));
    hubs.failNext(coded);
    links = new CoreLinks({ open: () => hubs.open() });
    const again = new DeploySites({ links, roles: () => null });
    const failure = await again.status('srv-1').catch((error: unknown) => error);
    expect(coreErrorCode(failure)).toBe('sessionExpired');
  });
});
