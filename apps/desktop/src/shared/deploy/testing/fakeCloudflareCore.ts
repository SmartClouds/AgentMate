import type {
  CertificateUploadResult,
  CloudflareRanges,
  DnsCredentialInfo,
  DnsCredentialRequest,
  DnsCredentialSaveResult,
  FirewallChange,
  OriginCertificateInstall,
  OriginCertificateRequestInfo,
  OriginLockPreview,
  OriginLockRequest,
  OriginLockResult,
  OriginLockStatus,
} from '../protocol/generated/Runova.ServerCore.Contracts';
import type { FakeFirewall, FakeFirewallCaller } from './fakeFirewall';
import type { FakeNginx } from './fakeNginx';

/**
 * The server core's Cloudflare side (E14) in memory: the origin lock as a change set on the fake
 * firewall (so its confirm and rollback are the firewall's own), Origin CA requests and installs
 * through the fake nginx, and DNS tokens that are kept but never handed back. Tokens starting
 * "denied" are refused, as the core refuses one Cloudflare says cannot read the zone's DNS.
 */

export const FAKE_CLOUDFLARE_RANGES: CloudflareRanges = {
  ipv4: ['103.21.244.0/22', '173.245.48.0/20'],
  ipv6: ['2400:cb00::/32'],
  fetchedAtUnixMs: 0,
};

const LOCK_COMMENT = 'cloudflare origin lock';
const PORTS = [80, 443];
const HOUR = 3_600_000;

interface Host {
  now: () => number;
  firewall: FakeFirewall;
  nginx: FakeNginx;
}

export class FakeCloudflareCore {
  enabled = false;
  authenticatedOriginPulls = false;
  ranges: CloudflareRanges;
  changeSetId: string | undefined;
  lastRefreshError: string | undefined;
  readonly credentials = new Map<string, DnsCredentialInfo & { token: string }>();
  readonly requests = new Map<string, OriginCertificateRequestInfo>();

  constructor(private readonly host: Host) {
    this.ranges = { ...FAKE_CLOUDFLARE_RANGES, fetchedAtUnixMs: host.now() };
  }

  status(): OriginLockStatus {
    const rules = this.host.firewall.rules;
    const all = [...this.ranges.ipv4, ...this.ranges.ipv6];
    const missing = all.flatMap((range) =>
      PORTS.filter(
        (port) =>
          !rules.some(
            (rule) => rule.action === 'allow' && rule.port === port && rule.source === range,
          ),
      ).map((port) => `Allow ${port}/tcp from ${range}`),
    );
    const open = rules
      .filter(
        (rule) => rule.action === 'allow' && !rule.source && rule.port && PORTS.includes(rule.port),
      )
      .map((rule) => rule.description);
    const change = this.host.firewall.changeSets.find(
      (candidate) => candidate.id === this.changeSetId,
    );
    const matches = missing.length === 0 && open.length === 0;
    const state = !this.enabled
      ? 'off'
      : change?.state === 'awaitingConfirmation'
        ? 'pending'
        : matches
          ? 'on'
          : 'drifted';
    return {
      enabled: this.enabled,
      authenticatedOriginPulls: this.enabled && this.authenticatedOriginPulls,
      state,
      ports: [...PORTS],
      missingRules: missing,
      openRules: open,
      staleRules: [],
      warnings: [],
      ranges: { ...this.ranges },
      lastRefreshAtUnixMs: this.ranges.fetchedAtUnixMs,
      ...(this.lastRefreshError ? { lastRefreshError: this.lastRefreshError } : {}),
      ...(this.changeSetId ? { changeSetId: this.changeSetId } : {}),
      ...(change ? { changeState: change.state } : {}),
    };
  }

  preview(request: OriginLockRequest): OriginLockPreview {
    const changes = this.plan(request.enabled);
    return {
      changes,
      notes: changes.length === 0 ? ['The firewall already matches; only nginx changes.'] : [],
      ranges: { ...this.ranges },
      ...(changes.length > 0 ? { firewall: this.host.firewall.preview({ changes }) } : {}),
    };
  }

  apply(request: OriginLockRequest, caller: FakeFirewallCaller): OriginLockResult {
    const changes = this.plan(request.enabled);
    const changeSet =
      changes.length > 0
        ? this.host.firewall.apply(
            { changes, ...(request.sshConnection ? { sshConnection: request.sshConnection } : {}) },
            caller,
          )
        : undefined;
    this.enabled = request.enabled;
    this.authenticatedOriginPulls = request.enabled && request.authenticatedOriginPulls === true;
    if (changeSet) this.changeSetId = changeSet.id;
    return {
      status: this.status(),
      nginx: this.host.nginx.apply(),
      ...(changeSet ? { changeSet } : {}),
    };
  }

