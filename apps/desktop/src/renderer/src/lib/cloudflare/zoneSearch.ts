import type { CloudflareZone } from '@shared/cloudflareTypes';

/**
 * The domain rail's search. People paste whole addresses as often as they type part of a name, so
 * a query is read as the domain inside it before it is matched.
 */

/** Lower case, without the scheme, the path or a leading `www.`. */
export function normalizeZoneQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '');
}

export function zoneMatches(zone: CloudflareZone, query: string): boolean {
  return zone.name.toLowerCase().includes(normalizeZoneQuery(query));
}

/** Where the query sits in a name, as `[start, end)`, or null when it is not there. */
export function matchRange(name: string, query: string): [number, number] | null {
  const needle = normalizeZoneQuery(query);
  if (!needle) return null;
  const start = name.toLowerCase().indexOf(needle);
  return start === -1 ? null : [start, start + needle.length];
}

interface SearchableGroup {
  zones: CloudflareZone[] | undefined;
  error: string | null;
}

/**
 * The groups with only their matching zones. A group still loading or one that failed stays in,
 * so a search never hides that an account's list is missing.
 */
export function filterZoneGroups<T extends SearchableGroup>(groups: T[], query: string): T[] {
  if (!normalizeZoneQuery(query)) return groups;
  return groups.flatMap((group) => {
    if (!group.zones || group.error) return [group];
    const zones = group.zones.filter((zone) => zoneMatches(zone, query));
    return zones.length > 0 ? [{ ...group, zones }] : [];
  });
}
