import { coreErrorCode, encodeCoreError } from '../../../shared/coreErrors';
import type {
  CertificateInfo,
  CertificateUploadResult,
  JobInfo,
  NginxApplyResult,
  NginxStatus,
  SiteInfo,
  SiteSaveResult,
  SiteSettings,
  SiteSnippets,
  StreamProxyInfo,
  StreamProxySaveResult,
  StreamProxySettings,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployCertificateIssueInput,
  DeployCertificateRemoveInput,
  DeployCertificateUploadInput,
} from '../../../shared/deploySitesTypes';
import { hubMessage } from '../connection/hubErrors';
import type { CoreLinks } from '../live/coreLinks';

/**
 * The Websites section's calls (E10, E11), on each server's lasting connection: nginx, its sites
 * and stream proxies, applying them, and certificates. Taking a certificate off needs a step-up,
 * which the call makes on the way when it is handed the password or a code. As for the Overview,
 * the core turns down a missing step-up and a missing role with the same words, so a refusal is
 * told apart here by the signed-in user's roles.
 */

/** What SignalR says when an authorization policy refused a hub method. */
const UNAUTHORIZED = /because user is unauthorized/;
/** Certificates are an Admin's: anyone less is refused for the role, whatever the step-up. */
const CERTIFICATE_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

export interface DeploySitesDeps {
  links: Pick<CoreLinks, 'call'>;
  /** The signed-in user's roles on a server, when this run of the app knows them. */
  roles: (serverId: string) => string[] | null;
}

export class DeploySites {
  constructor(private readonly deps: DeploySitesDeps) {}

  status(serverId: string): Promise<NginxStatus> {
    return this.run(serverId, (hub) => hub.getNginxStatus());
  }

  sites(serverId: string): Promise<SiteInfo[]> {
    return this.run(serverId, (hub) => hub.listSites());
  }

  streams(serverId: string): Promise<StreamProxyInfo[]> {
    return this.run(serverId, (hub) => hub.listStreamProxies());
  }

  certificates(serverId: string): Promise<CertificateInfo[]> {
    return this.run(serverId, (hub) => hub.listCertificates());
  }

  install(serverId: string): Promise<JobInfo> {
    return this.run(serverId, (hub) => hub.installNginx());
  }

  saveSite(serverId: string, settings: SiteSettings): Promise<SiteSaveResult> {
    return this.run(serverId, (hub) => hub.saveSite(settings));
  }

  deleteSite(serverId: string, siteId: string): Promise<void> {
    return this.run(serverId, (hub) => hub.deleteSite(siteId));
  }

  saveStream(serverId: string, settings: StreamProxySettings): Promise<StreamProxySaveResult> {
    return this.run(serverId, (hub) => hub.saveStreamProxy(settings));
  }

  deleteStream(serverId: string, proxyId: string): Promise<void> {
    return this.run(serverId, (hub) => hub.deleteStreamProxy(proxyId));
  }

  apply(serverId: string): Promise<NginxApplyResult> {
    return this.run(serverId, (hub) => hub.applyNginx());
  }

  setSnippets(serverId: string, snippets: SiteSnippets): Promise<SiteSaveResult> {
    return this.run(serverId, (hub) => hub.setSiteSnippets(snippets));
  }

  issue(input: DeployCertificateIssueInput): Promise<JobInfo> {
    return this.run(input.serverId, (hub) =>
      hub.issueCertificate({
        siteId: input.siteId,
        acceptTermsOfService: input.acceptTermsOfService,
        staging: input.staging,
        // DNS-01 needs the server's Cloudflare DNS token for the zone (E14); HTTP-01 otherwise.
        preferDns01: input.preferDns01 === true,
        ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
      }),
    );
  }

  renew(serverId: string, siteId: string): Promise<JobInfo> {
    return this.run(serverId, (hub) => hub.renewCertificate(siteId));
  }

  upload(input: DeployCertificateUploadInput): Promise<CertificateUploadResult> {
    return this.run(input.serverId, (hub) =>
      hub.uploadCertificate({
        siteId: input.siteId,
        certificatePem: input.certificatePem,
        privateKeyPem: input.privateKeyPem,
      }),
    );
  }

  removeCertificate(input: DeployCertificateRemoveInput): Promise<NginxApplyResult> {
    return this.run(
      input.serverId,
      async (hub) => {
        if (input.password || input.totpCode) {
          await hub.stepUp({
            ...(input.password ? { password: input.password } : {}),
            ...(input.totpCode ? { totpCode: input.totpCode } : {}),
          });
        }
        return hub.removeCertificate({
          siteId: input.siteId,
          revoke: input.revoke,
          reason: input.reason,
        });
      },
      CERTIFICATE_ROLES,
    );
  }

  private async run<T>(
    serverId: string,
    work: (hub: ICoreHub) => Promise<T>,
    stepUpRoles?: ReadonlySet<string>,
  ): Promise<T> {
    try {
      return await this.deps.links.call(serverId, work);
    } catch (error) {
      throw this.explain(serverId, error, stepUpRoles);
    }
  }

  private explain(serverId: string, error: unknown, stepUpRoles?: ReadonlySet<string>): Error {
    // The connection's own refusals (a sign-in, a new enrollment) already carry their code.
    if (coreErrorCode(error) && error instanceof Error) return error;
    if (!UNAUTHORIZED.test(error instanceof Error ? error.message : String(error))) {
      return new Error(hubMessage(error));
    }
    const roles = this.deps.roles(serverId);
    if (stepUpRoles && (!roles || roles.some((role) => stepUpRoles.has(role)))) {
      return new Error(
        encodeCoreError(
          'stepUpRequired',
          'Confirm your password (or a code from your authenticator app) to do this.',
        ),
      );
    }
    const which = roles && roles.length > 0 ? ` (${roles.join(', ')})` : '';
    return new Error(
      encodeCoreError('forbidden', `Your role on this server${which} cannot do that.`),
    );
  }
}
