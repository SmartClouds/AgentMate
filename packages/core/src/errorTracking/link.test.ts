import { describe, expect, it } from 'vitest';
import { normalizeSentryHost, parseLinkHeader } from './link.js';
import { sentryLinkHeader, sentryLinkHeaderLastPage } from './testing/sentryFixtures.js';

describe('parseLinkHeader', () => {
  it('reads the next cursor and no previous one on the first page', () => {
    expect(parseLinkHeader(sentryLinkHeader)).toEqual({
      next: '1760785200000:100:0',
      previous: null,
    });
  });

  it('reads the previous cursor and no next one on the last page', () => {
    expect(parseLinkHeader(sentryLinkHeaderLastPage)).toEqual({ next: null, previous: '0:0:1' });
  });

  it('falls back to the cursor in the URL when the attribute is missing', () => {
    const header =
      '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:100:0&limit=100>; rel="next"; results="true"';
    expect(parseLinkHeader(header)).toEqual({ next: '0:100:0', previous: null });
  });

  it('reads nothing from a missing or odd header', () => {
    expect(parseLinkHeader(null)).toEqual({ next: null, previous: null });
    expect(parseLinkHeader(undefined)).toEqual({ next: null, previous: null });
    expect(parseLinkHeader('')).toEqual({ next: null, previous: null });
    expect(parseLinkHeader('garbage; rel="next"; results="true"')).toEqual({
      next: null,
      previous: null,
    });
    // A link with results but no cursor anywhere, and one with no results attribute at all.
    expect(
      parseLinkHeader(
        '<https://sentry.io/x>; rel="next"; results="true", <https://sentry.io/y?cursor=1>; rel="previous"',
      ),
    ).toEqual({ next: null, previous: null });
    expect(parseLinkHeader('<not a url?cursor=2:0:0>; rel="next"; results="true"')).toEqual({
      next: null,
      previous: null,
    });
  });
});

describe('normalizeSentryHost', () => {
  it('accepts sentry.io in its usual spellings', () => {
    for (const input of ['sentry.io', 'https://sentry.io/', '  https://sentry.io  ', 'SENTRY.IO']) {
      expect(normalizeSentryHost(input), input).toEqual({
        baseUrl: 'https://sentry.io',
        orgSlugHint: null,
      });
    }
  });

  it('keeps a region host and does not read it as an org', () => {
    expect(normalizeSentryHost('de.sentry.io')).toEqual({
      baseUrl: 'https://de.sentry.io',
      orgSlugHint: null,
    });
    expect(normalizeSentryHost('https://us.sentry.io/api/0/')).toEqual({
      baseUrl: 'https://us.sentry.io',
      orgSlugHint: null,
    });
  });

  it('reads an org host as sentry.io plus the org slug', () => {
    expect(normalizeSentryHost('https://acme.sentry.io')).toEqual({
      baseUrl: 'https://sentry.io',
      orgSlugHint: 'acme',
    });
    expect(normalizeSentryHost('acme.sentry.io/issues/')).toEqual({
      baseUrl: 'https://sentry.io',
      orgSlugHint: 'acme',
    });
    // A deeper name such as an ingest host is sentry.io, but not an org.
    expect(normalizeSentryHost('o4501.ingest.sentry.io')).toEqual({
      baseUrl: 'https://sentry.io',
      orgSlugHint: null,
    });
  });

  it('keeps a self-hosted base without a trailing slash or the API suffix', () => {
    expect(normalizeSentryHost('https://sentry.mycorp.com/')).toEqual({
      baseUrl: 'https://sentry.mycorp.com',
      orgSlugHint: null,
    });
    expect(normalizeSentryHost('https://mycorp.com/sentry/api/0/')).toEqual({
      baseUrl: 'https://mycorp.com/sentry',
      orgSlugHint: null,
    });
    expect(normalizeSentryHost('https://glitchtip.mycorp.com:8443//')).toEqual({
      baseUrl: 'https://glitchtip.mycorp.com:8443',
      orgSlugHint: null,
    });
  });

  it('drops a query, a fragment and credentials', () => {
    expect(normalizeSentryHost('https://me:pw@sentry.mycorp.com/?x=1#y').baseUrl).toBe(
      'https://sentry.mycorp.com',
    );
  });

  it('allows plain http only to this machine', () => {
    for (const input of [
      'http://localhost:9000',
      'http://127.0.0.1:9000/',
      'http://[::1]:9000',
      'http://127.10.0.1',
    ]) {
      expect(normalizeSentryHost(input).baseUrl, input).toBe(input.replace(/\/$/, ''));
    }
    expect(() => normalizeSentryHost('http://sentry.mycorp.com')).toThrow(/https/);
  });

  it('refuses what is not a usable URL', () => {
    for (const input of ['', '   ', 'not a url', 'ftp://sentry.io', 'https://', 'sentry']) {
      expect(() => normalizeSentryHost(input), input).toThrow(/Sentry/);
    }
  });
});
