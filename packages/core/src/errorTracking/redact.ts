import { redactHealthText } from '../health/redact.js';

/**
 * Error text is written by the app's own code and its libraries, which is where a connection
 * string, a header or a user's address ends up. Every string the parsers keep goes through here.
 *
 * The health redaction runs first, so a password inside `user:pass@host` is gone before the email
 * pattern looks at the `@`. IPv6 runs before IPv4 so a mapped `::ffff:a.b.c.d` goes as a whole.
 * The patterns are strict on purpose: a release such as `api@2.14.0`, a version or a timestamp
 * like `09:58:02` reads as text, not as an address.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_TEXT = `${OCTET}(?:\\.${OCTET}){3}`;
const IPV4 = new RegExp(`(?<![\\w.])${IPV4_TEXT}(?!\\.?\\w)`, 'g');

const GROUP = '[0-9A-Fa-f]{1,4}';
const IPV6 = new RegExp(
  `(?<![\\w:.])(?:` +
    // Full form, eight groups.
    `(?:${GROUP}:){7}${GROUP}` +
    // Compressed with groups before the `::`, as in `2001:db8::1` or `fe80::`.
    `|(?:${GROUP}:){1,6}:(?:${GROUP}(?::${GROUP}){0,5})?` +
    // Leading `::`, as in `::1` and the mapped `::ffff:192.0.2.1`.
    `|::(?:${GROUP}:){0,5}(?:${IPV4_TEXT}|${GROUP})` +
    `)(?![\\w:])`,
  'g',
);

/** Health redaction (secrets, auth headers, URL passwords) plus emails and IP addresses. */
export function redactErrorText(text: string, knownSecrets: readonly string[] = []): string {
  return redactHealthText(text, knownSecrets)
    .replace(EMAIL, '[email]')
    .replace(IPV6, '[ip]')
    .replace(IPV4, '[ip]');
}

/** `?a=***&b=***` for the keys of a query string, or nothing when it has none. */
function maskedQuery(query: string): string {
  const keys = [...new URLSearchParams(query).keys()];
  return keys.length === 0 ? '' : `?${keys.map((key) => `${redactErrorText(key)}=***`).join('&')}`;
}

/** Scheme, host and path with every query value masked; credentials and fragment dropped. */
export function redactRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    return `${redactErrorText(base)}${maskedQuery(parsed.search)}`;
  } catch {
    // A relative URL, which is what some SDKs send: cut it at the query and the fragment.
    const [beforeFragment = ''] = url.split('#');
    const queryAt = beforeFragment.indexOf('?');
    const path = queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt);
    const query = queryAt === -1 ? '' : beforeFragment.slice(queryAt + 1);
    return `${redactErrorText(path)}${maskedQuery(query)}`;
  }
}
