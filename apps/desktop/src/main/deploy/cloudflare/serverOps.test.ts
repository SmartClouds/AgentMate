import { afterEach, describe, expect, it } from 'vitest';
import { cloudflareErrorCode, cloudflareErrorPermission } from '../../../shared/cloudflareErrors';
import type { SiteSettings } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FakeCore } from '../../../shared/deploy/testing/fakeCore';
import { CoreLinks } from '../live/coreLinks';
import { fakeLiveHubs } from '../testing/fakeLiveHub';
import { CloudflareServerOps, zoneOf } from './serverOps';
import { ALL_GRANTS, type FakeToken } from './testing/fakeCloudflare';
import { connectedService, makeService, TOKEN } from './testing/harness';
import { dnsRecord, OTHER_ZONE_ID, ZONE_ID } from './testing/recorded';

/**
 * E14 T5 to T7 from the main process: an Origin CA certificate signed with the account token
 * for a key the core made, the origin lock with Authenticated Origin Pulls turned on at
 * Cloudflare first, and a separate DNS token for a server, made or pasted. The account token
 * itself never reaches the core.
 */

let links: CoreLinks | null = null;

afterEach(() => {
  links?.closeAll();
  links = null;
});

function site(id: string, domains: string[]): SiteSettings {
  return {
    id,
    domains,
    upstream: {
      kind: 'servicePort',
      service: 'web',
      port: 3000,
      verifyCertificate: true,
      sendUpstreamHost: false,
    },
    websocket: false,
    gzip: false,
    http2: true,
    redirectToHttps: true,
  };
}

async function setup(options: { grants?: FakeToken['grants']; roles?: string[] } = {}) {
  const core = new FakeCore(() => Date.now());
  if (options.roles) core.roles = options.roles;
  core.nginx.status = { ...core.nginx.status, managed: true };
  core.nginx.saveSite(site('blog', ['blog.example.com', 'www.example.com']));
  const hubs = fakeLiveHubs(core);
  links = new CoreLinks({ open: () => hubs.open() });
  const harness = await connectedService({
    token: {
      grants: options.grants ?? { ...ALL_GRANTS, sslCertificates: 'edit', apiTokens: 'edit' },
    },
    zones: [
      {
        id: ZONE_ID,
        name: 'example.com',
        records: [
          {
            ...dnsRecord,
            id: 'a'.repeat(32),
            type: 'A',
            name: 'blog.example.com',
            content: '203.0.113.10',
            proxied: true,
          },
          {
            ...dnsRecord,
            id: 'b'.repeat(32),
            type: 'A',
            name: 'www.example.com',
            content: '203.0.113.10',
            proxied: false,
          },
        ],
      },
      { id: OTHER_ZONE_ID, name: 'example.org' },
    ],
  });
  const ops = new CloudflareServerOps({
    cloudflare: harness.service,
    links,
    roles: () => core.roles,
    onLinkConnection: (_serverId, work) => work('203.0.113.50 50123 192.0.2.10 22'),
    serverName: async () => 'prod',
  });
  return { core, ops, ...harness };
}

describe('zoneOf', () => {
  it('picks the longest zone a name ends in, wildcards included', () => {
    const zones = [
      {
        id: '1',
        accountId: 'a',
        name: 'example.com',
        status: 'active',
        paused: false,
        plan: '',
        nameServers: [],
      },
      {
        id: '2',
        accountId: 'a',
        name: 'dev.example.com',
        status: 'active',
        paused: false,
        plan: '',
        nameServers: [],
      },
    ];
    expect(zoneOf('*.api.dev.example.com', zones)?.id).toBe('2');
    expect(zoneOf('example.com', zones)?.id).toBe('1');
    expect(zoneOf('notexample.com', zones)).toBeNull();
  });
});

