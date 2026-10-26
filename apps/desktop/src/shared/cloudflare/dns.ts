import type { CloudflareRecordInput, CloudflareRecordType } from '../cloudflareTypes';
import { ipVersion } from './ip';

/**
 * DNS names and records as the page edits them. The renderer runs these checks as the user types
 * and the main process runs them again before anything reaches Cloudflare.
 */

export const CLOUDFLARE_RECORD_TYPES: readonly CloudflareRecordType[] = [
  'A',
  'AAAA',
  'CNAME',
  'TXT',
  'MX',
  'CAA',
  'SRV',
];

/** Only these can go through Cloudflare's proxy (the orange cloud). */
export const PROXIABLE_TYPES: ReadonlySet<string> = new Set(['A', 'AAAA', 'CNAME']);

/** The TTLs the editor offers, in seconds. 1 is Cloudflare's "Auto". */
export const TTL_CHOICES: readonly number[] = [
  1, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 43200, 86400,
];

const ID = /^[0-9a-f]{32}$/;
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]*$/;
const NOT_IN_A_HOST = /[\s/?#@:[\]\\%]/;
const SRV_NAME = /^_[a-z0-9-]+\._[a-z0-9-]+\./;
const CAA_TAGS: ReadonlySet<string> = new Set(['issue', 'issuewild', 'iodef']);

/** Zones, records, rulesets and rules all have ids of 32 lowercase hex characters. */
export function isCloudflareId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function toAscii(name: string): string | null {
  if (PRINTABLE_ASCII.test(name)) return name;
  if (NOT_IN_A_HOST.test(name)) return null;
  try {
    return new URL(`http://${name}`).hostname;
  } catch {
    return null;
  }
}

/**
 * A DNS name in lowercase ASCII (Punycode for international names), without the trailing dot,
 * or null when DNS cannot hold it. A leading `*` label is allowed only for record names.
 */
export function normalizeHostname(
  text: string,
  options: { wildcard?: boolean } = {},
): string | null {
  const name = text.endsWith('.') ? text.slice(0, -1) : text;
  if (name === '') return null;
  const ascii = toAscii(name)?.toLowerCase();
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  const valid = labels.every(
    (label, index) => LABEL.test(label) || (index === 0 && label === '*' && options.wildcard),
  );
  return valid ? ascii : null;
}

/** The full name of a record from what the user typed: "@", "www", or a full name in the zone. */
export function recordName(text: string, zoneName: string): string | null {
  const typed = text.trim().toLowerCase();
  const zone = zoneName.toLowerCase();
  if (typed === '' || typed === '@') return zone;
  const name = typed.endsWith('.') ? typed.slice(0, -1) : typed;
  const full = name === zone || name.endsWith(`.${zone}`) ? name : `${name}.${zone}`;
  return normalizeHostname(full, { wildcard: true });
}

function isWholeNumber(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

export function isValidTtl(ttl: number): boolean {
  return ttl === 1 || (Number.isInteger(ttl) && ttl >= 60 && ttl <= 86400);
}

function contentProblem(input: CloudflareRecordInput): string | null {
  switch (input.type) {
    case 'A':
      return ipVersion(input.content) === 4
        ? null
        : 'An A record needs an IPv4 address, like 203.0.113.10.';
    case 'AAAA':
      return ipVersion(input.content) === 6
        ? null
        : 'An AAAA record needs an IPv6 address, like 2001:db8::10.';
    case 'CNAME':
      return normalizeHostname(input.content)
        ? null
        : 'A CNAME record points at another name, like app.example.net.';
    case 'TXT':
      if (input.content.length === 0) return 'Enter the text for the record.';
      return input.content.length > 2048 ? 'TXT content can be up to 2048 characters.' : null;
    case 'MX':
      if (!normalizeHostname(input.content)) {
        return "Enter the mail server's name, like mail.example.com.";
      }
      return isWholeNumber(input.priority, 65535)
        ? null
        : 'The priority is a whole number from 0 to 65535.';
    case 'CAA':
      if (!isWholeNumber(input.caa.flags, 255)) {
        return 'The flags value is a number from 0 to 255, usually 0.';
      }
      if (!CAA_TAGS.has(input.caa.tag)) return 'Pick a tag: issue, issuewild or iodef.';
      return input.caa.value.length === 0 ||
        input.caa.value.length > 255 ||
        input.caa.value.includes('"')
        ? 'Enter a value such as letsencrypt.org, without quotes.'
        : null;
    case 'SRV': {
      if (!SRV_NAME.test(input.name.toLowerCase())) {
        return 'An SRV name starts with _service._protocol, like _sip._tcp.example.com.';
      }
      const { priority, weight, port, target } = input.srv;
      if (![priority, weight, port].every((value) => isWholeNumber(value, 65535))) {
        return 'The priority, weight and port are whole numbers from 0 to 65535.';
      }
      return target === '.' || normalizeHostname(target)
        ? null
        : "Enter the target server's name, like sip.example.com.";
    }
    default:
      return 'Runova edits A, AAAA, CNAME, TXT, MX, CAA and SRV records, not that type.';
  }
}

/** What is wrong with a record before it is sent, in words, or null when it can go. */
export function recordProblem(input: CloudflareRecordInput): string | null {
  if (!normalizeHostname(input.name, { wildcard: true })) {
    return 'That name cannot be used in DNS. Use letters, digits and hyphens, like app or www.';
  }
  if (!isValidTtl(input.ttl)) return 'Pick a TTL: Auto, or from 1 minute to 1 day.';
  if (input.comment !== undefined && input.comment.length > 500) {
    return 'Keep the comment under 500 characters.';
  }
  return contentProblem(input);
}
