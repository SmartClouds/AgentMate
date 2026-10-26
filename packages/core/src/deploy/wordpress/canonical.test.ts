import { describe, expect, it } from 'vitest';
import {
  formatWpAuthField,
  isValidWpDeviceName,
  isWpConnectionId,
  isWpNonce,
  parseWpAuthField,
  wpCanonicalPair,
  wpCanonicalRequest,
  wpCanonicalResponse,
} from './canonical.js';

const nonce = 'AAECAwQFBgcICQoLDA0ODw';
const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const signature = 'A'.repeat(86);

describe('canonical strings', () => {
  it('puts a dash where there is no connection yet', () => {
    expect(
      wpCanonicalRequest({
        route: '/hello',
        timestamp: 1,
        nonce,
        connectionId: null,
        bodySha256: hash,
      }),
    ).toBe(`runova-wp/v1\n/hello\n1\n${nonce}\n-\n${hash}`);
  });

  it('refuses fields that could smuggle another line in', () => {
    expect(() =>
      wpCanonicalRequest({
        route: '/hello',
        timestamp: 1,
        nonce: 'a\nb',
        connectionId: null,
        bodySha256: hash,
      }),
    ).toThrow(/line break/);
    expect(() =>
      wpCanonicalPair({
        pairingId: 'p',
        desktopPublicKey: 'k',
        deviceName: '',
        timestamp: 1,
        nonce,
      }),
    ).toThrow(/empty/);
  });

  it('refuses timestamps that are not whole seconds and hashes that are not hex', () => {
    const base = { route: '/hello' as const, nonce, connectionId: null, bodySha256: hash };
    expect(() => wpCanonicalRequest({ ...base, timestamp: 1.5 })).toThrow(/Unix seconds/);
    expect(() => wpCanonicalRequest({ ...base, timestamp: -1 })).toThrow(/Unix seconds/);
    expect(() =>
      wpCanonicalRequest({ ...base, timestamp: 1, bodySha256: hash.toUpperCase() }),
    ).toThrow(/hex/);
  });

  it('signs the HTTP status of a reply, and only real ones', () => {
    const base = {
      route: '/site/info' as const,
      requestNonce: nonce,
      connectionId: 'c1',
      timestamp: 5,
      bodySha256: hash,
    };
    expect(wpCanonicalResponse({ ...base, httpStatus: 409 }).split('\n')[5]).toBe('409');
    expect(() => wpCanonicalResponse({ ...base, httpStatus: 99 })).toThrow(/100 to 599/);
    expect(() => wpCanonicalResponse({ ...base, httpStatus: 200.5 })).toThrow(/100 to 599/);
  });
});

describe('am_auth', () => {
  it('round-trips', () => {
    const auth = { connectionId: 'abc-123', timestamp: 1_790_000_000, nonce, signature };
    expect(parseWpAuthField(formatWpAuthField(auth))).toEqual(auth);
  });

  it('refuses to write a field it could not read back', () => {
    expect(() =>
      formatWpAuthField({ connectionId: '-', timestamp: 1, nonce, signature: null }),
    ).toThrow();
    expect(() =>
      formatWpAuthField({ connectionId: null, timestamp: 1, nonce: 'x', signature: null }),
    ).toThrow();
    expect(() =>
      formatWpAuthField({ connectionId: null, timestamp: 1, nonce, signature: 'x' }),
    ).toThrow();
  });

  it('knows its pieces', () => {
    expect(isWpNonce(nonce)).toBe(true);
    expect(isWpNonce('short')).toBe(false);
    expect(isWpConnectionId('6f1c2a9e-3b7d')).toBe(true);
    expect(isWpConnectionId('-')).toBe(false);
  });
});

describe('device names', () => {
  it('take 1 to 64 characters without control characters', () => {
    expect(isValidWpDeviceName('Laptop café ✓')).toBe(true);
    expect(isValidWpDeviceName('')).toBe(false);
    expect(isValidWpDeviceName('x'.repeat(65))).toBe(false);
    expect(isValidWpDeviceName('a\tb')).toBe(false);
  });
});