describe('Origin CA certificates', () => {
  it('sends the core its signing request to Cloudflare and installs what comes back', async () => {
    const { ops, core, fake } = await setup();

    const result = await ops.originCertificate({ serverId: 'srv-1', siteId: 'blog' });

    expect(result.problems).toEqual([]);
    expect(result.certificate?.source).toBe('cloudflareOrigin');
    const sent = fake.requests.find((request) => request.path === '/certificates');
    expect(sent?.body).toMatchObject({
      hostnames: ['blog.example.com', 'www.example.com'],
      request_type: 'origin-ecc',
      requested_validity: 5475,
    });
    expect(String((sent?.body as { csr?: string } | undefined)?.csr)).toContain(
      'CERTIFICATE REQUEST',
    );
    expect(core.nginx.sites.get('blog')?.certificate?.source).toBe('cloudflareOrigin');
  });

  it('names SSL and Certificates as the permission to add when Cloudflare refuses', async () => {
    const { ops, core } = await setup({ grants: ALL_GRANTS });

    const refused = await ops
      .originCertificate({ serverId: 'srv-1', siteId: 'blog' })
      .catch((e) => e);

    expect(cloudflareErrorCode(refused)).toBe('missing-permission');
    expect(cloudflareErrorPermission(refused)).toBe('sslCertificates');
    expect(String(refused.message)).toContain('Zone > SSL and Certificates > Edit');
    expect(core.nginx.sites.get('blog')?.certificate).toBeUndefined();
  });
});

describe('the origin lock', () => {
  it('previews the core plan with each site domain checked against Cloudflare', async () => {
    const { ops } = await setup();

    const plan = await ops.previewOriginLock({
      serverId: 'srv-1',
      enabled: true,
      authenticatedOriginPulls: false,
    });

    expect(plan.preview.changes.length).toBeGreaterThan(0);
    expect(plan.domains).toEqual([
      { domain: 'blog.example.com', zoneId: ZONE_ID, zoneName: 'example.com', proxied: true },
      { domain: 'www.example.com', zoneId: ZONE_ID, zoneName: 'example.com', proxied: false },
    ]);
  });

  it('turns client certificates on at Cloudflare before the core asks for them', async () => {
    const { ops, fake, core } = await setup();

    const result = await ops.applyOriginLock({
      serverId: 'srv-1',
      enabled: true,
      authenticatedOriginPulls: true,
    });

    expect(fake.zones.get(ZONE_ID)?.settings.tls_client_auth.value).toBe('on');
    expect(fake.zones.get(OTHER_ZONE_ID)?.settings.tls_client_auth.value).toBe('off');
    expect(result.status.state).toBe('pending');
    expect(result.changeSet?.state).toBe('awaitingConfirmation');
    expect(core.cloudflare.authenticatedOriginPulls).toBe(true);
  });

  it('refuses client certificates while a site domain is outside the account', async () => {
    const { ops, core, fake } = await setup();
    core.nginx.saveSite(site('shop', ['shop.example.net']));

    const refused = await ops
      .applyOriginLock({ serverId: 'srv-1', enabled: true, authenticatedOriginPulls: true })
      .catch((e) => e);

    expect(String(refused.message)).toContain('shop.example.net');
    expect(fake.writes()).toEqual([]);
    expect(core.cloudflare.enabled).toBe(false);
  });
});