  createRequest(siteId: string): OriginCertificateRequestInfo {
    const site = this.host.nginx.sites.get(siteId);
    if (!site) throw new Error('There is no such site.');
    const request: OriginCertificateRequestInfo = {
      siteId,
      csrPem: `-----BEGIN CERTIFICATE REQUEST-----\nZmFrZSBjc3IgZm9yICR7c2l0ZUlkfQ==\n-----END CERTIFICATE REQUEST-----\n`,
      hostnames: [...site.settings.domains],
      requestType: 'origin-ecc',
      createdAtUnixMs: this.host.now(),
    };
    this.requests.set(siteId, request);
    return { ...request };
  }

  install(request: OriginCertificateInstall): CertificateUploadResult {
    const pending = this.requests.get(request.siteId);
    if (!pending) {
      return {
        problems: [
          'This server has no key waiting for an Origin CA certificate for this site. Start again from the SSL tab.',
        ],
      };
    }
    if (this.host.now() - pending.createdAtUnixMs > HOUR) {
      return {
        problems: ['The signing request is more than an hour old. Start again from the SSL tab.'],
      };
    }
    if (!request.certificatePem.includes('BEGIN CERTIFICATE')) {
      return { problems: ['The certificate is not PEM text.'] };
    }
    this.requests.delete(request.siteId);
    return this.host.nginx.installOrigin(request.siteId);
  }

  listCredentials(): DnsCredentialInfo[] {
    return [...this.credentials.values()].map(({ token: _secret, ...info }) => ({ ...info }));
  }

  saveCredential(request: DnsCredentialRequest, userName: string): DnsCredentialSaveResult {
    const zone = request.zone.trim().toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(zone)) {
      return { problems: ['The zone is not a domain name like example.com.'] };
    }
    if (request.token.startsWith('denied')) {
      return {
        problems: [
          "This token cannot read the zone's DNS records (Authentication error (code 10000)). It needs Zone > DNS > Edit on this zone.",
        ],
      };
    }
    const now = this.host.now();
    const credential = {
      zone,
      zoneId: request.zoneId,
      provider: 'cloudflare',
      createdAtUnixMs: this.credentials.get(zone)?.createdAtUnixMs ?? now,
      updatedAtUnixMs: now,
      createdBy: userName,
      token: request.token,
      ...(request.tokenId ? { tokenId: request.tokenId } : {}),
    };
    this.credentials.set(zone, credential);
    const { token: _secret, ...info } = credential;
    return { problems: [], credential: info };
  }

  removeCredential(zone: string): void {
    if (!this.credentials.delete(zone.trim().toLowerCase())) {
      throw new Error('This server has no DNS token for that zone.');
    }
  }

  private plan(enable: boolean): FirewallChange[] {
    const rules = this.host.firewall.rules;
    const all = [...this.ranges.ipv4, ...this.ranges.ipv6];
    const changes: FirewallChange[] = [];
    if (enable) {
      if (!this.host.firewall.active) {
        throw new Error(
          'The firewall is off, so it cannot keep anyone out. Turn it on in the Firewall section first, then lock the origin.',
        );
      }
      for (const range of all) {
        for (const port of PORTS) {
          if (
            !rules.some(
              (rule) => rule.action === 'allow' && rule.port === port && rule.source === range,
            )
          ) {
            changes.push({
              kind: 'addRule',
              rule: {
                action: 'allow',
                protocol: 'tcp',
                port,
                source: range,
                comment: LOCK_COMMENT,
              },
            });
          }
        }
      }
      for (const rule of rules) {
        if (rule.action === 'allow' && !rule.source && rule.port && PORTS.includes(rule.port)) {
          changes.push({ kind: 'removeRule', ruleId: rule.id });
        }
      }
    } else {
      for (const rule of rules) {
        if (rule.comment === LOCK_COMMENT) changes.push({ kind: 'removeRule', ruleId: rule.id });
      }
      for (const port of PORTS) {
        if (!rules.some((rule) => rule.action === 'allow' && !rule.source && rule.port === port)) {
          changes.push({ kind: 'addRule', rule: { action: 'allow', protocol: 'tcp', port } });
        }
      }
    }
    return changes;
  }
}
