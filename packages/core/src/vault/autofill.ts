import { normalizeUrl } from './url.js';

/**
 * The rules one-click login uses to decide where it may type a password. Filling the wrong page
 * hands the password to whoever runs it, so these lean towards refusing.
 */

function parseWebUrl(input: string): URL | null {
  const url = normalizeUrl(input);
  if (!url || /\s/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

/** The page a one-click login opens: the first saved website that is a web page. */
export function loginTargetUrl(urls: readonly string[]): string | null {
  for (const raw of urls) {
    const url = parseWebUrl(raw);
    if (url) return url.href;
  }
  return null;
}

/**
 * Whether a login saved for `entryUrls` may be filled into the page at `pageUrl`. The page must
 * be on a saved host or a subdomain of one, on the same port when one was saved, and not on plain
 * http when the login was saved for https.
 */
export function pageMatchesEntry(pageUrl: string, entryUrls: readonly string[]): boolean {
  const page = parseWebUrl(pageUrl);
  if (!page || !/^https?:\/\//i.test(pageUrl.trim())) return false;
  const pageHost = bareHost(page);

  return entryUrls.some((raw) => {
    const saved = parseWebUrl(raw);
    if (!saved) return false;
    if (saved.protocol === 'https:' && page.protocol !== 'https:') return false;
    if (saved.port && saved.port !== page.port) return false;
    const savedHost = bareHost(saved);
    if (pageHost === savedHost) return true;
    // A subdomain only counts under a real domain, never under "com" or an IP address.
    return savedHost.includes('.') && !isIpAddress(savedHost) && pageHost.endsWith(`.${savedHost}`);
  });
}
