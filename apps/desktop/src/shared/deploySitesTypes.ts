import type {
  CertificateRevocationReason,
  SiteLogKind,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployStepUpInput } from './deployTypes';

/**
 * What a server's Websites section sends to the main process: sites, stream proxies, applying
 * nginx, certificates and site logs (E10, E11). Answers are the core's own contract types
 * (SiteInfo, NginxStatus, CertificateInfo...). Private keys and basic auth passwords only ever
 * travel inwards, from a form to the core; nothing here is stored.
 */

export interface DeploySiteLogWatchInput {
  serverId: string;
  siteId: string;
  kind: SiteLogKind;
  /** How many of the last lines to start with (the core's default when left out). */
  tailLines?: number;
}

export interface DeploySiteLogEvent {
  subscriptionId: string;
  serverId: string;
  siteId: string;
  kind: SiteLogKind;
  lines: string[];
  /**
   * True when what the window shows should be thrown away first: the file was rotated, or the
   * log started over on a new connection with its last lines again.
   */
  reset: boolean;
  /** Set once the log is over: the site went away or the core refused to show it. */
  ended?: { error?: string };
}

export interface DeployCertificateIssueInput {
  serverId: string;
  siteId: string;
  /** The CA's terms; the first order from this server to a CA needs them accepted. */
  acceptTermsOfService: boolean;
  contactEmail?: string;
  /** Let's Encrypt's staging CA: untrusted certificates, generous rate limits. */
  staging: boolean;
  /**
   * Validate over DNS-01 with the server's Cloudflare DNS token for the zone (E14), for names
   * behind the proxy or with port 80 closed. Wildcards always use it.
   */
  preferDns01?: boolean;
}

export interface DeployCertificateUploadInput {
  serverId: string;
  siteId: string;
  certificatePem: string;
  privateKeyPem: string;
}

/** Needs a step-up, so it carries the password (or a code) when the last one ran out. */
export interface DeployCertificateRemoveInput extends DeployStepUpInput {
  siteId: string;
  revoke: boolean;
  reason: CertificateRevocationReason;
}
