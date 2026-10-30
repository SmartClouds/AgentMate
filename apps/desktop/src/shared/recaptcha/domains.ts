/**
 * The domains a reCAPTCHA key works on. Google takes bare host names (subdomains of one are allowed
 * on their own), so pasted URLs, ports, paths and `*.` are trimmed off here. The renderer uses it
 * for the domain chips and the main process checks with it again before anything goes to Google.
 */

/** Google's limit per key. */
export const MAX_DOMAINS = 250;

export type DomainResult =
  | { ok: true; domain: string }
  | { ok: false; input: string; reason: string };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

function fail(input: string, reason: string): DomainResult {
  return { ok: false, input, reason };
}

export function normalizeDomain(input: string): DomainResult {
  const trimmed = input.trim();
  if (!trimmed) return fail(input, 'Type a domain, like example.com.');
  const scheme = SCHEME.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1] ?? '')) {
    return fail(trimmed, `Use a web address or just the domain, not ${scheme[1]}://.`);
  }
  // `*.` adds nothing: a key already covers every subdomain of what it lists.
  const address = (scheme ? trimmed : `http://${trimmed}`).replace('://*.', '://');
  let host: string;
  try {
    host = new URL(address).hostname;
  } catch {
    return fail(trimmed, `${trimmed} is not a domain.`);
  }
  host = host.replace(/\.$/, '');
  if (host.startsWith('[') || IPV4.test(host)) {
    return fail(trimmed, 'reCAPTCHA keys take domains, not an IP address.');
  }
  if (host === 'localhost') return { ok: true, domain: host };
  const labels = host.split('.');
  if (host.length > 253 || !labels.every((label) => LABEL.test(label))) {
    return fail(trimmed, `${trimmed} is not a domain.`);
  }
  if (labels.length < 2) return fail(trimmed, 'Type the full domain, like example.com.');
  return { ok: true, domain: host };
}

export interface DomainList {
  domains: string[];
  invalid: { input: string; reason: string }[];
}

/** Turns pasted text (one or many domains or URLs) into the domains it holds. */
export function parseDomainList(text: string): DomainList {
  const list: DomainList = { domains: [], invalid: [] };
  for (const part of text.split(/[\s,;]+/)) {
    if (!part) continue;
    const result = normalizeDomain(part);
    if (!result.ok) list.invalid.push({ input: result.input, reason: result.reason });
    else if (!list.domains.includes(result.domain)) list.domains.push(result.domain);
  }
  return list;
}

/** Checks a finished list; gives the first problem in words, or null when it is fine. */
export function validateDomains(domains: readonly string[]): string | null {
  if (domains.length === 0) return 'Add at least one domain.';
  if (domains.length > MAX_DOMAINS) return `A key takes at most ${MAX_DOMAINS} domains.`;
  const seen = new Set<string>();
  for (const domain of domains) {
    const result = normalizeDomain(domain);
    if (!result.ok || result.domain !== domain) {
      return `${domain} is not a bare domain like example.com.`;
    }
    if (seen.has(domain)) return `${domain} is listed more than once.`;
    seen.add(domain);
  }
  return null;
}
