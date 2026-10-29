import type { CloudflareZone } from '@shared/cloudflareTypes';
import { describe, expect, it } from 'vitest';
import { filterZoneGroups, matchRange, normalizeZoneQuery, zoneMatches } from './zoneSearch';

function zone(name: string): CloudflareZone {
  return {
    id: name,
    accountId: 'acct-1',
    name,
    status: 'active',
    paused: false,
    plan: 'Free',
    nameServers: [],
  };
}

const SHOP = zone('shop.example.com');
const BLOG = zone('myblog.dev');
const API = zone('api.runova.io');

describe('normalizeZoneQuery', () => {
  it('reads a pasted address as the domain in it', () => {
    expect(normalizeZoneQuery('  Shop ')).toBe('shop');
    expect(normalizeZoneQuery('https://www.Example.com/pricing?a=1')).toBe('example.com');
    expect(normalizeZoneQuery('http://myblog.dev/')).toBe('myblog.dev');
    expect(normalizeZoneQuery('www.')).toBe('');
    expect(normalizeZoneQuery('')).toBe('');
  });
});

describe('zoneMatches', () => {
  it('matches any part of the name, ignoring case', () => {
    expect(zoneMatches(SHOP, 'EXAMPLE')).toBe(true);
    expect(zoneMatches(SHOP, 'https://shop.example.com/cart')).toBe(true);
    expect(zoneMatches(BLOG, 'example')).toBe(false);
    expect(zoneMatches(BLOG, '   ')).toBe(true);
  });
});

describe('matchRange', () => {
  it('finds the matched part of a name for highlighting', () => {
    expect(matchRange('shop.example.com', 'Exam')).toEqual([5, 9]);
    expect(matchRange('shop.example.com', 'blog')).toBeNull();
    expect(matchRange('shop.example.com', '')).toBeNull();
  });
});

describe('filterZoneGroups', () => {
  const groups = [
    { accountId: 'a', zones: [SHOP, BLOG], error: null },
    { accountId: 'b', zones: [API], error: null },
    { accountId: 'c', zones: undefined, error: null },
    { accountId: 'd', zones: undefined, error: 'Cloudflare said no' },
  ];

  it('leaves every group as it is without a query', () => {
    expect(filterZoneGroups(groups, ' ')).toEqual(groups);
  });

  it('keeps the matching zones and drops loaded groups with none', () => {
    const result = filterZoneGroups(groups, 'blog');
    expect(result.map((group) => [group.accountId, group.zones?.map((z) => z.name)])).toEqual([
      ['a', ['myblog.dev']],
      ['c', undefined],
      ['d', undefined],
    ]);
  });

  it('never hides a group that is loading or failed', () => {
    const result = filterZoneGroups(groups, 'nothing-like-this');
    expect(result.map((group) => group.accountId)).toEqual(['c', 'd']);
  });
});
