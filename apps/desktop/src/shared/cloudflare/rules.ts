import type { CloudflareAccessTarget, CloudflareRuleSpec } from '../cloudflareTypes';
import { canonicalIp, checkCidr, ipVersion } from './ip';

/**
 * The friendly side of WAF custom rules: a few common rules picked from a form, written out in
 * Cloudflare's rules language. Every value is checked against a strict pattern before it goes
 * into an expression; nothing is escaped, so nothing can slip a clause of its own in.
 */

export interface BuiltRule {
  expression: string;
  action: 'block' | 'managed_challenge' | 'skip';
  /** An allow rule skips the custom rules after it. */
  actionParameters?: { ruleset: 'current' };
  /** Allow rules go first, so the rules after them never see the request. */
  first: boolean;
}

export type RuleBuild = { ok: true; rule: BuiltRule } | { ok: false; problem: string };

type Listed = { ok: true; values: string[] } | { ok: false; problem: string };

const COUNTRY = /^(T1|[A-Z]{2})$/;
const MAX_COUNTRIES = 250;
const MAX_ADDRESSES = 100;
const MAX_PATH = 512;
const MAX_DESCRIPTION = 120;

function countryCodes(list: string[]): Listed {
  const codes = [...new Set(list.map((code) => code.trim().toUpperCase()))];
  if (codes.length === 0) return { ok: false, problem: 'Pick at least one country.' };
  if (codes.length > MAX_COUNTRIES) {
    return { ok: false, problem: `A rule can list up to ${MAX_COUNTRIES} countries.` };
  }
  const bad = codes.find((code) => !COUNTRY.test(code));
  return bad
    ? { ok: false, problem: `${bad} is not a two-letter country code, such as US or DE.` }
    : { ok: true, values: codes };
}

/** Why a path cannot go into a rule, or null when it can. */
export function pathProblem(path: string): string | null {
  if (!path.startsWith('/')) return 'A path starts with a slash, like /wp-login.php.';
  if (path.length > MAX_PATH) return `Keep the path under ${MAX_PATH} characters.`;
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || character === '"' || character === '\\') {
      return 'A path cannot hold spaces, quotes or backslashes.';
    }
  }
  return null;
}

function addresses(list: string[]): Listed {
  const values: string[] = [];
  for (const raw of list) {
    const text = raw.trim();
    const ip = canonicalIp(text);
    if (ip) {
      values.push(ip);
      continue;
    }
    if (!text.includes('/')) {
      return { ok: false, problem: `${text} is not an IP address or a range like 203.0.113.0/24.` };
    }
    const range = checkCidr(text);
    if (!range.ok) return range;
    values.push(range.network);
  }
  const unique = [...new Set(values)];
  if (unique.length === 0) return { ok: false, problem: 'Add at least one IP address or range.' };
  if (unique.length > MAX_ADDRESSES) {
    return { ok: false, problem: `A rule can list up to ${MAX_ADDRESSES} addresses and ranges.` };
  }
  return { ok: true, values: unique };
}

export function buildRule(spec: CloudflareRuleSpec): RuleBuild {
  switch (spec.kind) {
    case 'block-countries': {
      const codes = countryCodes(spec.countries);
      if (!codes.ok) return codes;
      const list = codes.values.map((code) => `"${code}"`).join(' ');
      return {
        ok: true,
        rule: { expression: `(ip.src.country in {${list}})`, action: 'block', first: false },
      };
    }
    case 'challenge-path': {
      const problem = pathProblem(spec.path);
      if (problem) return { ok: false, problem };
      const expression =
        spec.match === 'prefix'
          ? `(starts_with(http.request.uri.path, "${spec.path}"))`
          : `(http.request.uri.path eq "${spec.path}")`;
      return { ok: true, rule: { expression, action: 'managed_challenge', first: false } };
    }
    case 'allow-ips': {
      const listed = addresses(spec.ips);
      if (!listed.ok) return listed;
      return {
        ok: true,
        rule: {
          expression: `(ip.src in {${listed.values.join(' ')}})`,
          action: 'skip',
          actionParameters: { ruleset: 'current' },
          first: true,
        },
      };
    }
    default:
      return { ok: false, problem: 'That is not a rule Runova can build.' };
  }
}

/** A description to start from, saying what the rule does. */
export function describeRule(spec: CloudflareRuleSpec): string {
  let text: string;
  if (spec.kind === 'block-countries') {
    const codes = [...new Set(spec.countries.map((code) => code.trim().toUpperCase()))];
    text = `Block ${codes.join(', ')}`;
  } else if (spec.kind === 'challenge-path') {
    text = `Challenge ${spec.path}${spec.match === 'prefix' ? ' and below' : ''}`;
  } else {
    text = `Allow ${spec.ips.map((ip) => ip.trim()).join(', ')}`;
  }
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 3)}...` : text;
}

export type AccessTargetCheck =
  | { ok: true; target: CloudflareAccessTarget; value: string }
  | { ok: false; problem: string };

const ACCESS_COUNTRY = /^(t1|[a-z]{2})$/i;
const ASN = /^AS(\d{1,10})$/i;
const RANGE_PREFIXES: Record<4 | 6, number[]> = { 4: [16, 24], 6: [32, 48, 64] };

/** What an IP access rule's value is: an address, a range, a country or a network (ASN). */
export function accessRuleTarget(value: string): AccessTargetCheck {
  const text = value.trim();
  const version = ipVersion(text);
  if (version) {
    return { ok: true, target: version === 4 ? 'ip' : 'ip6', value: canonicalIp(text) ?? text };
  }
  if (text.includes('/')) {
    const range = checkCidr(text);
    if (!range.ok) return range;
    if (!RANGE_PREFIXES[range.version].includes(range.prefix)) {
      return {
        ok: false,
        problem: 'IP access rules take /16 or /24 ranges for IPv4, and /32, /48 or /64 for IPv6.',
      };
    }
    return { ok: true, target: 'ip_range', value: range.network };
  }
  if (ACCESS_COUNTRY.test(text)) return { ok: true, target: 'country', value: text.toUpperCase() };
  const asn = text.match(ASN);
  if (asn) return { ok: true, target: 'asn', value: `AS${asn[1]}` };
  return {
    ok: false,
    problem:
      'Enter an IP address, a range like 203.0.113.0/24, a two-letter country code or an AS number like AS13335.',
  };
}
