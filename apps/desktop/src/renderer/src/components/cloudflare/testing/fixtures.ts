import type {
  CloudflareAccountStatus,
  CloudflareDnsRecord,
  CloudflareStatus,
  CloudflareZone,
  CloudflareZoneSettings,
} from '@shared/cloudflareTypes';

/** Sample data for the Cloudflare page's component tests. */

export const ZONE: CloudflareZone = {
  id: '023e105f4ecef8ad9ca31a8372d0c353',
  accountId: 'acct-1',
  name: 'example.com',
  status: 'active',
  paused: false,
  plan: 'Free Website',
  nameServers: ['bob.ns.cloudflare.com', 'lola.ns.cloudflare.com'],
};

export const OTHER_ZONE: CloudflareZone = {
  ...ZONE,
  id: '9a7806061c88ada191ed06f989cc3dac',
  name: 'example.org',
  status: 'pending',
};

export const A_RECORD: CloudflareDnsRecord = {
  id: '372e67954025e0ba6aaa6d586b9e0b59',
  type: 'A',
  name: 'example.com',
  content: '203.0.113.10',
  ttl: 1,
  proxied: true,
  proxiable: true,
  editable: true,
};

export const SETTINGS: CloudflareZoneSettings = {
  developmentMode: { value: 'off', secondsRemaining: 0, editable: true },
  securityLevel: { value: 'medium', editable: true },
  ssl: { value: 'full', editable: true },
  alwaysUseHttps: { value: 'off', editable: true },
  automaticHttpsRewrites: { value: 'off', editable: true },
  minTlsVersion: { value: '1.0', editable: true },
  tls13: { value: 'on', editable: true },
  cacheLevel: { value: 'aggressive', editable: true },
  browserCacheTtl: { value: 14400, editable: true },
};

export const ACCOUNT: CloudflareAccountStatus = {
  id: 'acct-1',
  label: 'Cloudflare',
  locked: false,
  report: {
    tokenId: 'ed17574386854bf78a67040be0a770b0',
    status: 'active',
    expiresOn: null,
    source: 'probes',
    permissions: [
      { id: 'zone', state: 'granted' },
      { id: 'dns', state: 'granted' },
      { id: 'zoneSettings', state: 'granted' },
      { id: 'cachePurge', state: 'unverified' },
      { id: 'waf', state: 'granted' },
      { id: 'accessRules', state: 'granted' },
    ],
    zoneCount: 2,
    checkedAt: Date.now(),
  },
};

export const CONNECTED: CloudflareStatus = {
  configured: true,
  locked: false,
  accounts: [ACCOUNT],
};

/** What a failed IPC call looks like in the renderer. */
export function ipcError(channel: string, message: string): Error {
  return new Error(`Error invoking remote method 'cloudflare:${channel}': Error: ${message}`);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
