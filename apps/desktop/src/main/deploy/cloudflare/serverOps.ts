import { tokenProblem } from '../../../shared/cloudflare/permissions';
import { encodeCloudflareError } from '../../../shared/cloudflareErrors';
import type {
  CloudflareDnsTokenInput,
  CloudflareDomainCheck,
  CloudflareOriginCertificateInput,
  CloudflareOriginLockInput,
  CloudflareOriginLockPlan,
  CloudflareRemoveDnsTokenInput,
  CloudflareZone,
} from '../../../shared/cloudflareTypes';
import { encodeCoreError } from '../../../shared/coreErrors';
import type {
  CertificateUploadResult,
  DnsCredentialInfo,
  OriginLockResult,
  OriginLockStatus,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { ADMIN_ROLES, callCore } from '../coreCalls';
import type { CoreLinks } from '../live/coreLinks';
import type { CloudflareService } from './service';

/**
 * Cloudflare work that involves a server's core (E14 T5 to T7). The account token stays in this
 * process: Cloudflare is called from here, and the core only receives what it needs, a signed
 * Origin CA certificate (its key never left the server) or a separate DNS token scoped to one
 * zone. The origin lock's firewall change rides the lasting connection with `$SSH_CONNECTION`
 * read under it, like any firewall change, and is confirmed from the Firewall section.
 */

/** Origin CA certificates last up to 15 years; the longest Cloudflare offers. */
const ORIGIN_VALIDITY_DAYS = 5475;
const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME']);

export interface CloudflareServerOpsDeps {
  cloudflare: Pick<
    CloudflareService,
    'useApi' | 'withPastedToken' | 'isSavedToken' | 'allZones' | 'listRecords'
  >;
  links: Pick<CoreLinks, 'call'>;
  roles: (serverId: string) => string[] | null;
  onLinkConnection: <T>(
    serverId: string,
    work: (sshConnection: string | undefined) => Promise<T>,
  ) => Promise<T>;
  serverName: (serverId: string) => Promise<string>;
}

/** The zone of the account a name belongs to: the longest zone name it ends in. */
export function zoneOf(name: string, zones: CloudflareZone[]): CloudflareZone | null {
  const host = name.toLowerCase().replace(/^\*\./, '');
  return (
    zones
      .filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}

export class CloudflareServerOps {
  constructor(private readonly deps: CloudflareServerOpsDeps) {}

  originLock(serverId: string): Promise<OriginLockStatus> {
    return this.core(serverId, (hub) => hub.getOriginLock());
  }

  /** The core's plan, with what Cloudflare says about each site domain on the server. */
  async previewOriginLock(input: CloudflareOriginLockInput): Promise<CloudflareOriginLockPlan> {
    const preview = await this.deps.onLinkConnection(input.serverId, (sshConnection) =>
      this.core(input.serverId, (hub) =>
        hub.previewOriginLock({
          enabled: input.enabled,
          authenticatedOriginPulls: input.authenticatedOriginPulls,
          ...(sshConnection ? { sshConnection } : {}),
        }),
      ),
    );
    return { preview, domains: await this.domainChecks(input.serverId) };
  }

  /**
   * Turns the lock on or off. With Authenticated Origin Pulls, Cloudflare is told to present its
   * client certificate on every zone of the server's sites first; the core only then makes nginx
   * ask for it, so no site is cut off in between. A site whose zone is not in this account would
   * be, so that is refused with the names.
   */
  async applyOriginLock(input: CloudflareOriginLockInput): Promise<OriginLockResult> {
    if (input.enabled && input.authenticatedOriginPulls) {
      const { checks: domains, zones } = await this.domainChecksWithZones(input.serverId);
      const outside = domains.filter((domain) => domain.zoneId === null).map((d) => d.domain);
      if (outside.length > 0) {
        throw new Error(
          `Authenticated Origin Pulls would cut off ${outside.join(', ')}: no zone of a connected Cloudflare account holds ${outside.length === 1 ? 'it' : 'them'}. Leave the option off, or add the zone to one of your accounts first.`,
        );
      }
      const zoneIds = [...new Set(domains.map((domain) => domain.zoneId as string))];
      for (const zoneId of zoneIds) {
        const accountId = zones.find((zone) => zone.id === zoneId)?.accountId;
        if (!accountId) throw new Error('That zone is not in a connected Cloudflare account.');
        await this.deps.cloudflare.useApi(accountId, 'zoneSettings', (api) =>
          api.zones.settings.edit('tls_client_auth', { zone_id: zoneId, value: 'on' }),
        );
      }
    }
    return this.deps.onLinkConnection(input.serverId, (sshConnection) =>
      this.core(input.serverId, (hub) =>
        hub.applyOriginLock({
          enabled: input.enabled,
          authenticatedOriginPulls: input.authenticatedOriginPulls,
          ...(sshConnection ? { sshConnection } : {}),
        }),
      ),
    );
  }

  /**
   * An Origin CA certificate for a site: the core makes the key and its signing request, Cloudflare
   * signs it with the token of the account that holds the site's domain, and the core checks and
   * installs the certificate.
   */
  async originCertificate(
    input: CloudflareOriginCertificateInput,
  ): Promise<CertificateUploadResult> {
    this.requireAdmin(input.serverId);
    const request = await this.core(input.serverId, (hub) =>
      hub.createOriginCertificateRequest(input.siteId),
    );
    const accountId = await this.accountForHostnames(request.hostnames);
    const signed = await this.deps.cloudflare.useApi(accountId, 'sslCertificates', (api) =>
      api.originCACertificates.create({
        csr: request.csrPem,
        hostnames: request.hostnames,
        request_type: 'origin-ecc',
        requested_validity: ORIGIN_VALIDITY_DAYS,
      }),
    );
    const certificatePem = signed.certificate;
    if (!certificatePem) throw new Error('Cloudflare answered without the certificate.');
    return this.core(input.serverId, (hub) =>
      hub.installOriginCertificate({ siteId: input.siteId, certificatePem }),
    );
  }

  dnsTokens(serverId: string): Promise<DnsCredentialInfo[]> {
    return this.core(serverId, (hub) => hub.listDnsCredentials());
  }

  /**
   * Sends a server a DNS token for one zone. Made here, it can edit that zone's DNS and nothing
   * else; pasted, it is checked first and refused if it is the account token itself. Either way
   * the account token stays here.
   */
  async provisionDnsToken(input: CloudflareDnsTokenInput): Promise<DnsCredentialInfo> {
    this.requireAdmin(input.serverId);
    const zone = (await this.deps.cloudflare.allZones()).find((item) => item.id === input.zoneId);
    if (!zone) throw new Error('That zone is not in a connected Cloudflare account.');
    let token: string;
    let tokenId: string | undefined;
    if (input.mode === 'mint') {
      ({ token, tokenId } = await this.mint(zone, await this.deps.serverName(input.serverId)));
    } else {
      token = input.token.trim();
      await this.checkPasted(token, zone);
    }
    let saved: Awaited<ReturnType<ICoreHub['saveDnsCredential']>>;
    try {
      saved = await this.core(input.serverId, (hub) =>
        hub.saveDnsCredential({
          zone: zone.name,
          zoneId: zone.id,
          token,
          ...(tokenId ? { tokenId } : {}),
        }),
      );
    } catch (error) {
      if (tokenId) await this.forget(zone.accountId, tokenId);
      throw error;
    }
    if (!saved.credential) {
      if (tokenId) await this.forget(zone.accountId, tokenId);
      throw new Error(saved.problems.join(' ') || 'The server did not keep the token.');
    }
    return saved.credential;
  }

  /** Takes the token off the server, and deletes it at Cloudflare when Runova made it. */
  async removeDnsToken(input: CloudflareRemoveDnsTokenInput): Promise<void> {
    const known = (await this.dnsTokens(input.serverId)).find((item) => item.zone === input.zone);
    await this.core(input.serverId, (hub) => hub.removeDnsCredential(input.zone));
    if (input.deleteAtCloudflare && known?.tokenId) {
      const tokenId = known.tokenId;
      const zone = (await this.deps.cloudflare.allZones()).find((item) => item.name === input.zone);
      if (!zone) {
        throw new Error(
          `The token is off the server, but ${input.zone} is not in a connected Cloudflare account, so it could not be deleted at Cloudflare.`,
        );
      }
      await this.deps.cloudflare.useApi(zone.accountId, 'apiTokens', (api) =>
        api.user.tokens.delete(tokenId),
      );
    }
  }

  private async mint(zone: CloudflareZone, serverName: string) {
    const groups = await this.deps.cloudflare.useApi(zone.accountId, 'apiTokens', async (api) => {
      const page = await api.user.tokens.permissionGroups.list();
      return page.result;
    });
    const dnsWrite = groups.find(
      (group) =>
        group.name === 'DNS Write' && group.scopes?.includes('com.cloudflare.api.account.zone'),
    );
    if (!dnsWrite?.id) throw new Error('Cloudflare did not list its DNS Write permission group.');
    const groupId = dnsWrite.id;
    const created = await this.deps.cloudflare.useApi(zone.accountId, 'apiTokens', (api) =>
      api.user.tokens.create({
        name: `Runova DNS-01, ${zone.name} on ${serverName}`.slice(0, 120),
        policies: [
          {
            effect: 'allow',
            resources: { [`com.cloudflare.api.account.zone.${zone.id}`]: '*' },
            permission_groups: [{ id: groupId }],
          },
        ],
      }),
    );
    if (!created.value || !created.id)
      throw new Error('Cloudflare made the token but did not return it.');
    return { token: created.value, tokenId: created.id };
  }

  private async checkPasted(token: string, zone: CloudflareZone): Promise<void> {
    const problem = tokenProblem(token);
    if (problem) throw new Error(problem);
    if (await this.deps.cloudflare.isSavedToken(token)) {
      throw new Error(
        'That is the token this app uses for your whole account, which never goes to a server. Paste a token limited to Zone > DNS > Edit on this zone.',
      );
    }
    await this.deps.cloudflare.withPastedToken(token, async (api) => {
      const verified = await api.user.tokens.verify();
      if (verified.status !== 'active')
        throw new Error(`This token is ${verified.status} on Cloudflare.`);
      try {
        await api.dns.records.list({ zone_id: zone.id, per_page: 5 });
      } catch {
        throw new Error(
          encodeCloudflareError(
            'missing-permission',
            `This token cannot read the DNS records of ${zone.name}. It needs Zone > DNS > Edit on that zone.`,
            'dns',
          ),
        );
      }
    });
  }

  /** Deletes a token made here that no server ended up keeping. */
  private async forget(accountId: string, tokenId: string): Promise<void> {
    try {
      await this.deps.cloudflare.useApi(accountId, 'apiTokens', (api) =>
        api.user.tokens.delete(tokenId),
      );
    } catch {
      // The token is unused either way; the next look at Cloudflare's token list shows it.
    }
  }

  /**
   * The account that signs a certificate for these hostnames: the one holding their zones. With a
   * single account that is simply the account; with several, hostnames that no account holds, or
   * that sit in different accounts, cannot be signed as one certificate.
   */
  private async accountForHostnames(hostnames: string[]): Promise<string> {
    const zones = await this.deps.cloudflare.allZones();
    const owners = new Set<string>();
    const outside: string[] = [];
    for (const hostname of hostnames) {
      const zone = zoneOf(hostname, zones);
      if (zone) owners.add(zone.accountId);
      else outside.push(hostname);
    }
    if (owners.size === 1 && outside.length === 0) return [...owners][0] as string;
    if (owners.size > 1) {
      throw new Error(
        'The names on this certificate are in different Cloudflare accounts. Keep the site to domains of one account, or make one certificate per account.',
      );
    }
    const accounts = [...new Set(zones.map((zone) => zone.accountId))];
    if (owners.size === 0 && accounts.length === 1) return accounts[0] as string;
    throw new Error(
      `No connected Cloudflare account holds ${outside.join(', ')}. Add the domain to one of your accounts, or connect the account that has it.`,
    );
  }

  private async domainChecks(serverId: string): Promise<CloudflareDomainCheck[]> {
    return (await this.domainChecksWithZones(serverId)).checks;
  }

  private async domainChecksWithZones(
    serverId: string,
  ): Promise<{ checks: CloudflareDomainCheck[]; zones: CloudflareZone[] }> {
    const sites = await this.core(serverId, (hub) => hub.listSites());
    const domains = [
      ...new Set(sites.flatMap((site) => site.settings.domains.map((d) => d.toLowerCase()))),
    ];
    if (domains.length === 0) return { checks: [], zones: [] };
    const zones = await this.deps.cloudflare.allZones();
    const records = new Map<string, Awaited<ReturnType<CloudflareService['listRecords']>>>();
    const checks: CloudflareDomainCheck[] = [];
    for (const domain of domains) {
      const zone = zoneOf(domain, zones);
      if (!zone) {
        checks.push({ domain, zoneId: null, zoneName: null, proxied: null });
        continue;
      }
      if (!records.has(zone.id))
        records.set(zone.id, await this.deps.cloudflare.listRecords(zone.id));
      const own = (records.get(zone.id) ?? []).filter(
        (record) => ADDRESS_TYPES.has(record.type) && record.name.toLowerCase() === domain,
      );
      checks.push({
        domain,
        zoneId: zone.id,
        zoneName: zone.name,
        proxied: own.length === 0 ? null : own.every((record) => record.proxied),
      });
    }
    return { checks, zones };
  }

  /** Nothing is made at Cloudflare for a server whose core would refuse it anyway. */
  private requireAdmin(serverId: string): void {
    const roles = this.deps.roles(serverId);
    if (roles && !roles.some((role) => ADMIN_ROLES.has(role))) {
      throw new Error(
        encodeCoreError(
          'forbidden',
          `Your role on this server (${roles.join(', ')}) cannot do that.`,
        ),
      );
    }
  }

  private core<T>(serverId: string, work: (hub: ICoreHub) => Promise<T>): Promise<T> {
    return callCore({ links: this.deps.links, roles: this.deps.roles }, serverId, work);
  }
}
