import { wpBase64UrlDecode, wpBase64UrlEncode, wpCanonicalPair } from '@runova/core';
import { describe, expect, it } from 'vitest';
import {
  generateWpKeyPair,
  gunzipBytes,
  gzipBytes,
  hmacSha256,
  privateKeyFromPem,
  privateKeyFromSeed,
  publicKeyFromRaw,
  randomBoundary,
  randomNonce,
  rawPublicKey,
  sha256Hex,
  signEd25519,
  verifyEd25519,
} from './crypto';
import { seedBytes as seed, WP_VECTORS } from './testing/vectors';

/**
 * The desktop's crypto against the shared protocol vectors, the same file the plugin's PHPUnit
 * suite reads, so the two sides agree byte for byte.
 */

describe('Ed25519', () => {
  it('derives the vector public keys from their seeds', () => {
    for (const vector of WP_VECTORS.ed25519) {
      expect(rawPublicKey(privateKeyFromSeed(seed(vector.seedHex)))).toBe(vector.publicKey);
    }
  });

  it('signs exactly as the vectors do, and verifies them', () => {
    for (const vector of WP_VECTORS.ed25519) {
      const key = privateKeyFromSeed(seed(vector.seedHex));
      expect(signEd25519(key, vector.message)).toBe(vector.signature);
      expect(verifyEd25519(vector.publicKey, vector.message, vector.signature)).toBe(true);
      expect(verifyEd25519(vector.publicKey, `${vector.message}!`, vector.signature)).toBe(false);
    }
  });

  it('signs the canonical request and response vectors', () => {
    for (const vector of [...WP_VECTORS.canonicalRequest, ...WP_VECTORS.canonicalResponse]) {
      const key = privateKeyFromSeed(seed(WP_VECTORS.keys[vector.signer].seedHex));
      expect(signEd25519(key, vector.text)).toBe(vector.signature);
      expect(
        verifyEd25519(WP_VECTORS.keys[vector.signer].publicKey, vector.text, vector.signature),
      ).toBe(true);
    }
  });

  it('round-trips a fresh key pair through PEM', () => {
    const pair = generateWpKeyPair();
    const key = privateKeyFromPem(pair.privateKeyPem);
    expect(rawPublicKey(key)).toBe(pair.publicKey);
    const signature = signEd25519(key, new Uint8Array([1, 2, 3]));
    expect(verifyEd25519(pair.publicKey, new Uint8Array([1, 2, 3]), signature)).toBe(true);
    expect(verifyEd25519(publicKeyFromRaw(pair.publicKey)!, 'other', signature)).toBe(false);
  });

  it('refuses keys and signatures that are not Ed25519', () => {
    const { site } = WP_VECTORS.keys;
    const good = WP_VECTORS.ed25519[0];
    expect(publicKeyFromRaw('short')).toBeNull();
    expect(publicKeyFromRaw('')).toBeNull();
    expect(verifyEd25519('nope', 'x', good.signature)).toBe(false);
    expect(verifyEd25519(site.publicKey, good.message, 'not-a-signature')).toBe(false);
    expect(verifyEd25519(site.publicKey, good.message, good.signature.slice(0, 80))).toBe(false);
    expect(() => privateKeyFromSeed(new Uint8Array(31))).toThrow('32 bytes');
    const rsa = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(10)}\n-----END PRIVATE KEY-----`;
    expect(() => privateKeyFromPem(rsa)).toThrow();
  });
});

describe('HMAC pair proof', () => {
  it('matches the vectors', () => {
    for (const vector of WP_VECTORS.pairProof) {
      expect(wpCanonicalPair(vector.input)).toBe(vector.text);
      expect(hmacSha256(vector.secret, vector.text)).toBe(vector.proof);
    }
  });

  it('refuses a secret that is not base64url', () => {
    expect(() => hmacSha256('!!!', 'x')).toThrow('base64url');
    expect(() => hmacSha256('', 'x')).toThrow('base64url');
  });
});

describe('hashes, gzip and randoms', () => {
  it('hashes and unpacks the gzip vector', () => {
    const gz = new Uint8Array(Buffer.from(WP_VECTORS.gzip.gzipHex, 'hex'));
    expect(sha256Hex(gz)).toBe(WP_VECTORS.gzip.gzipSha256);
    expect(Buffer.from(gunzipBytes(gz, 1 << 20)!).toString('hex')).toBe(WP_VECTORS.gzip.plainHex);
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('round-trips gzip and refuses a bomb or garbage', () => {
    const plain = new Uint8Array(200_000);
    const packed = gzipBytes(plain);
    expect(packed.length).toBeLessThan(2000);
    expect(gunzipBytes(packed, 200_000)?.length).toBe(200_000);
    expect(gunzipBytes(packed, 100_000)).toBeNull();
    expect(gunzipBytes(new Uint8Array([1, 2, 3]), 100)).toBeNull();
  });

  it('makes nonces and boundaries in the shapes the protocol needs', () => {
    const nonce = randomNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(wpBase64UrlDecode(nonce)?.length).toBe(16);
    expect(randomNonce()).not.toBe(nonce);
    expect(randomBoundary()).toMatch(/^am[A-Za-z0-9_-]{32}$/);
    expect(wpBase64UrlEncode(new Uint8Array([255]))).toBe('_w');
  });
});
