import type { Organization, Thing, WebSite } from 'schema-dts';

export const SITE_NAME = 'Runova';
export const HOME_TITLE = 'Runova: the Agentic Development Environment';

/** The default Open Graph image, 1200x630, under public/. */
export const DEFAULT_OG_IMAGE = {
  path: '/og/default.png',
  width: 1200,
  height: 630,
  alt: 'Runova, the Agentic Development Environment',
};

/** Pages use the `%s | Runova` template; the home page passes no title and gets its own. */
export function pageTitle(title?: string): string {
  return title ? `${title} | ${SITE_NAME}` : HOME_TITLE;
}

/**
 * The canonical URL is the site plus the lowercased path, with no trailing slash and no query
 * string except `page` on paged lists.
 */
export function canonicalUrl(site: string | URL, url: URL): string {
  let path = url.pathname.toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const canonical = new URL(path, site);
  const page = url.searchParams.get('page');
  if (page) canonical.searchParams.set('page', page);
  return canonical.href;
}

export function organization(site: string | URL): Organization {
  return {
    '@type': 'Organization',
    '@id': new URL('/#organization', site).href,
    name: SITE_NAME,
    url: new URL('/', site).href,
    logo: new URL('/icon-512.png', site).href,
    sameAs: ['https://github.com/SmartClouds/Runova'],
  };
}

export function webSite(site: string | URL): WebSite {
  return {
    '@type': 'WebSite',
    '@id': new URL('/#website', site).href,
    name: SITE_NAME,
    url: new URL('/', site).href,
    inLanguage: 'en',
    publisher: { '@id': new URL('/#organization', site).href },
  };
}

/** One JSON-LD graph: Organization and WebSite on every page, then the page's own nodes. */
export function jsonLdGraph(site: string | URL, nodes: Thing[] = []) {
  return {
    '@context': 'https://schema.org',
    '@graph': [organization(site), webSite(site), ...nodes],
  };
}

/** JSON for a <script type="application/ld+json">, with `<` escaped so it cannot end the element. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
