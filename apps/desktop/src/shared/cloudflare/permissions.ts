import type {
  CloudflareAnyPermissionId,
  CloudflareExtraPermissionId,
  CloudflarePermissionId,
} from '../cloudflareTypes';

/**
 * The Cloudflare permissions Runova asks for, and nothing beyond them: every one is a zone
 * permission, so the token cannot touch billing, members, Workers or other tokens. The renderer
 * lists them in the setup guide; the main process checks a token against them.
 */

export interface CloudflarePermission<
  Id extends CloudflareAnyPermissionId = CloudflarePermissionId,
> {
  id: Id;
  /** As Cloudflare's token page shows it: group, permission, access level. */
  label: string;
  /** What Runova uses it for, shown next to the label. */
  purpose: string;
  /** Finishes "This token is not allowed to ..." when Cloudflare refuses a call. */
  action: string;
  /**
   * The key and type for Cloudflare's token template link. Every key but `zone_waf` is in
   * Cloudflare's published table; if the page skips one, the check after pasting still asks for it.
   */
  template: { key: string; type: 'read' | 'edit' | 'purge' };
  /** Permission group names, as the API reports them on a token's policies, that grant it. */
  apiNames: readonly string[];
}

export const CLOUDFLARE_PERMISSIONS: readonly CloudflarePermission[] = [
  {
    id: 'zone',
    label: 'Zone > Zone > Read',
    purpose: 'See your domains',
    action: 'list your domains',
    template: { key: 'zone', type: 'read' },
    apiNames: ['Zone Read', 'Zone Write'],
  },
  {
    id: 'dns',
    label: 'Zone > DNS > Edit',
    purpose: 'Add, change and remove DNS records',
    action: 'change DNS records',
    template: { key: 'dns', type: 'edit' },
    apiNames: ['DNS Write'],
  },
  {
    id: 'zoneSettings',
    label: 'Zone > Zone Settings > Edit',
    purpose: 'Development mode, security level, SSL/TLS and caching settings',
    action: 'change zone settings',
    template: { key: 'zone_settings', type: 'edit' },
    apiNames: ['Zone Settings Write'],
  },
  {
    id: 'cachePurge',
    label: 'Zone > Cache Purge > Purge',
    purpose: 'Purge cached files',
    action: 'purge the cache',
    template: { key: 'cache', type: 'purge' },
    apiNames: ['Cache Purge'],
  },
  {
    id: 'waf',
    label: 'Zone > Zone WAF > Edit',
    purpose: 'WAF custom rules',
    action: 'change WAF custom rules',
    template: { key: 'zone_waf', type: 'edit' },
    apiNames: ['Zone WAF Write'],
  },
  {
    id: 'accessRules',
    label: 'Zone > Firewall Services > Edit',
    purpose: 'IP access rules',
    action: 'change IP access rules',
    template: { key: 'firewall_services', type: 'edit' },
    apiNames: ['Firewall Services Write'],
  },
];

/**
 * Asked for only when a feature needs it, so the main token can stay without them: Origin CA
 * certificates need SSL and Certificates, and making a server its own zone-scoped DNS token needs
 * API Tokens (a user permission, which is why pasting a token made by hand is offered too).
 */
export const CLOUDFLARE_EXTRA_PERMISSIONS: readonly CloudflarePermission<CloudflareExtraPermissionId>[] =
  [
    {
      id: 'sslCertificates',
      label: 'Zone > SSL and Certificates > Edit',
      purpose: 'Origin CA certificates for your servers',
      action: 'create Origin CA certificates',
      template: { key: 'ssl_and_certificates', type: 'edit' },
      apiNames: ['SSL and Certificates Write'],
    },
    {
      id: 'apiTokens',
      label: 'User > API Tokens > Edit',
      purpose: 'A separate DNS token for a server, for wildcard certificates',
      action: 'create API tokens',
      template: { key: 'api_tokens', type: 'edit' },
      apiNames: ['API Tokens Write'],
    },
  ];

/** Cloudflare's page for creating and editing user API tokens. */
export const TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens';

export function cloudflarePermission(
  id: CloudflareAnyPermissionId,
): CloudflarePermission<CloudflareAnyPermissionId> {
  const permission = [...CLOUDFLARE_PERMISSIONS, ...CLOUDFLARE_EXTRA_PERMISSIONS].find(
    (candidate) => candidate.id === id,
  );
  if (!permission) throw new Error(`Unknown Cloudflare permission: ${id}`);
  return permission;
}

/** The token page with Runova's permissions, all zones and a name filled in. */
export function tokenTemplateUrl(): string {
  const keys = CLOUDFLARE_PERMISSIONS.map(({ template }) => ({
    key: template.key,
    type: template.type,
  }));
  const query = [
    `permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}`,
    'accountId=*',
    'zoneId=all',
    'name=Runova',
  ];
  return `${TOKEN_PAGE}?${query.join('&')}`;
}

/** What to add to the token on Cloudflare, in the order the token page lists them. */
export function missingPermissionLabels(missing: CloudflarePermissionId[]): string[] {
  return CLOUDFLARE_PERMISSIONS.filter((permission) => missing.includes(permission.id)).map(
    (permission) => permission.label,
  );
}

/** What to tell the user when Cloudflare refuses a change for want of a permission. */
export function permissionDeniedMessage(id: CloudflareAnyPermissionId): string {
  const permission = cloudflarePermission(id);
  return `This token is not allowed to ${permission.action}. On Cloudflare, edit the token and add ${permission.label}, then check it again here.`;
}

const PRINTABLE = /^[\x21-\x7e]+$/;
const GLOBAL_API_KEY = /^[0-9a-f]{37}$/;

/**
 * Why the pasted text cannot be a Cloudflare API token, or null when it might be one. Tokens are
 * printable ASCII with no spaces, which also keeps them from breaking out of the request header.
 */
export function tokenProblem(token: string): string | null {
  if (token.length === 0) return 'Paste the token Cloudflare showed you.';
  if (GLOBAL_API_KEY.test(token)) {
    return 'That looks like your Global API Key, which can do anything on your account. Runova needs an API token limited to the permissions listed here.';
  }
  if (token.startsWith('v1.0-')) {
    return 'That looks like an Origin CA Key. Runova needs an API token from the same page.';
  }
  if (/\s/.test(token)) return 'A token has no spaces in it. Copy it again from Cloudflare.';
  if (token.length < 20) return 'That is too short to be a Cloudflare API token.';
  if (token.length > 512) return 'That is too long to be a Cloudflare API token.';
  return PRINTABLE.test(token)
    ? null
    : 'That has characters a Cloudflare API token never has. Copy it again from Cloudflare.';
}
