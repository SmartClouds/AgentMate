import { describe, expect, it } from 'vitest';
import { cloudflareErrorCode } from '../../../shared/cloudflareErrors';
import { createCloudflareApi } from './client';
import { ALL_GRANTS, createFakeCloudflare } from './testing/fakeCloudflare';
import { ACCOUNT, connectedService, makeService, NOW, TOKEN } from './testing/harness';
import { customRuleset, permissionDenied, RULE_ID, ZONE_ID } from './testing/recorded';
import { checkToken } from './tokenCheck';

/**
 * The less travelled paths: answers with fields left out, a vault that will not open, and
 * Cloudflare failing in the middle of a check. None of them may turn into a crash or a guess.
 */

const BARE_ID = (digit: string) => digit.repeat(32);

describe('sparse answers', () => {
  it('reads records, rules and access rules that leave optional fields out', async () => {
    const { service } = await connectedService({
      zones: [
        {
          id: ZONE_ID,
          name: 'example.com',
          records: [
            { id: BARE_ID('1'), type: 'MX', name: 'example.com', ttl: 1 },
            { id: BARE_ID('2'), type: 'CAA', name: 'example.com', ttl: 1 },
            { id: BARE_ID('3'), type: 'SRV', name: '_sip._tcp.example.com', ttl: 1, priority: 3 },
          ],
          ruleset: { ...customRuleset, rules: [{ id: RULE_ID }] },
          accessRules: [{ id: BARE_ID('4'), mode: 'block' }],
        },
      ],
    });

    expect(await service.listRecords(ZONE_ID)).toEqual([
      {
        id: BARE_ID('1'),
        type: 'MX',
        name: 'example.com',
        content: '',
        ttl: 1,
        proxied: false,
        proxiable: false,
        priority: 0,
        editable: true,
      },
      expect.objectContaining({ caa: { flags: 0, tag: 'issue', value: '' } }),
      expect.objectContaining({ srv: { priority: 3, weight: 0, port: 0, target: '' } }),
    ]);
    expect(await service.listCustomRules(ZONE_ID)).toEqual([
      {
        id: RULE_ID,
        description: '',
        expression: '',
        action: '',
        enabled: true,
        lastUpdated: null,
      },
    ]);
    expect(await service.listAccessRules(ZONE_ID)).toEqual([
      { id: BARE_ID('4'), mode: 'block', target: 'ip', value: '', notes: '', createdOn: null },
    ]);
  });

  it('falls back to safe values for settings and zones it cannot read in full', async () => {
    const { service, fake } = await connectedService();
    const state = fake.zones.get(ZONE_ID);
    if (!state) throw new Error('no zone');
    state.settings = {
      development_mode: { id: 'development_mode' },
      security_level: { id: 'security_level', value: 7 },
      ssl: { id: 'ssl' },
      always_use_https: { id: 'always_use_https', value: 'on', editable: false },
      automatic_https_rewrites: { id: 'automatic_https_rewrites' },
      min_tls_version: { id: 'min_tls_version', value: 12 },
      tls_1_3: { id: 'tls_1_3' },
      cache_level: { id: 'cache_level' },
      browser_cache_ttl: { id: 'browser_cache_ttl', value: '14400' },
    };
    for (const key of ['status', 'paused', 'plan', 'name_servers']) delete state.zone[key];

    expect(await service.zoneSettings(ZONE_ID)).toEqual({
      developmentMode: { value: 'off', secondsRemaining: 0, editable: true },
      securityLevel: { value: 'medium', editable: true },
      ssl: { value: 'off', editable: true },
      alwaysUseHttps: { value: 'on', editable: false },
      automaticHttpsRewrites: { value: 'off', editable: true },
      minTlsVersion: { value: '1.0', editable: true },
      tls13: { value: 'off', editable: true },
      cacheLevel: { value: 'aggressive', editable: true },
      browserCacheTtl: { value: 0, editable: true },
    });
    expect(await service.listZones(ACCOUNT)).toEqual([
      {
        id: ZONE_ID,
        accountId: ACCOUNT,
        name: 'example.com',
        status: 'active',
        paused: false,
        plan: '',
        nameServers: [],
      },
    ]);
  });

  it("keeps a record's own TTL when it repoints one that is not proxied", async () => {
    const { service, fake } = await connectedService({
      zones: [
        {
          id: ZONE_ID,
          name: 'example.com',
          records: [
            {
              id: BARE_ID('5'),
              type: 'A',
              name: 'example.com',
              content: '198.51.100.4',
              ttl: 600,
              proxied: false,
              proxiable: true,
            },
          ],
        },
      ],
    });

    await service.pointDomain({
      zoneId: ZONE_ID,
      name: '@',
      serverId: 'srv-1',
      includeWww: false,
      proxied: false,
    });

    expect(fake.writes()[0].body).toMatchObject({ patches: [{ id: BARE_ID('5'), ttl: 600 }] });
  });
});

describe('failures along the way', () => {
  it('says the vault is locked when the sealed token will not open', async () => {
    const { service, state } = makeService({
      unseal: async () => {
        throw new Error('The vault is locked.');
      },
    });
    await state.save({
      id: ACCOUNT,
      label: 'Cloudflare',
      token: { envelope: { mode: 'safeStorage', ciphertext: 'eA==' }, tokenId: 'x', savedAt: 1 },
      report: {
        tokenId: 'x',
        status: 'active',
        expiresOn: null,
        source: 'probes',
        permissions: [],
        zoneCount: 0,
        checkedAt: 1,
      },
    });

    await expect(service.listZones(ACCOUNT)).rejects.toSatisfy(
      (error: Error) => cloudflareErrorCode(error) === 'locked',
    );
  });

  it('saves nothing when Cloudflare fails while the token is being checked', async () => {
    const { service, fake, port } = makeService();
    fake.failNext(/^\/zones$/, 500);

    await expect(service.saveToken({ token: TOKEN })).rejects.toThrow(
      'Cloudflare said: Failed (code 0)',
    );
    expect(port.value).toBeNull();
  });

  it('counts no zones when Cloudflare refuses to list them', async () => {
    const fake = createFakeCloudflare({ tokens: { [TOKEN]: { grants: ALL_GRANTS } } });
    fake.failNext(/^\/zones$/, 403, permissionDenied);
    const report = await checkToken(
      createCloudflareApi(TOKEN, { fetch: fake.fetch, maxRetries: 0 }),
      NOW,
    );

    expect(report.zoneCount).toBe(0);
    expect(report.permissions.find((check) => check.id === 'zone')?.state).toBe('missing');
  });

  it('fails the check when reading the token itself fails for another reason', async () => {
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { grants: ALL_GRANTS, canReadSelf: true } },
    });
    fake.failNext(/^\/user\/tokens\/[0-9a-f]{32}$/, 500);

    await expect(
      checkToken(createCloudflareApi(TOKEN, { fetch: fake.fetch, maxRetries: 0 }), NOW),
    ).rejects.toThrow();
  });
});
