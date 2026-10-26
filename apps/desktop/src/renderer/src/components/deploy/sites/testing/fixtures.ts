import type {
  CertificateInfo,
  NginxStatus,
  SiteInfo,
  SiteSettings,
  StreamProxyInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { NOW, SERVER, signedIn } from '../../security/testing/fixtures';

/** A signed-in user on a server whose nginx runs two sites, for the Websites section's tests. */

export { NOW, SERVER, signedIn };

export const DAY = 24 * 60 * 60_000;

export function nginxStatus(overrides: Partial<NginxStatus> = {}): NginxStatus {
  return {
    installed: true,
    running: true,
    managed: true,
    fromNginxOrg: true,
    streamSupported: true,
    pendingChanges: false,
    seLinuxEnabled: false,
    version: '1.30.0',
    currentRelease: 3,
    lastAppliedAtUnixMs: NOW - 3_600_000,
    lastAppliedBy: 'maria',
    ...overrides,
  };
}

export function certificate(overrides: Partial<CertificateInfo> = {}): CertificateInfo {
  return {
    siteId: 'blog',
    source: 'acme',
    state: 'valid',
    domains: ['blog.example.com'],
    issuer: 'R11',
    notBeforeUnixMs: NOW - 30 * DAY,
    notAfterUnixMs: NOW + 60 * DAY + 60_000,
    autoRenew: true,
    staging: false,
    renewAtUnixMs: NOW + 30 * DAY,
    lastAttemptAtUnixMs: NOW - 30 * DAY,
    lastJobId: '00000000-0000-4000-8000-000000000009',
    failedAttempts: 0,
    ...overrides,
  };
}

export function settings(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
    id: 'blog',
    domains: ['blog.example.com', 'www.blog.example.com'],
    upstream: {
      kind: 'servicePort',
      service: 'web',
      port: 3000,
      verifyCertificate: true,
      sendUpstreamHost: false,
    },
    websocket: true,
    gzip: true,
    http2: true,
    redirectToHttps: true,
    proxyCache: { ttlSeconds: 600, maxSizeMegabytes: 256 },
    ...overrides,
  };
}

export function site(
  overrides: Partial<SiteInfo> = {},
  settingsOverrides: Partial<SiteSettings> = {},
): SiteInfo {
  return {
    settings: settings(settingsOverrides),
    applied: true,
    createdAtUnixMs: NOW - 40 * DAY,
    updatedAtUnixMs: NOW - DAY,
    certificate: certificate(),
    ...overrides,
  };
}

export const SHOP: SiteInfo = {
  settings: {
    id: 'shop',
    domains: ['shop.example.com'],
    upstream: {
      kind: 'url',
      address: 'http://10.0.0.5:8080',
      verifyCertificate: true,
      sendUpstreamHost: false,
    },
    websocket: false,
    gzip: false,
    http2: true,
    redirectToHttps: false,
  },
  applied: false,
  createdAtUnixMs: NOW - DAY,
  updatedAtUnixMs: NOW - 60_000,
};

export const POSTGRES: StreamProxyInfo = {
  settings: {
    id: 'postgres',
    protocol: 'tcp',
    listenPort: 5432,
    upstream: {
      kind: 'endpoint',
      address: '127.0.0.1:5433',
      verifyCertificate: false,
      sendUpstreamHost: false,
    },
    allowFrom: ['203.0.113.4'],
  },
  applied: true,
  updatedAtUnixMs: NOW - DAY,
};

export function sitesBridge(roles: string[] = ['owner']): Record<string, unknown> {
  return {
    'deploy.access': signedIn(roles),
    'deploySites.status': nginxStatus(),
    'deploySites.list': [site(), SHOP],
    'deploySites.listStreams': [POSTGRES],
    'deploySites.watchLog': async () => 'log-1',
    'deploySites.unwatchLog': async () => true,
    'deployJobs.watch': async () => 'job-log-1',
    'deployJobs.unwatch': async () => true,
  };
}

export function job(kind: 'nginxInstall' | 'certificateIssue' | 'certificateRenew', title: string) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind,
    title,
    state: 'running' as const,
    createdAtUnixMs: NOW,
    logLines: 0,
    cancellable: true,
  };
}
