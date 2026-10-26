import { CLOUDFLARE_PERMISSIONS } from '../../../shared/cloudflare/permissions';
import type {
  CloudflarePermissionCheck,
  CloudflarePermissionId,
  CloudflarePermissionState,
  CloudflareTokenReport,
} from '../../../shared/cloudflareTypes';
import type { CloudflareApi } from './client';
import { isNotFound, isPermissionDenied, isUnauthorized } from './errors';

/**
 * Checks a token against the permissions Runova asks for, without changing anything. A token
 * that may read itself (it has API Tokens Read) shows its policies, which say exactly what it
 * has. Most tokens made from the template cannot, so then each permission is tried with a call
 * that only reads: a refusal means the permission is missing. Reads cannot tell Read from Edit,
 * and Cache Purge has nothing to read; a later change that Cloudflare refuses names the
 * permission instead (see service.ts).
 */

export interface TokenPolicy {
  effect?: string;
  permission_groups?: Array<{ id?: string; name?: string }>;
}

/** Each Runova permission, granted when an allow policy has one of its groups and none denies it. */
export function permissionsFromPolicies(policies: TokenPolicy[]): CloudflarePermissionCheck[] {
  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const policy of policies) {
    const names = policy.effect === 'deny' ? denied : allowed;
    for (const group of policy.permission_groups ?? []) {
      // The dashboard says "Edit" where the API says "Write".
      if (group.name) names.add(group.name.replace(/ Edit$/, ' Write'));
    }
  }
  return CLOUDFLARE_PERMISSIONS.map(({ id, apiNames }) => ({
    id,
    state: apiNames.some((name) => allowed.has(name) && !denied.has(name)) ? 'granted' : 'missing',
  }));
}

async function readPolicies(
  api: CloudflareApi,
  tokenId: string,
): Promise<CloudflarePermissionCheck[] | null> {
  try {
    const token = await api.user.tokens.get(tokenId);
    return permissionsFromPolicies(token.policies ?? []);
  } catch (error) {
    if (isPermissionDenied(error) || isUnauthorized(error)) return null;
    throw error;
  }
}

async function firstZones(api: CloudflareApi): Promise<{ count: number; firstId: string | null }> {
  try {
    const page = await api.zones.list({ per_page: 50 });
    // The SDK's types leave out the total the API reports.
    const total = (page.result_info as { total_count?: number } | undefined)?.total_count;
    return { count: total ?? page.result.length, firstId: page.result[0]?.id ?? null };
  } catch (error) {
    if (isPermissionDenied(error)) return { count: 0, firstId: null };
    throw error;
  }
}

async function probe(
  call: () => Promise<unknown>,
  { notFoundMeansReadable = false } = {},
): Promise<CloudflarePermissionState> {
  try {
    await call();
    return 'granted';
  } catch (error) {
    if (isPermissionDenied(error)) return 'missing';
    if (notFoundMeansReadable && isNotFound(error)) return 'granted';
    throw error;
  }
}

async function probeAll(
  api: CloudflareApi,
  zoneId: string | null,
): Promise<CloudflarePermissionCheck[]> {
  const found: Partial<Record<CloudflarePermissionId, CloudflarePermissionState>> = {
    zone: zoneId ? 'granted' : 'missing',
  };
  if (zoneId) {
    const zone_id = zoneId;
    [found.dns, found.zoneSettings, found.waf, found.accessRules] = await Promise.all([
      probe(() => api.dns.records.list({ zone_id, per_page: 5 })),
      probe(() => api.zones.settings.get('always_use_https', { zone_id })),
      // A zone without custom rules has no entry point yet; reading it still answers 404.
      probe(() => api.rulesets.phases.get('http_request_firewall_custom', { zone_id }), {
        notFoundMeansReadable: true,
      }),
      probe(() => api.firewall.accessRules.list({ zone_id, per_page: 5 })),
    ]);
  }
  return CLOUDFLARE_PERMISSIONS.map(({ id }) => ({ id, state: found[id] ?? 'unverified' }));
}

export async function checkToken(
  api: CloudflareApi,
  checkedAt: number,
): Promise<CloudflareTokenReport> {
  const verified = await api.user.tokens.verify();
  const zones = await firstZones(api);
  const policies = await readPolicies(api, verified.id);
  return {
    tokenId: verified.id,
    status: verified.status,
    expiresOn: verified.expires_on ?? null,
    source: policies ? 'policies' : 'probes',
    permissions: policies ?? (await probeAll(api, zones.firstId)),
    zoneCount: zones.count,
    checkedAt,
  };
}
