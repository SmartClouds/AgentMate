import { BROWSER_CACHE_TTLS } from '@shared/cloudflare/zone';
import { describe, expect, it } from 'vitest';
import {
  accessModeLabel,
  accessTargetLabel,
  browserCacheTtlLabel,
  CACHE_LEVEL_LABELS,
  CACHE_LEVELS,
  formatRemaining,
  MIN_TLS_LABELS,
  relativeName,
  ruleActionLabel,
  splitList,
  ttlLabel,
} from './labels';

describe('Cloudflare labels', () => {
  it('writes browser cache TTLs in words', () => {
    expect(browserCacheTtlLabel(0)).toBe('Respect existing headers');
    expect(browserCacheTtlLabel(30)).toBe('30 seconds');
    expect(browserCacheTtlLabel(60)).toBe('1 minute');
    expect(browserCacheTtlLabel(1200)).toBe('20 minutes');
    expect(browserCacheTtlLabel(3600)).toBe('1 hour');
    expect(browserCacheTtlLabel(7200)).toBe('2 hours');
    expect(browserCacheTtlLabel(86400)).toBe('1 day');
    expect(browserCacheTtlLabel(691200)).toBe('8 days');
    expect(browserCacheTtlLabel(2678400)).toBe('1 month');
    expect(browserCacheTtlLabel(5356800)).toBe('2 months');
    expect(browserCacheTtlLabel(16070400)).toBe('6 months');
    expect(browserCacheTtlLabel(31536000)).toBe('1 year');
    expect(browserCacheTtlLabel(90)).toBe('90 seconds');
    // Every value Cloudflare offers has its own words.
    const labels = BROWSER_CACHE_TTLS.map(browserCacheTtlLabel);
    expect(new Set(labels).size).toBe(BROWSER_CACHE_TTLS.length);
  });

  it("names cache levels and TLS versions the way Cloudflare's dashboard does", () => {
    expect(CACHE_LEVELS).toEqual(['aggressive', 'simplified', 'basic']);
    expect(CACHE_LEVEL_LABELS.basic).toBe('No query string');
    expect(CACHE_LEVEL_LABELS.simplified).toBe('Ignore query string');
    expect(CACHE_LEVEL_LABELS.aggressive).toBe('Standard');
    expect(MIN_TLS_LABELS['1.2']).toBe('TLS 1.2');
  });

  it('writes TTLs the way people say them', () => {
    expect(ttlLabel(1)).toBe('Auto');
    expect(ttlLabel(60)).toBe('1 min');
    expect(ttlLabel(300)).toBe('5 min');
    expect(ttlLabel(3600)).toBe('1 hr');
    expect(ttlLabel(18000)).toBe('5 hr');
    expect(ttlLabel(86400)).toBe('1 day');
    expect(ttlLabel(90)).toBe('90 s');
  });

  it('shows a record name relative to its zone', () => {
    expect(relativeName('example.com', 'example.com')).toBe('@');
    expect(relativeName('www.example.com', 'example.com')).toBe('www');
    expect(relativeName('other.net', 'example.com')).toBe('other.net');
  });

  it('says how long development mode has left', () => {
    expect(formatRemaining(10800)).toBe('3 h left');
    expect(formatRemaining(5400)).toBe('1 h 30 min left');
    expect(formatRemaining(90)).toBe('2 min left');
    expect(formatRemaining(0)).toBe('');
  });

  it('names rule actions, access modes and targets in words', () => {
    expect(ruleActionLabel('block')).toBe('Block');
    expect(ruleActionLabel('managed_challenge')).toBe('Managed challenge');
    expect(ruleActionLabel('skip')).toBe('Allow (skip the other rules)');
    expect(ruleActionLabel('rewrite')).toBe('rewrite');
    expect(accessModeLabel('whitelist')).toBe('Allow');
    expect(accessModeLabel('js_challenge')).toBe('JavaScript challenge');
    expect(accessTargetLabel('ip_range')).toBe('IP range');
    expect(accessTargetLabel('asn')).toBe('Network (ASN)');
  });

  it('splits a typed list on commas, spaces and new lines', () => {
    expect(splitList('CN, RU\nIR  KP,,')).toEqual(['CN', 'RU', 'IR', 'KP']);
    expect(splitList('   ')).toEqual([]);
  });
});
