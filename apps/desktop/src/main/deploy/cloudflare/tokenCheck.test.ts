import { describe, expect, it } from 'vitest';
import { missingPermissionLabels } from '../../../shared/cloudflare/permissions';
import type { CloudflareTokenReport } from '../../../shared/cloudflareTypes';
import { createCloudflareApi } from './client';
import { ALL_GRANTS, createFakeCloudflare, type FakeToken } from './testing/fakeCloudflare';
import { TOKEN_ID } from './testing/recorded';
import { checkToken, permissionsFromPolicies } from './tokenCheck';

/**
 * T1 and AC1: a token is checked against the permissions Runova asks for without changing
 * anything on the account, and a missing permission comes back as exactly what to add.
 */

const TOKEN = 'Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M';
const NOW = 1_780_000_000_000;

function check(token: FakeToken, zones?: Parameters<typeof createFakeCloudflare>[0]['zones']) {
  const fake = createFakeCloudflare({ tokens: { [TOKEN]: token }, zones });
  const api = createCloudflareApi(TOKEN, { fetch: fake.fetch, maxRetries: 0 });
  return { fake, report: checkToken(api, NOW) };
}

function states(report: CloudflareTokenReport): Record<string, string> {
  return Object.fromEntries(report.permissions.map(({ id, state }) => [id, state]));
}

function missing(report: CloudflareTokenReport) {
  return report.permissions.filter(({ state }) => state === 'missing').map(({ id }) => id);
}

describe('checkToken by trying read-only calls', () => {
  it('finds every permission of a token made from the template', async () => {
    const { fake, report } = check({ grants: ALL_GRANTS });

    expect(await report).toEqual({
      tokenId: TOKEN_ID,
      status: 'active',
      expiresOn: '2030-01-01T00:00:00Z',
      source: 'probes',
      zoneCount: 1,
      checkedAt: NOW,
      permissions: [
        { id: 'zone', state: 'granted' },
        { id: 'dns', state: 'granted' },
        { id: 'zoneSettings', state: 'granted' },
        { id: 'cachePurge', state: 'unverified' },
        { id: 'waf', state: 'granted' },
        { id: 'accessRules', state: 'granted' },
      ],
    });
    expect(fake.writes()).toEqual([]);
  });

  it('lists exactly the permissions to add when some are missing (AC1)', async () => {
    const { fake, report } = check({
      grants: { zone: 'read', zoneSettings: 'edit', cachePurge: 'edit', accessRules: 'edit' },
    });

    const result = await report;
    expect(missing(result)).toEqual(['dns', 'waf']);
    expect(missingPermissionLabels(missing(result))).toEqual([
      'Zone > DNS > Edit',
      'Zone > Zone WAF > Edit',
    ]);
    expect(fake.writes()).toEqual([]);
  });

  it('counts a zone with no custom rules yet as readable', async () => {
    const { report } = check({ grants: ALL_GRANTS });
    expect(states(await report).waf).toBe('granted');
  });

  it('asks for Zone Read when the token sees no zones, and leaves the rest unverified', async () => {
    const { report } = check({ grants: { dns: 'edit', zoneSettings: 'edit' } });

    const result = await report;
    expect(result.zoneCount).toBe(0);
    expect(missing(result)).toEqual(['zone']);
    expect(states(result)).toMatchObject({ dns: 'unverified', waf: 'unverified' });
  });

  it('reports a disabled token as it is', async () => {
    const { report } = check({ grants: ALL_GRANTS, status: 'disabled' });
    expect((await report).status).toBe('disabled');
  });

  it('fails rather than guessing when Cloudflare itself has trouble', async () => {
    const fake = createFakeCloudflare({ tokens: { [TOKEN]: { grants: ALL_GRANTS } } });
    fake.failNext(/dns_records/, 500);
    const api = createCloudflareApi(TOKEN, { fetch: fake.fetch, maxRetries: 0 });

    await expect(checkToken(api, NOW)).rejects.toThrow();
  });
});

describe('checkToken from the token own policies', () => {
  it('reads the exact permissions when the token may read itself', async () => {
    const { fake, report } = check({
      canReadSelf: true,
      grants: { ...ALL_GRANTS, dns: 'read' },
    });

    const result = await report;
    expect(result.source).toBe('policies');
    expect(states(result)).toEqual({
      zone: 'granted',
      dns: 'missing',
      zoneSettings: 'granted',
      cachePurge: 'granted',
      waf: 'granted',
      accessRules: 'granted',
    });
    expect(missingPermissionLabels(missing(result))).toEqual(['Zone > DNS > Edit']);
    // The policies answered it, so nothing was tried against the zone.
    expect(fake.requests.some((request) => request.path.includes('dns_records'))).toBe(false);
  });
});

describe('permissionsFromPolicies', () => {
  it('lets a write permission stand for read, accepts Edit spellings, and honours deny', () => {
    const result = permissionsFromPolicies([
      {
        effect: 'allow',
        permission_groups: [
          { name: 'Zone Write' },
          { name: 'DNS Edit' },
          { name: 'Zone Settings Write' },
          { name: 'Zone WAF Write' },
        ],
      },
      { effect: 'deny', permission_groups: [{ name: 'Zone WAF Write' }] },
      { effect: 'allow', permission_groups: [{ id: 'no-name' }] },
    ]);

    expect(Object.fromEntries(result.map(({ id, state }) => [id, state]))).toEqual({
      zone: 'granted',
      dns: 'granted',
      zoneSettings: 'granted',
      cachePurge: 'missing',
      waf: 'missing',
      accessRules: 'missing',
    });
  });
});
