import type { CloudflareZone } from '@shared/cloudflareTypes';
import type { SiteInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { normalizeDomain } from '@shared/recaptcha/domains';
import { useQueryClient } from '@tanstack/react-query';
import { useWordPressSites } from '@/components/deploy/wordpress/hooks';
import { queryKeys } from '@/lib/queryKeys';

/** A site the create-key dialog can start from: its name and the domains it fills in. */
export interface SiteSuggestion {
  id: string;
  label: string;
  domains: string[];
  source: 'server' | 'wordpress' | 'cloudflare';
}

function clean(domains: readonly string[]): string[] {
  const out: string[] = [];
  for (const domain of domains) {
    const result = normalizeDomain(domain);
    if (result.ok && !out.includes(result.domain)) out.push(result.domain);
  }
  return out;
}

/**
 * The sites Runova already knows about, for the create-key dialog: the nginx sites of servers
 * whose Websites section has been opened, the WordPress sites, and the Cloudflare domains. It only
 * reads what the app has loaded, so opening the dialog never signs in to a server. A domain that
 * already came from one source is not suggested again from another.
 */
export function useSiteDomainSuggestions(): SiteSuggestion[] {
  const queryClient = useQueryClient();
  const wordPress = useWordPressSites();
  const suggestions: SiteSuggestion[] = [];
  const seen = new Set<string>();
  const add = (suggestion: SiteSuggestion) => {
    if (suggestion.domains.length === 0 || seen.has(suggestion.domains[0] ?? '')) return;
    for (const domain of suggestion.domains) seen.add(domain);
    suggestions.push(suggestion);
  };

  for (const [key, sites] of queryClient.getQueriesData<SiteInfo[]>({
    queryKey: ['deploy', 'web'],
  })) {
    // ['deploy', 'web', serverId, 'sites']
    if (key[3] !== 'sites' || !Array.isArray(sites)) continue;
    const serverId = String(key[2]);
    for (const site of sites) {
      const domains = clean(site.settings?.domains ?? []);
      add({
        id: `site:${serverId}:${site.settings.id}`,
        label: domains[0] ?? '',
        domains,
        source: 'server',
      });
    }
  }
  for (const site of wordPress.data ?? []) {
    let host = '';
    try {
      host = new URL(site.siteUrl).hostname;
    } catch {
      continue;
    }
    add({ id: `wp:${site.id}`, label: site.label, domains: clean([host]), source: 'wordpress' });
  }
  for (const [, zones] of queryClient.getQueriesData<CloudflareZone[]>({
    queryKey: queryKeys.cloudflareZones,
  })) {
    for (const zone of Array.isArray(zones) ? zones : []) {
      add({
        id: `zone:${zone.id}`,
        label: zone.name,
        domains: clean([zone.name]),
        source: 'cloudflare',
      });
    }
  }
  return suggestions;
}
