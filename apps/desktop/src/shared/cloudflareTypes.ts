import type { OriginLockPreview } from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Plain data the Cloudflare dialog passes between the main process and the renderer. The API token
 * is not in here on purpose: the renderer hands it over once to be saved, and from then on only
 * learns that one is set and what it is allowed to do.
 */

/** A permission Runova asks for when it guides the user through creating a token. */
export type CloudflarePermissionId =
  | 'zone'
  | 'dns'
  | 'zoneSettings'
  | 'cachePurge'
  | 'waf'
  | 'accessRules';

/**
 * Granted or missing, as far as a check that never changes anything can tell. Cache Purge has no
 * read-only call to try, so it stays unverified until the token's own policies say, or a purge.
 */
export type CloudflarePermissionState = 'granted' | 'missing' | 'unverified';

export interface CloudflarePermissionCheck {
  id: CloudflarePermissionId;
  state: CloudflarePermissionState;
}

export interface CloudflareTokenReport {
  /** Cloudflare's id for the token, which is not a secret. */
  tokenId: string;
  status: 'active' | 'disabled' | 'expired';
  expiresOn: string | null;
  /**
   * Where the answer came from: the token's own policies (it may read itself), or read-only
   * calls tried with it, which cannot tell a read permission from an edit one.
   */
  source: 'policies' | 'probes';
  permissions: CloudflarePermissionCheck[];
  /** How many zones the token can see. */
  zoneCount: number;
  checkedAt: number;
}

/** One connected Cloudflare account: a name the user gave it and the state of its token. */
export interface CloudflareAccountStatus {
  id: string;
  label: string;
  /** Its token is sealed with the Servers passkey, which is locked right now. */
  locked: boolean;
  report: CloudflareTokenReport | null;
}

export interface CloudflareStatus {
  /** Whether at least one account is connected. */
  configured: boolean;
  /** Some saved token is sealed with the Servers passkey, which is locked right now. */
  locked: boolean;
  accounts: CloudflareAccountStatus[];
}

/** Adds an account, or with `accountId` replaces that account's token. */
export interface CloudflareSaveTokenInput {
  token: string;
  /** What the user calls a new account. Left out, it is numbered. */
  label?: string;
  accountId?: string;
}

export interface CloudflareZone {
  id: string;
  /** The connected account that holds this zone. */
  accountId: string;
  name: string;
  /** Cloudflare's word for it: active, pending, initializing or moved. */
  status: string;
  paused: boolean;
  /** The plan's name, such as "Free Website". */
  plan: string;
  nameServers: string[];
}

/** The record types the page can create and edit. Others in a zone are listed read-only. */
export type CloudflareRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'CAA' | 'SRV';

export interface CloudflareCaaData {
  flags: number;
  tag: 'issue' | 'issuewild' | 'iodef';
  value: string;
}

export interface CloudflareSrvData {
  priority: number;
  weight: number;
  port: number;
  target: string;
}

export interface CloudflareDnsRecord {
  id: string;
  /** Any type the zone has; `editable` says whether the page can change it. */
  type: string;
  name: string;
  content: string;
  /** Seconds, or 1 for automatic. */
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  priority?: number;
  caa?: CloudflareCaaData;
  srv?: CloudflareSrvData;
  comment?: string;
  editable: boolean;
}

/** What the record editor sends, one shape per type. Names are full names inside the zone. */
export type CloudflareRecordInput =
  | {
      type: 'A' | 'AAAA' | 'CNAME';
      name: string;
      content: string;
      ttl: number;
      proxied: boolean;
      comment?: string;
    }
  | { type: 'TXT'; name: string; content: string; ttl: number; comment?: string }
  | { type: 'MX'; name: string; content: string; priority: number; ttl: number; comment?: string }
  | { type: 'CAA'; name: string; caa: CloudflareCaaData; ttl: number; comment?: string }
  | { type: 'SRV'; name: string; srv: CloudflareSrvData; ttl: number; comment?: string };

export type CloudflareSecurityLevel =
  | 'off'
  | 'essentially_off'
  | 'low'
  | 'medium'
  | 'high'
  | 'under_attack';

/** `origin_pull` is Enterprise's "Strict (SSL-Only Origin Pull)"; the page only shows it. */
export type CloudflareSslMode = 'off' | 'flexible' | 'full' | 'strict' | 'origin_pull';

/** Cloudflare's dashboard calls these No query string, Ignore query string and Standard. */
export type CloudflareCacheLevel = 'basic' | 'simplified' | 'aggressive';

export type CloudflareMinTlsVersion = '1.0' | '1.1' | '1.2' | '1.3';

export interface CloudflareZoneSettings {
  developmentMode: { value: 'on' | 'off'; secondsRemaining: number; editable: boolean };
  securityLevel: { value: CloudflareSecurityLevel; editable: boolean };
  ssl: { value: CloudflareSslMode; editable: boolean };
  alwaysUseHttps: { value: 'on' | 'off'; editable: boolean };
  automaticHttpsRewrites: { value: 'on' | 'off'; editable: boolean };
  minTlsVersion: { value: CloudflareMinTlsVersion; editable: boolean };
  /** `zrt` is TLS 1.3 with 0-RTT, which only Cloudflare turns on; the page sets on or off. */
  tls13: { value: 'on' | 'off' | 'zrt'; editable: boolean };
  cacheLevel: { value: CloudflareCacheLevel; editable: boolean };
  /** Seconds a browser keeps a file; 0 respects the server's own headers. */
  browserCacheTtl: { value: number; editable: boolean };
}

