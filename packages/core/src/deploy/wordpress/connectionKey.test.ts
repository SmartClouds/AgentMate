import { describe, expect, it } from 'vitest';
import {
  formatWpConnectionKey,
  isWpBase64UrlBytes,
  parseWpConnectionKey,
  wpBase64UrlDecode,
  wpBase64UrlEncode,
  wpKeyTransportSecurity,
  wpTransportSecurity,
} from './connectionKey.js';

describe('base64url', () => {
  it('round-trips every length remainder', () => {
    for (let length = 0; length < 10; length++) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 250) & 255);
      const text = wpBase64UrlEncode(bytes);
      expect(Buffer.from(text, 'base64url')).toEqual(Buffer.from(bytes));
      expect(wpBase64UrlDecode(text)).toEqual(bytes);
    }
  });

  it('accepts exactly one spelling of each byte string', () => {
    expect(wpBase64UrlDecode('AA')).toEqual(new Uint8Array([0]));
    expect(wpBase64UrlDecode('AB')).toBeNull();
    expect(wpBase64UrlDecode('AAA')).toEqual(new Uint8Array([0, 0]));
    expect(wpBase64UrlDecode('AAB')).toBeNull();
    expect(wpBase64UrlDecode('A')).toBeNull();
    expect(wpBase64UrlDecode('AA==')).toBeNull();
    expect(wpBase64UrlDecode('A+/A')).toBeNull();
  });

  it('checks a decoded length', () => {
    expect(isWpBase64UrlBytes(wpBase64UrlEncode(new Uint8Array(32)), 32)).toBe(true);
    expect(isWpBase64UrlBytes(wpBase64UrlEncode(new Uint8Array(31)), 32)).toBe(false);
    expect(isWpBase64UrlBytes(32, 32)).toBe(false);
  });
});

describe('transport security', () => {
  it('lets plain HTTP through only to this computer', () => {
    expect(wpTransportSecurity('https://example.test')).toBe('https');
    expect(wpTransportSecurity('http://localhost:8080')).toBe('local-http');
    expect(wpTransportSecurity('http://site.localhost')).toBe('local-http');
    expect(wpTransportSecurity('http://127.0.0.1')).toBe('local-http');
    expect(wpTransportSecurity('http://[::1]:8080')).toBe('local-http');
    expect(wpTransportSecurity('http://example.test')).toBe('plain-http');
    expect(wpTransportSecurity('http://127.0.0.1.example.test')).toBe('plain-http');
    expect(wpTransportSecurity('ftp://example.test')).toBe('plain-http');
    expect(wpTransportSecurity('not a url')).toBe('plain-http');
  });

  it('gives a key the weakest of its URLs', () => {
    const https = {
      siteUrl: 'https://a.test',
      restUrl: 'https://a.test/r',
      ajaxUrl: 'https://a.test/a',
    };
    expect(wpKeyTransportSecurity(https)).toBe('https');
    expect(wpKeyTransportSecurity({ ...https, ajaxUrl: 'http://localhost/a' })).toBe('local-http');
    expect(wpKeyTransportSecurity({ ...https, restUrl: 'http://a.test/r' })).toBe('plain-http');
  });
});

describe('connection keys', () => {
  const key = {
    siteUrl: 'https://a.test',
    restUrl: 'https://a.test/wp-json/runova/v1',
    ajaxUrl: 'https://a.test/wp-admin/admin-ajax.php',
    pairingId: 'pairing-0001',
    pairingSecret: wpBase64UrlEncode(new Uint8Array(32).fill(7)),
    sitePublicKey: wpBase64UrlEncode(new Uint8Array(32).fill(9)),
    scope: 'read' as const,
    expiresAt: 2_000,
  };

  it('round-trip, dropping a blank label', () => {
    expect(parseWpConnectionKey(formatWpConnectionKey(key), 1_000)).toEqual({ ok: true, key });
    expect(parseWpConnectionKey(formatWpConnectionKey({ ...key, label: '  ' }), 1_000)).toEqual({
      ok: true,
      key,
    });
  });

  it('refuse keys that are too long, not objects, or have an over-long label', () => {
    expect(parseWpConnectionKey(`amwp1.${'A'.repeat(5000)}`, 1)).toEqual({
      ok: false,
      error: 'format',
    });
    const array = `amwp1.${wpBase64UrlEncode(new TextEncoder().encode('[1]'))}`;
    expect(parseWpConnectionKey(array, 1)).toEqual({ ok: false, error: 'format' });
    const labelled = formatWpConnectionKey({ ...key, label: 'x'.repeat(101) });
    expect(parseWpConnectionKey(labelled, 1)).toEqual({ ok: false, error: 'fields' });
  });

  it('use the clock when no time is given', () => {
    expect(parseWpConnectionKey(formatWpConnectionKey(key))).toEqual({
      ok: false,
      error: 'expired',
    });
  });
});