describe('DNS tokens for a server', () => {
  it('makes a token limited to DNS Write on the one zone and sends only that one', async () => {
    const { ops, core, fake } = await setup();

    const credential = await ops.provisionDnsToken({
      serverId: 'srv-1',
      zoneId: ZONE_ID,
      mode: 'mint',
    });

    const sent = core.cloudflare.credentials.get('example.com');
    expect(credential).toMatchObject({ zone: 'example.com', zoneId: ZONE_ID });
    expect(credential).not.toHaveProperty('token');
    expect(sent?.token).not.toBe(TOKEN);
    expect(fake.tokens[sent?.token ?? '']).toMatchObject({
      grants: { dns: 'edit' },
      zoneIds: [ZONE_ID],
    });
    const created = fake.requests.find(
      (request) => request.path === '/user/tokens' && request.method === 'POST',
    );
    expect(created?.body).toMatchObject({
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.zone.${ZONE_ID}`]: '*' },
          permission_groups: [{ id: '4755a26eedb94da69e1066d98aa820be' }],
        },
      ],
    });
    expect(sent?.tokenId).toBe(fake.tokens[sent?.token ?? '']?.id);
  });

  it('guides to API Tokens Edit, or pasting a token, when the account token cannot make one', async () => {
    const { ops, core } = await setup({ grants: ALL_GRANTS });

    const refused = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'mint' })
      .catch((e) => e);

    expect(cloudflareErrorPermission(refused)).toBe('apiTokens');
    expect(String(refused.message)).toContain('User > API Tokens > Edit');
    expect(core.cloudflare.credentials.size).toBe(0);
  });

  it('checks a pasted token and never sends the account token itself', async () => {
    const { ops, core, fake } = await setup();
    fake.tokens['Zt9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q'] = {
      grants: { dns: 'edit' },
      zoneIds: [ZONE_ID],
    };
    fake.tokens['Xx9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q'] = {
      grants: { dns: 'edit' },
      zoneIds: [OTHER_ZONE_ID],
    };

    const own = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'paste', token: TOKEN })
      .catch((e) => e);
    const other = await ops
      .provisionDnsToken({
        serverId: 'srv-1',
        zoneId: ZONE_ID,
        mode: 'paste',
        token: 'Xx9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q',
      })
      .catch((e) => e);
    const good = await ops.provisionDnsToken({
      serverId: 'srv-1',
      zoneId: ZONE_ID,
      mode: 'paste',
      token: 'Zt9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q',
    });

    expect(String(own.message)).toContain('never goes to a server');
    expect(String(other.message)).toContain('cannot read the DNS records of example.com');
    expect(good.zone).toBe('example.com');
    expect(core.cloudflare.credentials.get('example.com')?.token).toBe(
      'Zt9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q',
    );
    expect([...core.cloudflare.credentials.values()].some((item) => item.token === TOKEN)).toBe(
      false,
    );
  });

  it('deletes a token it made at Cloudflare when the server refuses it, and when it is removed', async () => {
    const { ops, core, fake } = await setup();
    await ops.provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'mint' });
    const minted = core.cloudflare.credentials.get('example.com')?.token ?? '';

    await ops.removeDnsToken({ serverId: 'srv-1', zone: 'example.com', deleteAtCloudflare: true });

    expect(core.cloudflare.credentials.size).toBe(0);
    expect(fake.tokens[minted]).toBeUndefined();
  });

  it('is an Admin action on the core', async () => {
    const { ops } = await setup({ roles: ['operator'] });

    const refused = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'mint' })
      .catch((e) => e);

    expect(String(refused.message)).toContain('cannot do that');
  });
});

describe('the edges', () => {
  it('reads the lock, previews turning it off, and handles a server without sites', async () => {
    const { ops, core } = await setup();
    core.nginx.sites.clear();

    expect((await ops.originLock('srv-1')).state).toBe('off');
    const plan = await ops.previewOriginLock({
      serverId: 'srv-1',
      enabled: false,
      authenticatedOriginPulls: false,
    });
    const result = await ops.applyOriginLock({
      serverId: 'srv-1',
      enabled: true,
      authenticatedOriginPulls: true,
    });

    expect(plan.domains).toEqual([]);
    expect(result.status.enabled).toBe(true);
  });

  it('says when a site domain has no address record, or the zone is unknown', async () => {
    const { ops, core } = await setup();
    core.nginx.saveSite(site('api', ['api.example.com']));

    const plan = await ops.previewOriginLock({
      serverId: 'srv-1',
      enabled: true,
      authenticatedOriginPulls: false,
    });
    const missingZone = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: 'f'.repeat(32), mode: 'mint' })
      .catch((e) => e);

    expect(plan.domains.find((check) => check.domain === 'api.example.com')?.proxied).toBeNull();
    expect(String(missingZone.message)).toContain('not in a connected Cloudflare account');
  });

  it('names a single domain outside the account', async () => {
    const { ops, core } = await setup();
    core.nginx.sites.clear();
    core.nginx.saveSite(site('shop', ['shop.example.net']));

    const refused = await ops
      .applyOriginLock({ serverId: 'srv-1', enabled: true, authenticatedOriginPulls: true })
      .catch((e) => e);

    expect(String(refused.message)).toContain('holds it');
  });

  it('refuses a pasted token that cannot be one, or that Cloudflare has turned off', async () => {
    const { ops, fake } = await setup();
    fake.tokens['Dd9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q'] = {
      grants: { dns: 'edit' },
      status: 'disabled',
    };

    const short = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'paste', token: 'short' })
      .catch((e) => e);
    const disabled = await ops
      .provisionDnsToken({
        serverId: 'srv-1',
        zoneId: ZONE_ID,
        mode: 'paste',
        token: 'Dd9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q',
      })
      .catch((e) => e);

    expect(String(short.message)).toContain('too short');
    expect(String(disabled.message)).toContain('disabled');
  });

  it('deletes a token it made when the server will not keep it', async () => {
    const { ops, core, fake } = await setup();
    const original = core.cloudflare.saveCredential.bind(core.cloudflare);
    core.cloudflare.saveCredential = () => ({ problems: ['The token could not be checked.'] });

    const refused = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'mint' })
      .catch((e) => e);
    core.cloudflare.saveCredential = () => {
      throw new Error('core down');
    };
    const failed = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'mint' })
      .catch((e) => e);
    core.cloudflare.saveCredential = original;

    expect(String(refused.message)).toContain('could not be checked');
    expect(String(failed.message)).toContain('core down');
    const minted = Object.values(fake.tokens).filter((token) => token.zoneIds?.includes(ZONE_ID));
    expect(minted).toEqual([]);
  });

  it('keeps a token it did not make at Cloudflare when removing it', async () => {
    const { ops, core, fake } = await setup();
    fake.tokens['Zt9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q'] = {
      grants: { dns: 'edit' },
      zoneIds: [ZONE_ID],
    };
    await ops.provisionDnsToken({
      serverId: 'srv-1',
      zoneId: ZONE_ID,
      mode: 'paste',
      token: 'Zt9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q',
    });

    await ops.removeDnsToken({ serverId: 'srv-1', zone: 'example.com', deleteAtCloudflare: true });

    expect(core.cloudflare.credentials.size).toBe(0);
    expect(fake.tokens['Zt9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q']).toBeDefined();
    expect(fake.writes().some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('stops when Cloudflare lists no DNS Write group or returns no token', async () => {
    const { ops, fake } = await setup();
    fake.failNext(/^\/user\/tokens\/permission_groups$/, 200, {
      success: true,
      errors: [],
      messages: [],
      result: [],
    });
    const noGroup = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'mint' })
      .catch((e) => e);
    fake.failNext(/^\/user\/tokens$/, 200, {
      success: true,
      errors: [],
      messages: [],
      result: { id: 'a'.repeat(32) },
    });
    const noValue = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'mint' })
      .catch((e) => e);

    expect(String(noGroup.message)).toContain('DNS Write permission group');
    expect(String(noValue.message)).toContain('did not return it');
  });

  it('stops when Cloudflare signs nothing', async () => {
    const { ops, fake } = await setup();
    fake.failNext(/^\/certificates$/, 200, {
      success: true,
      errors: [],
      messages: [],
      result: { id: '1' },
    });

    const refused = await ops
      .originCertificate({ serverId: 'srv-1', siteId: 'blog' })
      .catch((e) => e);

    expect(String(refused.message)).toContain('without the certificate');
  });
});

describe('with several accounts', () => {
  const SECOND_TOKEN = 'Zt9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q';

  async function twoAccounts(domains: string[]) {
    const core = new FakeCore(() => Date.now());
    core.nginx.status = { ...core.nginx.status, managed: true };
    core.nginx.saveSite(site('blog', domains));
    const hubs = fakeLiveHubs(core);
    links = new CoreLinks({ open: () => hubs.open() });
    const grants = { ...ALL_GRANTS, sslCertificates: 'edit', apiTokens: 'edit' } as const;
    const harness = makeService({
      tokens: {
        [TOKEN]: { grants, zoneIds: [ZONE_ID] },
        [SECOND_TOKEN]: { grants, zoneIds: [OTHER_ZONE_ID], id: 'c'.repeat(32) },
      },
      zones: [
        { id: ZONE_ID, name: 'example.com' },
        { id: OTHER_ZONE_ID, name: 'example.org' },
      ],
    });
    await harness.service.saveToken({ token: TOKEN });
    await harness.service.saveToken({ token: SECOND_TOKEN });
    harness.fake.requests.length = 0;
    const ops = new CloudflareServerOps({
      cloudflare: harness.service,
      links,
      roles: () => core.roles,
      onLinkConnection: (_serverId, work) => work('203.0.113.50 50123 192.0.2.10 22'),
      serverName: async () => 'prod',
    });
    return { core, ops, ...harness };
  }

  it('signs a certificate with the token of the account that holds the domain', async () => {
    const { ops, fake } = await twoAccounts(['blog.example.org']);

    await ops.originCertificate({ serverId: 'srv-1', siteId: 'blog' });

    const signed = fake.requests.find((request) => request.path === '/certificates');
    expect(signed?.headers.get('authorization')).toBe(`Bearer ${SECOND_TOKEN}`);
  });

  it('will not sign one certificate for names in different accounts', async () => {
    const { ops, fake } = await twoAccounts(['blog.example.com', 'blog.example.org']);

    const refused = await ops
      .originCertificate({ serverId: 'srv-1', siteId: 'blog' })
      .catch((e) => e);

    expect(String(refused.message)).toContain('different Cloudflare accounts');
    expect(fake.requests.some((request) => request.path === '/certificates')).toBe(false);
  });

  it('names a domain that no connected account holds', async () => {
    const { ops } = await twoAccounts(['blog.example.net']);

    const refused = await ops
      .originCertificate({ serverId: 'srv-1', siteId: 'blog' })
      .catch((e) => e);

    expect(String(refused.message)).toContain(
      'No connected Cloudflare account holds blog.example.net',
    );
  });

  it('turns client certificates on in each account that holds one of the site zones', async () => {
    const { ops, fake } = await twoAccounts(['blog.example.com', 'blog.example.org']);

    await ops.applyOriginLock({ serverId: 'srv-1', enabled: true, authenticatedOriginPulls: true });

    expect(fake.zones.get(ZONE_ID)?.settings.tls_client_auth.value).toBe('on');
    expect(fake.zones.get(OTHER_ZONE_ID)?.settings.tls_client_auth.value).toBe('on');
  });

  it('makes a DNS token in the account of the zone, and refuses any account token pasted', async () => {
    const { ops, core, fake } = await twoAccounts(['blog.example.org']);

    await ops.provisionDnsToken({ serverId: 'srv-1', zoneId: OTHER_ZONE_ID, mode: 'mint' });
    const created = fake.requests.find(
      (request) => request.path === '/user/tokens' && request.method === 'POST',
    );
    const pasted = await ops
      .provisionDnsToken({ serverId: 'srv-1', zoneId: ZONE_ID, mode: 'paste', token: SECOND_TOKEN })
      .catch((e) => e);

    expect(created?.headers.get('authorization')).toBe(`Bearer ${SECOND_TOKEN}`);
    expect(core.cloudflare.credentials.has('example.org')).toBe(true);
    expect(String(pasted.message)).toContain('never goes to a server');
  });

  it('deletes a minted token through the account that made it', async () => {
    const { ops, core, fake } = await twoAccounts(['blog.example.org']);
    await ops.provisionDnsToken({ serverId: 'srv-1', zoneId: OTHER_ZONE_ID, mode: 'mint' });
    const minted = core.cloudflare.credentials.get('example.org')?.token ?? '';

    await ops.removeDnsToken({ serverId: 'srv-1', zone: 'example.org', deleteAtCloudflare: true });

    const deleted = fake.requests.find((request) => request.method === 'DELETE');
    expect(deleted?.headers.get('authorization')).toBe(`Bearer ${SECOND_TOKEN}`);
    expect(fake.tokens[minted]).toBeUndefined();
  });
});
