import { describe, expect, it } from 'vitest';
import { missingPermissionLabels } from '../../../shared/cloudflare/permissions';
import {
  cloudflareErrorCode,
  cloudflareErrorMessage,
  cloudflareErrorPermission,
} from '../../../shared/cloudflareErrors';
import type { CloudflarePermissionId, CloudflareStatus } from '../../../shared/cloudflareTypes';
import { ALL_GRANTS, type FakeToken } from './testing/fakeCloudflare';
import { ACCOUNT, connectedService, makeService, NOW, TOKEN } from './testing/harness';
import { dnsRecord, OTHER_ZONE_ID, RECORD_ID, TOKEN_ID, ZONE_ID } from './testing/recorded';

/**
 * The Cloudflare service in the main process: the token goes in once, sealed, and never comes
 * back out; zones, DNS records and zone settings go through the official SDK against the fake
 * Cloudflare API, with Cloudflare's refusals turned into words the page can act on.
 */

function stateOf(status: CloudflareStatus, id: CloudflarePermissionId): string | undefined {
  return status.accounts[0]?.report?.permissions.find((check) => check.id === id)?.state;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to fail');
}

describe('the token (T1)', () => {
  it('starts with nothing saved', async () => {
    const { service } = makeService();
    expect(await service.status()).toEqual({ configured: false, locked: false, accounts: [] });
  });

  it('checks a pasted token, seals it and keeps only the report where the page can see it', async () => {
    const { service, fake, port, seal } = makeService();

    const status = await service.saveToken({ token: TOKEN });

    expect(status.configured).toBe(true);
    expect(status.accounts[0]?.report).toMatchObject({
      tokenId: TOKEN_ID,
      status: 'active',
      checkedAt: NOW,
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(seal).toHaveBeenCalledWith(TOKEN);
    expect(JSON.stringify(port.value)).not.toContain(TOKEN);
    // The token travelled in the Authorization header and nowhere else.
    for (const request of fake.requests) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(`${request.path}?${request.query}`).not.toContain(TOKEN);
      expect(JSON.stringify(request.body ?? null)).not.toContain(TOKEN);
    }
    expect(fake.writes()).toEqual([]);
    expect(await service.status()).toEqual(status);
  });

  it('saves a token with missing permissions and says exactly what to add (AC1)', async () => {
    const { service } = makeService({
      token: { grants: { zone: 'read', dns: 'edit', zoneSettings: 'edit' } },
    });

    const status = await service.saveToken({ token: TOKEN });

    const missing = (status.accounts[0]?.report?.permissions ?? [])
      .filter((check) => check.state === 'missing')
      .map((check) => check.id);
    expect(status.configured).toBe(true);
    expect(missingPermissionLabels(missing)).toEqual([
      'Zone > Zone WAF > Edit',
      'Zone > Firewall Services > Edit',
    ]);
  });

  it('refuses text that cannot be a token without asking Cloudflare', async () => {
    const { service, fake } = makeService();
    await expect(
      service.saveToken({ token: '0123456789abcdef0123456789abcdef01234' }),
    ).rejects.toThrow(/Global API Key/);
    expect(fake.requests).toEqual([]);
  });

  it('keeps nothing when Cloudflare does not accept the token, and never repeats it', async () => {
    const { service, port } = makeService({ tokens: {} });

    const error = await rejection(service.saveToken({ token: TOKEN }));

    expect(error.message).toMatch(/Cloudflare did not accept this token/);
    expect(error.message).not.toContain(TOKEN);
    expect(port.value).toBeNull();
  });

  it('refuses a token Cloudflare reports as disabled or expired', async () => {
    const { service } = makeService({ token: { grants: ALL_GRANTS, status: 'expired' } });
    await expect(service.saveToken({ token: TOKEN })).rejects.toThrow(/expired/);
    expect((await service.status()).configured).toBe(false);
  });

  it('says to unlock the Servers passkey when the token cannot be sealed', async () => {
    const { service, seal } = makeService();
    seal.mockRejectedValueOnce(
      new Error('The vault is locked. Unlock it with your passkey first.'),
    );

    const error = await rejection(service.saveToken({ token: TOKEN }));

    expect(cloudflareErrorCode(error)).toBe('locked');
    expect((await service.status()).configured).toBe(false);
  });

  it('checks the saved token again, for after its permissions were edited on Cloudflare', async () => {
    const token: FakeToken = { grants: { zone: 'read' } };
    const { service } = await connectedService({ token });
    expect(stateOf(await service.status(), 'dns')).toBe('missing');

    // Cloudflare keeps the token's value when its permissions change.
    token.grants = ALL_GRANTS;
    const status = await service.checkToken(ACCOUNT);

    expect(stateOf(status, 'dns')).toBe('granted');
  });

  it('asks for a token before anything else', async () => {
    const { service } = makeService();
    const error = await rejection(service.listZones(ACCOUNT));
    expect(cloudflareErrorCode(error)).toBe('no-token');
    await expect(service.checkToken(ACCOUNT)).rejects.toThrow(/Connect Cloudflare/);
  });

  it('says when the saved token is locked behind the Servers passkey', async () => {
    const { service, lock } = await connectedService();
    lock.value = true;

    expect((await service.status()).locked).toBe(true);
    expect(cloudflareErrorCode(await rejection(service.listZones(ACCOUNT)))).toBe('locked');
  });

  it('forgets the token on request', async () => {
    const { service } = await connectedService();
    await service.removeToken(ACCOUNT);
    expect(await service.status()).toEqual({ configured: false, locked: false, accounts: [] });
  });

  it('passes on that Cloudflare no longer accepts the saved token', async () => {
    const { service, fake } = await connectedService();
    fake.failNext(/^\/zones$/, 401, {
      success: false,
      errors: [{ code: 1000, message: 'Invalid API Token' }],
    });

    const error = await rejection(service.listZones(ACCOUNT));

    expect(cloudflareErrorCode(error)).toBe('token-rejected');
  });
});

describe('zones and DNS records (T2)', () => {
  it('lists the zones the token can see', async () => {
    const { service } = await connectedService({
      zones: [
        { id: ZONE_ID, name: 'example.com' },
        { id: OTHER_ZONE_ID, name: 'example.org' },
      ],
    });

    expect(await service.listZones(ACCOUNT)).toEqual([
      {
        id: ZONE_ID,
        accountId: ACCOUNT,
        name: 'example.com',
        status: 'active',
        paused: false,
        plan: 'Free Website',
        nameServers: ['bob.ns.cloudflare.com', 'lola.ns.cloudflare.com'],
      },
      expect.objectContaining({ id: OTHER_ZONE_ID, name: 'example.org' }),
    ]);
  });

  it('lists every record, reading MX, CAA and SRV details, and marks types it does not edit', async () => {
    const { service } = await connectedService({
      zones: [
        {
          id: ZONE_ID,
          name: 'example.com',
          records: [
            dnsRecord,
            {
              ...dnsRecord,
              id: 'b'.repeat(32),
              type: 'MX',
              content: 'mail.example.com',
              priority: 10,
              proxied: false,
              proxiable: false,
            },
            {
              ...dnsRecord,
              id: 'c'.repeat(32),
              type: 'CAA',
              content: '0 issue "letsencrypt.org"',
              data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' },
              proxied: false,
              proxiable: false,
              comment: null,
            },
            {
              ...dnsRecord,
              id: 'd'.repeat(32),
              type: 'SRV',
              name: '_sip._tcp.example.com',
              content: '5 5060 sip.example.com',
              data: { priority: 10, weight: 5, port: 5060, target: 'sip.example.com' },
              proxied: false,
              proxiable: false,
            },
            {
              ...dnsRecord,
              id: 'e'.repeat(32),
              type: 'NS',
              content: 'ns1.example.net',
              proxied: false,
            },
          ],
        },
      ],
    });

    const records = await service.listRecords(ZONE_ID);

    expect(records[0]).toEqual({
      id: RECORD_ID,
      type: 'A',
      name: 'example.com',
      content: '198.51.100.4',
      ttl: 1,
      proxied: true,
      proxiable: true,
      comment: 'Domain verification record',
      editable: true,
    });
    expect(records[1]).toMatchObject({ type: 'MX', priority: 10, editable: true });
    expect(records[2]).toMatchObject({
      type: 'CAA',
      caa: { flags: 0, tag: 'issue', value: 'letsencrypt.org' },
    });
    expect(records[2].comment).toBeUndefined();
    expect(records[3]).toMatchObject({
      type: 'SRV',
      srv: { priority: 10, weight: 5, port: 5060, target: 'sip.example.com' },
    });
    expect(records[4]).toMatchObject({ type: 'NS', editable: false });
  });

  it('creates a proxied record with an automatic TTL', async () => {
    const { service, fake } = await connectedService();

    const created = await service.createRecord(ZONE_ID, {
      type: 'A',
      name: 'app.example.com',
      content: '203.0.113.10',
      ttl: 300,
      proxied: true,
    });

    expect(created).toMatchObject({
      name: 'app.example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: true,
    });
    expect(fake.writes()[0]).toMatchObject({
      method: 'POST',
      path: `/zones/${ZONE_ID}/dns_records`,
      body: { type: 'A', name: 'app.example.com', content: '203.0.113.10', ttl: 1, proxied: true },
    });
  });

  it('sends CAA and SRV records as their structured data', async () => {
    const { service, fake } = await connectedService();

    await service.createRecord(ZONE_ID, {
      type: 'CAA',
      name: 'example.com',
      caa: { flags: 0, tag: 'issue', value: 'letsencrypt.org' },
      ttl: 1,
    });
    await service.createRecord(ZONE_ID, {
      type: 'SRV',
      name: '_sip._tcp.example.com',
      srv: { priority: 10, weight: 5, port: 5060, target: 'sip.example.com' },
      ttl: 3600,
      comment: 'Phones',
    });
    await service.createRecord(ZONE_ID, {
      type: 'MX',
      name: 'example.com',
      content: 'mail.example.com',
      priority: 10,
      ttl: 1,
    });
    await service.createRecord(ZONE_ID, {
      type: 'TXT',
      name: 'example.com',
      content: 'v=spf1 -all',
      ttl: 1,
    });

    expect(fake.writes().map((request) => request.body)).toEqual([
      {
        type: 'CAA',
        name: 'example.com',
        ttl: 1,
        data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' },
      },
      {
        type: 'SRV',
        name: '_sip._tcp.example.com',
        ttl: 3600,
        comment: 'Phones',
        data: { priority: 10, weight: 5, port: 5060, target: 'sip.example.com' },
      },
      { type: 'MX', name: 'example.com', ttl: 1, content: 'mail.example.com', priority: 10 },
      { type: 'TXT', name: 'example.com', ttl: 1, content: 'v=spf1 -all' },
    ]);
  });

  it('changes a record with a PATCH, so a comment set on the dashboard stays', async () => {
    const { service, fake } = await connectedService({
      zones: [{ id: ZONE_ID, name: 'example.com', records: [dnsRecord] }],
    });

    const updated = await service.updateRecord(ZONE_ID, RECORD_ID, {
      type: 'A',
      name: 'example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: false,
    });

    expect(fake.writes()[0]).toMatchObject({
      method: 'PATCH',
      path: `/zones/${ZONE_ID}/dns_records/${RECORD_ID}`,
    });
    expect(updated).toMatchObject({
      content: '203.0.113.10',
      proxied: false,
      comment: 'Domain verification record',
    });
  });

  it('deletes a record', async () => {
    const { service, fake } = await connectedService({
      zones: [{ id: ZONE_ID, name: 'example.com', records: [dnsRecord] }],
    });
    await service.deleteRecord(ZONE_ID, RECORD_ID);
    expect(fake.zones.get(ZONE_ID)?.records).toEqual([]);
  });

  it('passes on what Cloudflare said when it refuses a record', async () => {
    const { service } = await connectedService({
      zones: [
        {
          id: ZONE_ID,
          name: 'example.com',
          records: [{ ...dnsRecord, type: 'CNAME', content: 'example.net' }],
        },
      ],
    });

    await expect(
      service.createRecord(ZONE_ID, {
        type: 'A',
        name: 'example.com',
        content: '203.0.113.10',
        ttl: 1,
        proxied: false,
      }),
    ).rejects.toThrow(
      'Cloudflare said: An A, AAAA, or CNAME record with that host already exists. (code 81053)',
    );
  });

  it('names the missing permission when Cloudflare refuses a change, and remembers it', async () => {
    const { service } = await connectedService({
      token: { grants: { ...ALL_GRANTS, dns: 'read' } },
    });

    const error = await rejection(
      service.createRecord(ZONE_ID, { type: 'TXT', name: 'example.com', content: 'x', ttl: 1 }),
    );

    expect(cloudflareErrorCode(error)).toBe('missing-permission');
    expect(cloudflareErrorPermission(error)).toBe('dns');
    expect(cloudflareErrorMessage(error)).toMatch(/add Zone > DNS > Edit/);
    const report = (await service.status()).accounts[0]?.report;
    expect(report?.permissions.find((check) => check.id === 'dns')?.state).toBe('missing');
  });
});

describe('zone settings and the cache (T3)', () => {
  it('reads the settings the page manages', async () => {
    const { service } = await connectedService();
    expect(await service.zoneSettings(ZONE_ID)).toEqual({
      developmentMode: { value: 'off', secondsRemaining: 0, editable: true },
      securityLevel: { value: 'medium', editable: true },
      ssl: { value: 'full', editable: true },
      alwaysUseHttps: { value: 'off', editable: true },
      automaticHttpsRewrites: { value: 'off', editable: true },
      minTlsVersion: { value: '1.0', editable: true },
      tls13: { value: 'on', editable: true },
      cacheLevel: { value: 'aggressive', editable: true },
      browserCacheTtl: { value: 14400, editable: true },
    });
  });

  it('changes the SSL/TLS and caching settings, keeping the TTL a number', async () => {
    const { service, fake } = await connectedService();

    await service.changeSetting(ZONE_ID, { setting: 'automaticHttpsRewrites', value: 'on' });
    await service.changeSetting(ZONE_ID, { setting: 'minTlsVersion', value: '1.2' });
    await service.changeSetting(ZONE_ID, { setting: 'tls13', value: 'off' });
    await service.changeSetting(ZONE_ID, { setting: 'cacheLevel', value: 'basic' });
    const settings = await service.changeSetting(ZONE_ID, {
      setting: 'browserCacheTtl',
      value: 7200,
    });

    expect(fake.writes().map((request) => [request.method, request.path, request.body])).toEqual([
      ['PATCH', `/zones/${ZONE_ID}/settings/automatic_https_rewrites`, { value: 'on' }],
      ['PATCH', `/zones/${ZONE_ID}/settings/min_tls_version`, { value: '1.2' }],
      ['PATCH', `/zones/${ZONE_ID}/settings/tls_1_3`, { value: 'off' }],
      ['PATCH', `/zones/${ZONE_ID}/settings/cache_level`, { value: 'basic' }],
      ['PATCH', `/zones/${ZONE_ID}/settings/browser_cache_ttl`, { value: 7200 }],
    ]);
    expect(settings).toMatchObject({
      automaticHttpsRewrites: { value: 'on' },
      minTlsVersion: { value: '1.2' },
      tls13: { value: 'off' },
      cacheLevel: { value: 'basic' },
      browserCacheTtl: { value: 7200 },
    });
  });

  it('names Zone Settings when the token cannot change them', async () => {
    const { service } = await connectedService({
      token: { grants: { ...ALL_GRANTS, zoneSettings: 'read' } },
    });
    const error = await rejection(
      service.changeSetting(ZONE_ID, { setting: 'cacheLevel', value: 'basic' }),
    );
    expect(cloudflareErrorPermission(error)).toBe('zoneSettings');
  });

  it("turns on I'm Under Attack and development mode, and changes the SSL mode", async () => {
    const { service, fake } = await connectedService();

    await service.changeSetting(ZONE_ID, { setting: 'securityLevel', value: 'under_attack' });
    await service.changeSetting(ZONE_ID, { setting: 'ssl', value: 'strict' });
    await service.changeSetting(ZONE_ID, { setting: 'alwaysUseHttps', value: 'on' });
    const settings = await service.changeSetting(ZONE_ID, {
      setting: 'developmentMode',
      value: 'on',
    });

    expect(fake.writes().map((request) => [request.method, request.path, request.body])).toEqual([
      ['PATCH', `/zones/${ZONE_ID}/settings/security_level`, { value: 'under_attack' }],
      ['PATCH', `/zones/${ZONE_ID}/settings/ssl`, { value: 'strict' }],
      ['PATCH', `/zones/${ZONE_ID}/settings/always_use_https`, { value: 'on' }],
      ['PATCH', `/zones/${ZONE_ID}/settings/development_mode`, { value: 'on' }],
    ]);
    expect(settings).toMatchObject({
      developmentMode: { value: 'on', secondsRemaining: 10800 },
      securityLevel: { value: 'under_attack' },
      ssl: { value: 'strict' },
      alwaysUseHttps: { value: 'on' },
    });
  });

  it('purges everything, or just the listed URLs', async () => {
    const { service, fake } = await connectedService();

    await service.purgeCache(ZONE_ID, { everything: true });
    await service.purgeCache(ZONE_ID, { urls: ['https://example.com/app.css'] });

    expect(fake.zones.get(ZONE_ID)?.purges).toEqual([
      { purge_everything: true },
      { files: ['https://example.com/app.css'] },
    ]);
  });

  it('names Cache Purge when the token cannot purge', async () => {
    const { service } = await connectedService({
      token: { grants: { ...ALL_GRANTS, cachePurge: undefined } },
    });
    const error = await rejection(service.purgeCache(ZONE_ID, { everything: true }));
    expect(cloudflareErrorPermission(error)).toBe('cachePurge');
  });
});
