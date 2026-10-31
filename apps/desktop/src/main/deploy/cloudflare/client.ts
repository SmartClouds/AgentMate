import { BaseCache } from 'cloudflare/resources/cache/cache';
import { BaseRecords } from 'cloudflare/resources/dns/records';
import { BaseAccessRules } from 'cloudflare/resources/firewall/access-rules';
import { BaseOriginCACertificates } from 'cloudflare/resources/origin-ca-certificates/origin-ca-certificates';
import { BasePhases } from 'cloudflare/resources/rulesets/phases/phases';
import { BaseRules } from 'cloudflare/resources/rulesets/rules';
import { BaseRulesets } from 'cloudflare/resources/rulesets/rulesets';
import { BaseWidgets } from 'cloudflare/resources/turnstile/widgets';
import { BasePermissionGroups } from 'cloudflare/resources/user/tokens/permission-groups';
import { BaseTokens } from 'cloudflare/resources/user/tokens/tokens';
import { BaseSettings } from 'cloudflare/resources/zones/settings';
import { BaseZones } from 'cloudflare/resources/zones/zones';
import { createClient } from 'cloudflare/tree-shakable';

/**
 * The official Cloudflare SDK, built with only the parts of the API the page uses. Every option
 * that the SDK would otherwise read from the environment is set here, so a CLOUDFLARE_BASE_URL or
 * CLOUDFLARE_API_KEY in the user's shell can never send the token elsewhere or add a second
 * credential; and it never logs, since a debug log would print requests.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export type CloudflareFetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareClientOptions {
  /** Tests pass a fake; otherwise the global fetch at call time, which the proxy setting swaps. */
  fetch?: CloudflareFetch;
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Only the e2e run sets this (see `cloudflareApiBase`), to reach the recorded fake on loopback;
   * nothing in the user's environment can.
   */
  baseURL?: string;
}

const silent = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

export function createCloudflareApi(token: string, options: CloudflareClientOptions = {}) {
  return createClient({
    resources: [
      BaseTokens,
      BaseZones,
      BaseSettings,
      BaseRecords,
      BaseCache,
      BaseRulesets,
      BasePhases,
      BaseRules,
      BaseAccessRules,
      BaseOriginCACertificates,
      BasePermissionGroups,
      BaseWidgets,
    ],
    apiToken: token,
    apiKey: null,
    apiEmail: null,
    userServiceKey: null,
    baseURL: options.baseURL ?? CLOUDFLARE_API,
    fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeoutMs ?? 30_000,
    logLevel: 'off',
    logger: silent,
  });
}

export type CloudflareApi = ReturnType<typeof createCloudflareApi>;
