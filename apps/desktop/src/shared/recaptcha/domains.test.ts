import { describe, expect, it } from 'vitest';
import { MAX_DOMAINS, normalizeDomain, parseDomainList, validateDomains } from './domains';

/**
 * reCAPTCHA keys take bare domains (no scheme, path or port). People paste whatever they have,
 * so the app turns it into what Google accepts and says plainly what it cannot use.
 */

describe('normalizeDomain', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  Example.COM  ', 'example.com'],
    ['https://www.example.com/contact?x=1#top', 'www.example.com'],
    ['http://shop.example.com:8080', 'shop.example.com'],
    ['example.com/blog', 'example.com'],
    ['example.com.', 'example.com'],
    ['*.example.com', 'example.com'],
    ['localhost', 'localhost'],
    ['http://localhost:3000', 'localhost'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['my-site.co.uk', 'my-site.co.uk'],
  ])('%s becomes %s', (input, domain) => {
    expect(normalizeDomain(input)).toEqual({ ok: true, domain });
  });

  it.each([
    ['', /Type a domain/],
    ['   ', /Type a domain/],
    ['example', /full domain/],
    ['exa mple.com', /is not a domain/],
    ['-bad.com', /is not a domain/],
    ['bad-.com', /is not a domain/],
    ['a..com', /is not a domain/],
    ['192.168.1.10', /IP address/],
    ['[::1]', /IP address/],
    ['ftp://example.com', /web address/],
    [`${'a'.repeat(64)}.com`, /is not a domain/],
  ])('refuses %j', (input, reason) => {
    const result = normalizeDomain(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe('parseDomainList', () => {
  it('splits on commas, spaces, semicolons and new lines, and drops repeats', () => {
    expect(parseDomainList('https://a.com, www.a.com;b.com\nA.com  https://www.a.com/x')).toEqual({
      domains: ['a.com', 'www.a.com', 'b.com'],
      invalid: [],
    });
  });

  it('keeps what it can use and lists what it cannot', () => {
    expect(parseDomainList('a.com nope 10.0.0.1')).toEqual({
      domains: ['a.com'],
      invalid: [
        { input: 'nope', reason: expect.stringMatching(/full domain/) },
        { input: '10.0.0.1', reason: expect.stringMatching(/IP address/) },
      ],
    });
  });

  it('gives nothing for blank text', () => {
    expect(parseDomainList(' \n , ')).toEqual({ domains: [], invalid: [] });
  });
});

describe('validateDomains', () => {
  it('accepts a clean list', () => {
    expect(validateDomains(['a.com', 'www.a.com', 'localhost'])).toBeNull();
  });

  it('wants at least one domain', () => {
    expect(validateDomains([])).toMatch(/at least one domain/);
  });

  it('refuses anything not already in the form Google takes', () => {
    expect(validateDomains(['https://a.com'])).toMatch(/https:\/\/a\.com/);
    expect(validateDomains(['A.com'])).toMatch(/A\.com/);
  });

  it('refuses repeats', () => {
    expect(validateDomains(['a.com', 'a.com'])).toMatch(/more than once/);
  });

  it(`stops at ${MAX_DOMAINS} domains`, () => {
    const many = Array.from({ length: MAX_DOMAINS + 1 }, (_, i) => `site${i}.com`);
    expect(validateDomains(many.slice(0, MAX_DOMAINS))).toBeNull();
    expect(validateDomains(many)).toMatch(/250/);
  });
});