export type CloudflareSettingChange =
  | { setting: 'developmentMode'; value: 'on' | 'off' }
  | { setting: 'securityLevel'; value: CloudflareSecurityLevel }
  | { setting: 'ssl'; value: Exclude<CloudflareSslMode, 'origin_pull'> }
  | { setting: 'alwaysUseHttps'; value: 'on' | 'off' }
  | { setting: 'automaticHttpsRewrites'; value: 'on' | 'off' }
  | { setting: 'minTlsVersion'; value: CloudflareMinTlsVersion }
  | { setting: 'tls13'; value: 'on' | 'off' }
  | { setting: 'cacheLevel'; value: CloudflareCacheLevel }
  | { setting: 'browserCacheTtl'; value: number };

export type CloudflarePurgeRequest = { everything: true } | { urls: string[] };

/** The custom rule builder's choices; the main process turns each into an expression. */
export type CloudflareRuleSpec =
  | { kind: 'block-countries'; countries: string[] }
  | { kind: 'challenge-path'; path: string; match: 'exact' | 'prefix' }
  | { kind: 'allow-ips'; ips: string[] };

export interface CloudflareCustomRuleInput {
  description: string;
  spec: CloudflareRuleSpec;
}

export interface CloudflareCustomRule {
  id: string;
  description: string;
  expression: string;
  action: string;
  enabled: boolean;
  lastUpdated: string | null;
}

/** `whitelist` is what the API calls "Allow". */
export type CloudflareAccessMode =
  | 'block'
  | 'challenge'
  | 'js_challenge'
  | 'managed_challenge'
  | 'whitelist';

export type CloudflareAccessTarget = 'ip' | 'ip6' | 'ip_range' | 'country' | 'asn';

export interface CloudflareAccessRule {
  id: string;
  mode: CloudflareAccessMode;
  target: CloudflareAccessTarget;
  value: string;
  notes: string;
  createdOn: string | null;
}

export interface CloudflareAccessRuleInput {
  mode: CloudflareAccessMode;
  /** An IP address, a range, a two-letter country code or an AS number such as AS13335. */
  value: string;
  notes: string;
}

/** Points a name in a zone at one of the saved servers. */
export interface CloudflarePointDomainInput {
  zoneId: string;
  /** "@" for the zone itself, a name inside it ("app"), or the full name. */
  name: string;
  serverId: string;
  includeWww: boolean;
  proxied: boolean;
}

export type CloudflarePlanAction = 'create' | 'update' | 'delete' | 'keep';

export interface CloudflarePlannedChange {
  action: CloudflarePlanAction;
  type: 'A' | 'AAAA' | 'CNAME';
  name: string;
  /** What the record holds afterwards, or what it held when it goes. */
  content: string;
  /** For an update, what it held before. */
  previous?: string;
  proxied: boolean;
  recordId?: string;
  /** Why a record goes: a CNAME cannot share a name with addresses, or it points elsewhere. */
  reason?: 'cname-conflict' | 'other-address';
}

export interface CloudflarePointDomainPlan {
  zoneName: string;
  /** The full names the plan covers, such as example.com and www.example.com. */
  names: string[];
  addresses: { ipv4: string[]; ipv6: string[] };
  changes: CloudflarePlannedChange[];
  /** Every record already points at the server, so there is nothing to apply. */
  upToDate: boolean;
}

export interface CloudflarePointDomainResult {
  plan: CloudflarePointDomainPlan;
  /** How many creates, updates and removals were sent. */
  applied: number;
}

/**
 * Permissions only some features need, asked for when one of them is used (E14): the setup guide
 * lists them as optional, and a refusal names them like the others.
 */
export type CloudflareExtraPermissionId = 'sslCertificates' | 'apiTokens';

export type CloudflareAnyPermissionId = CloudflarePermissionId | CloudflareExtraPermissionId;

/** How a site domain on a server stands in Cloudflare, for the origin lock's checks. */
export interface CloudflareDomainCheck {
  domain: string;
  /** The account's zone it belongs to, or null when no zone of this account holds it. */
  zoneId: string | null;
  zoneName: string | null;
  /** Whether its A/AAAA/CNAME records go through the proxy; null when it has none. */
  proxied: boolean | null;
}

export interface CloudflareOriginLockInput {
  serverId: string;
  enabled: boolean;
  authenticatedOriginPulls: boolean;
}

/** Send a server a DNS token for one zone: made here with the account token, or pasted. */
export type CloudflareDnsTokenInput =
  | { serverId: string; zoneId: string; mode: 'mint' }
  | { serverId: string; zoneId: string; mode: 'paste'; token: string };

export interface CloudflareRemoveDnsTokenInput {
  serverId: string;
  zone: string;
  /** Also delete the token at Cloudflare, when Runova made it. */
  deleteAtCloudflare: boolean;
}

export interface CloudflareOriginCertificateInput {
  serverId: string;
  siteId: string;
}

/** What turning the origin lock on or off would do: the core's plan, and each site domain's state. */
export interface CloudflareOriginLockPlan {
  preview: OriginLockPreview;
  domains: CloudflareDomainCheck[];
}
