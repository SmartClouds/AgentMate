/**
 * Cloudflare API v4 payloads in the shape the API returns them, for the fake in fakeCloudflare.ts.
 * They follow the examples in Cloudflare's API reference (developers.cloudflare.com/api) and the
 * official SDK's types; ids and names are the reference's sample values. The fake copies them
 * and changes what a test needs, so every response the SDK parses has the real structure.
 */

export const TOKEN_ID = 'ed17574386854bf78a67040be0a770b0';
export const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353';
export const OTHER_ZONE_ID = '9a7806061c88ada191ed06f989cc3dac';
export const RULESET_ID = '2f2feab2026849078ba485f918791bdc';
export const RULE_ID = '3a03d665bac047339bb530ecb439a90d';
export const RECORD_ID = '372e67954025e0ba6aaa6d586b9e0b59';
export const ACCESS_RULE_ID = '92f17202ed8bd63d69a66b86a49a8f6b';

const STAMP = '2014-01-01T05:20:00.12345Z';

/** GET /user/tokens/verify */
export const verifiedToken = {
  id: TOKEN_ID,
  status: 'active',
  expires_on: '2030-01-01T00:00:00Z',
  not_before: '2018-07-01T05:20:00Z',
};

/** GET /user/tokens/:id, for a token that may read itself. `permission_groups` is filled in. */
export const tokenDetails = {
  id: TOKEN_ID,
  name: 'Runova',
  status: 'active',
  issued_on: '2018-07-01T05:20:00Z',
  modified_on: '2018-07-02T05:20:00Z',
  last_used_on: '2020-01-02T12:34:00Z',
  expires_on: '2030-01-01T00:00:00Z',
  policies: [
    {
      id: 'f267e341f3dd4697bd3b9f71dd96247f',
      effect: 'allow',
      resources: { 'com.cloudflare.api.account.zone.*': '*' },
      permission_groups: [] as Array<{ id: string; name: string }>,
    },
  ],
};

/** One entry of GET /zones. */
export const zone = {
  id: ZONE_ID,
  account: { id: '01a7362d577a6c3019a474fd6f485823', name: 'Demo Account' },
  activated_on: '2014-01-02T00:01:00.12345Z',
  created_on: STAMP,
  development_mode: 0,
  meta: {
    cdn_only: false,
    custom_certificate_quota: 1,
    dns_only: false,
    foundation_dns: false,
    page_rule_quota: 3,
    phishing_detected: false,
    step: 2,
  },
  modified_on: STAMP,
  name: 'example.com',
  name_servers: ['bob.ns.cloudflare.com', 'lola.ns.cloudflare.com'],
  original_dnshost: null,
  original_name_servers: ['ns1.originaldnshost.com', 'ns2.originaldnshost.com'],
  original_registrar: null,
  owner: { id: null, name: null, type: 'user' },
  plan: {
    id: '0feeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    can_subscribe: false,
    currency: 'USD',
    externally_managed: false,
    frequency: '',
    is_subscribed: true,
    legacy_discount: false,
    legacy_id: 'free',
    price: 0,
    name: 'Free Website',
  },
  paused: false,
  permissions: ['#dns_records:edit', '#dns_records:read', '#zone:read'],
  status: 'active',
  type: 'full',
  vanity_name_servers: [],
};

/** One entry of GET /zones/:id/dns_records. */
export const dnsRecord = {
  id: RECORD_ID,
  name: 'example.com',
  type: 'A',
  content: '198.51.100.4',
  proxiable: true,
  proxied: true,
  ttl: 1,
  settings: {},
  meta: {},
  comment: 'Domain verification record',
  tags: [],
  created_on: STAMP,
  modified_on: STAMP,
};

/** GET /zones/:id/settings/:setting, for the settings the page manages. */
export const settings = {
  development_mode: {
    id: 'development_mode',
    value: 'off',
    editable: true,
    modified_on: STAMP,
    time_remaining: 0,
  },
  security_level: { id: 'security_level', value: 'medium', editable: true, modified_on: null },
  ssl: { id: 'ssl', value: 'full', editable: true, modified_on: null },
  always_use_https: { id: 'always_use_https', value: 'off', editable: true, modified_on: null },
  tls_client_auth: { id: 'tls_client_auth', value: 'off', editable: true, modified_on: null },
  automatic_https_rewrites: {
    id: 'automatic_https_rewrites',
    value: 'off',
    editable: true,
    modified_on: null,
  },
  min_tls_version: { id: 'min_tls_version', value: '1.0', editable: true, modified_on: null },
  tls_1_3: { id: 'tls_1_3', value: 'on', editable: true, modified_on: null },
  cache_level: { id: 'cache_level', value: 'aggressive', editable: true, modified_on: null },
  browser_cache_ttl: { id: 'browser_cache_ttl', value: 14400, editable: true, modified_on: null },
};

