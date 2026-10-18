import { describe, expect, it } from 'vitest';
import { redactErrorText, redactRequestUrl } from './redact.js';
import { FAKE_EMAIL, FAKE_IP, FAKE_QUERY_TOKEN } from './testing/sentryFixtures.js';

/**
 * Error text is written by the app and its libraries, so it carries whatever they had in hand:
 * a connection string, a header, a user's address. Both directions matter here: nothing personal
 * or secret survives, and the version numbers and timestamps a reader needs stay as they are.
 */

describe('redactErrorText', () => {
  it('keeps the health redaction: URL passwords, assignments and bearer tokens', () => {
    const out = redactErrorText(
      'postgres://app:pa55word@db.internal:5432/shop failed, api_key=sk_live_51abcdefghijklmnop, Authorization: Bearer abcdef1234567890',
    );
    expect(out).not.toContain('pa55word');
    expect(out).not.toContain('sk_live_51abcdefghijklmnop');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('db.internal:5432/shop');
  });

  it('masks a literal secret the caller knows', () => {
    expect(redactErrorText('echoed my-own-token-123 back', ['my-own-token-123'])).toBe(
      'echoed [redacted] back',
    );
  });

  it('masks email addresses', () => {
    const out = redactErrorText(`user ${FAKE_EMAIL} started checkout`);
    expect(out).toBe('user [email] started checkout');
  });

  it('masks IPv4 addresses', () => {
    expect(redactErrorText(`request from ${FAKE_IP} refused`)).toBe('request from [ip] refused');
    expect(redactErrorText('ECONNREFUSED 10.0.0.5:5432')).toBe('ECONNREFUSED [ip]:5432');
  });

  it('masks full, compressed and mapped IPv6 addresses', () => {
    const cases = [
      '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      '2001:db8::8a2e:370:7334',
      'fe80::1',
      '::1',
      '::ffff:192.0.2.128',
    ];
    for (const address of cases) {
      const out = redactErrorText(`connect ${address} failed`);
      expect(out, address).toBe('connect [ip] failed');
    }
  });

  it('leaves releases, versions, timestamps and card-like numbers alone', () => {
    const text =
      'release storefront-api@2.14.0 on node v22.4.0 at 2026-10-17T08:12:44.120000Z, 09:58:02, step 2.14.0.1x, id 4242424242424242, Error::new';
    expect(redactErrorText(text)).toBe(text);
  });

  it('leaves plain error prose alone', () => {
    const text = "TypeError: Cannot read properties of undefined (reading 'total')";
    expect(redactErrorText(text)).toBe(text);
  });
});

describe('redactRequestUrl', () => {
  it('drops credentials and fragment and masks every query value', () => {
    const out = redactRequestUrl(
      `https://user:secret@shop.example.com/api/checkout?token=${FAKE_QUERY_TOKEN}&step=2#pay`,
    );
    expect(out).toBe('https://shop.example.com/api/checkout?token=***&step=***');
  });

  it('keeps a non-default port and a URL with no query', () => {
    expect(redactRequestUrl('http://localhost:3000/health')).toBe('http://localhost:3000/health');
  });

  it('handles a relative URL by cutting it at the query', () => {
    expect(redactRequestUrl(`/api/cart?token=${FAKE_QUERY_TOKEN}&a=1#x`)).toBe(
      '/api/cart?token=***&a=***',
    );
    expect(redactRequestUrl('/api/cart#frag')).toBe('/api/cart');
  });

  it('redacts secrets and addresses inside the path', () => {
    const out = redactRequestUrl(`https://api.example.com/users/${FAKE_EMAIL}/orders`);
    expect(out).not.toContain(FAKE_EMAIL);
    expect(out).toContain('https://api.example.com/users/');
  });

  it('keeps a query key that has no value', () => {
    expect(redactRequestUrl('https://example.com/search?debug')).toBe(
      'https://example.com/search?debug=***',
    );
  });
});
