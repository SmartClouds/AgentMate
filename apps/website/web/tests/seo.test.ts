import { describe, expect, it } from 'vitest';
import { canonicalUrl, HOME_TITLE, pageTitle, serializeJsonLd } from '../src/lib/seo';

describe('pageTitle', () => {
  it('uses the template for a page', () => {
    expect(pageTitle('Download')).toBe('Download | Runova');
  });

  it('gives the home page its own title', () => {
    expect(pageTitle()).toBe(HOME_TITLE);
    expect(HOME_TITLE).toBe('Runova: the Agentic Development Environment');
  });
});

describe('canonicalUrl', () => {
  const site = 'https://runovahq.com';

  it('is the site plus the path, without a trailing slash', () => {
    expect(canonicalUrl(site, new URL('http://localhost:4321/features/relay/'))).toBe(
      'https://runovahq.com/features/relay',
    );
  });

  it('keeps the root slash on the home page', () => {
    expect(canonicalUrl(site, new URL('http://localhost:4321/'))).toBe('https://runovahq.com/');
  });

  it('drops every query parameter except page', () => {
    expect(canonicalUrl(site, new URL('https://x.test/blog?utm_source=a&page=2&tag=b'))).toBe(
      'https://runovahq.com/blog?page=2',
    );
  });

  it('lowercases the path', () => {
    expect(canonicalUrl(site, new URL('https://x.test/Help/Vault'))).toBe(
      'https://runovahq.com/help/vault',
    );
  });
});

describe('serializeJsonLd', () => {
  it('escapes characters that could close the script element', () => {
    const json = serializeJsonLd({ '@context': 'https://schema.org', name: '</script><b>' });
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json).name).toBe('</script><b>');
  });
});