/** Cloudflare's ids for the permission groups the app names (GET /user/tokens/permission_groups). */
export const DNS_WRITE_GROUP_ID = '4755a26eedb94da69e1066d98aa820be';
export const ZONE_READ_GROUP_ID = 'c8fed203ed3043cba015a93ad1616f1f';

/** GET /user/tokens/permission_groups (an excerpt: the list is long). */
export const permissionGroups = [
  { id: ZONE_READ_GROUP_ID, name: 'Zone Read', scopes: ['com.cloudflare.api.account.zone'] },
  { id: DNS_WRITE_GROUP_ID, name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'] },
  {
    id: '82e64a83756745bbbb1c9c2701bf816b',
    name: 'DNS Read',
    scopes: ['com.cloudflare.api.account.zone'],
  },
  {
    id: '686d18d5ac6c441c867cbf6771e58a0a',
    name: 'API Tokens Write',
    scopes: ['com.cloudflare.api.user'],
  },
];

/** POST /user/tokens: the token's value is only ever in this answer. */
export const createdToken = {
  id: 'ed17574386854bf78a67040be0a770b1',
  name: 'Runova DNS-01',
  status: 'active',
  issued_on: STAMP,
  modified_on: STAMP,
  not_before: null,
  expires_on: null,
  policies: [],
  condition: {},
};

/** POST /certificates (Origin CA): the leaf alone, valid 15 years. */
export const originCertificate = {
  id: '328578533902268680212849205732770752308931942346',
  certificate:
    '-----BEGIN CERTIFICATE-----\nMIIEr6ADAgECAhRvAhAtYW9yZ2luLWNhLXJlY29yZGVkLWZpeHR1cmUwCgYIKoZI\n-----END CERTIFICATE-----\n',
  expires_on: '2041-06-01 12:00:00 +0000 UTC',
  request_type: 'origin-ecc',
  requested_validity: 5475,
};

/** GET /zones/:id/rulesets/phases/http_request_firewall_custom/entrypoint */
export const customRuleset = {
  id: RULESET_ID,
  kind: 'zone',
  last_updated: '2024-06-01T12:00:00Z',
  name: 'default',
  phase: 'http_request_firewall_custom',
  version: '1',
  description: '',
  rules: [
    {
      id: RULE_ID,
      version: '1',
      action: 'block',
      expression: '(ip.src.country in {"T1"})',
      description: 'Block Tor exit nodes',
      last_updated: '2024-06-01T12:00:00Z',
      ref: RULE_ID,
      enabled: true,
    },
  ],
};

/** The 404 Cloudflare sends when a zone has no custom rules yet. */
export const noEntrypoint = {
  success: false,
  errors: [
    {
      code: 10003,
      message: 'could not find entrypoint ruleset in the http_request_firewall_custom phase',
    },
  ],
  messages: [],
  result: null,
};

/** One entry of GET /zones/:id/firewall/access_rules/rules. */
export const accessRule = {
  id: ACCESS_RULE_ID,
  allowed_modes: ['whitelist', 'block', 'challenge', 'js_challenge', 'managed_challenge'],
  configuration: { target: 'ip', value: '198.51.100.4' },
  created_on: STAMP,
  mode: 'block',
  modified_on: STAMP,
  notes: 'This rule is enabled because of an event that occurred on date X.',
  scope: { id: ZONE_ID, name: 'example.com', type: 'zone' },
};

/** What a token without a permission gets back from a route that needs it. */
export const permissionDenied = {
  success: false,
  errors: [{ code: 10000, message: 'Authentication error' }],
  messages: [],
  result: null,
};

/** What GET /user/tokens/:id answers a token that may not read token details. */
export const unauthorizedToRead = {
  success: false,
  errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
  messages: [],
  result: null,
};

/** What any route answers a token Cloudflare does not know. */
export const invalidToken = {
  success: false,
  errors: [{ code: 1000, message: 'Invalid API Token' }],
  messages: [],
  result: null,
};
