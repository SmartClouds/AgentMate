import type { PageLinks, SentryHost } from './types.js';

/**
 * Sentry pages a list with a `Link` header: one link per direction, each with
 * `results="true|false"` and the `cursor` to send next. A direction with no results has no page.
 */

const LINK = /^<([^>]*)>(.*)$/s;
const ATTRIBUTE = /([a-z]+)="([^"]*)"/gi;

/** The cursor a link points at: its `cursor` attribute, else the `cursor` in its URL. */
function cursorOf(url: string, attributes: Map<string, string>): string | null {
  const cursor = attributes.get('cursor');
  if (cursor) return cursor;
  try {
    return new URL(url).searchParams.get('cursor');
  } catch {
    return null;
  }
}

/** The next and previous cursors of a Sentry `Link` header; null where `results="false"`. */
export function parseLinkHeader(header: string | null | undefined): PageLinks {
  const links: PageLinks = { next: null, previous: null };
  if (!header) return links;
  for (const part of header.split(/,\s*(?=<)/)) {
    const match = LINK.exec(part.trim());
    if (!match) continue;
    const [, url = '', rest = ''] = match;
    const attributes = new Map(
      [...rest.matchAll(ATTRIBUTE)].map(([, key = '', value = '']) => [key.toLowerCase(), value]),
    );
    const rel = attributes.get('rel');
    if ((rel !== 'next' && rel !== 'previous') || attributes.get('results') !== 'true') continue;
    links[rel] = cursorOf(url, attributes);
  }
  return links;
}

/** `us.sentry.io` and `de.sentry.io` are data regions, not organizations. */
const REGION_LABELS = new Set(['us', 'de', 'www']);
const SENTRY_SAAS = 'sentry.io';

const NOT_A_HOST =
  'That does not look like a Sentry address. Enter a host such as sentry.io or https://sentry.mycorp.com.';
const PLAIN_HTTP =
  'Use an https address for Sentry. Plain http is only allowed for a server on this machine (localhost).';

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * Cleans up the host the user typed. Throws an Error with a message for the user when it is not
 * a usable URL, or is plain http to anything but loopback.
 */
export function normalizeSentryHost(input: string): SentryHost {
  const typed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(NOT_A_HOST);
  }
  const { hostname } = url;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(NOT_A_HOST);
  // A bare word such as `sentry` is a typo far more often than an intranet host.
  if (!hostname.includes('.') && !isLoopback(hostname)) throw new Error(NOT_A_HOST);
  if (url.protocol === 'http:' && !isLoopback(hostname)) throw new Error(PLAIN_HTTP);

  if (hostname === SENTRY_SAAS || hostname.endsWith(`.${SENTRY_SAAS}`)) {
    const label = hostname.slice(0, -SENTRY_SAAS.length - 1);
    if (REGION_LABELS.has(label)) return { baseUrl: `https://${hostname}`, orgSlugHint: null };
    const isOrg = label !== '' && !label.includes('.');
    return { baseUrl: `https://${SENTRY_SAAS}`, orgSlugHint: isOrg ? label : null };
  }

  // A self-hosted base may sit under a path; the API prefix and trailing slashes are not part of it.
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/api\/0$/, '')
    .replace(/\/+$/, '');
  return { baseUrl: `${url.protocol}//${url.host}${path}`, orgSlugHint: null };
}
