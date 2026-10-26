import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { wpBase64UrlDecode, wpBase64UrlEncode } from '@runova/core';

/**
 * The connector protocol's crypto on Node's own primitives (E19): Ed25519 for every request and
 * reply, HMAC-SHA256 for the pairing proof, SHA-256 for body hashes, gzip for bundles. Keys travel
 * and are stored as text: a public key as its raw 32 bytes in base64url (what the plugin and the
 * connection key carry), a private key as PKCS#8 PEM (sealed before it is written anywhere).
 */

/** PKCS#8 wrapping of a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface WpKeyPair {
  /** Raw 32-byte public key, base64url. */
  publicKey: string;
  /** PKCS#8 PEM. A secret: seal it before it goes anywhere. */
  privateKeyPem: string;
}

export function generateWpKeyPair(): WpKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: rawPublicKey(publicKey),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

/** The raw public key of a private or public Ed25519 key, base64url. */
export function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') throw new Error('That is not an Ed25519 key.');
  return jwk.x;
}

/** A private key from a 32-byte seed; the shared test vectors are written this way. */
export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error('An Ed25519 seed is 32 bytes.');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function privateKeyFromPem(pem: string): KeyObject {
  const key = createPrivateKey({ key: pem, format: 'pem' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('That is not an Ed25519 key.');
  return key;
}

/** Null when the text is not a raw 32-byte Ed25519 public key. */
export function publicKeyFromRaw(raw: string): KeyObject | null {
  if (wpBase64UrlDecode(raw)?.length !== 32) return null;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
  } catch {
    return null;
  }
}

function bytesOf(message: string | Uint8Array): Buffer {
  return typeof message === 'string' ? Buffer.from(message, 'utf-8') : Buffer.from(message);
}

/** An Ed25519 signature, base64url (86 characters). */
export function signEd25519(privateKey: KeyObject, message: string | Uint8Array): string {
  return wpBase64UrlEncode(sign(null, bytesOf(message), privateKey));
}

/** False for anything that does not check out, malformed input included. */
export function verifyEd25519(
  publicKey: string | KeyObject,
  message: string | Uint8Array,
  signature: string,
): boolean {
  const key = typeof publicKey === 'string' ? publicKeyFromRaw(publicKey) : publicKey;
  const raw = wpBase64UrlDecode(signature);
  if (!key || raw?.length !== 64) return false;
  try {
    return verify(null, bytesOf(message), key, raw);
  } catch {
    return false;
  }
}

/** HMAC-SHA256 keyed with a base64url secret, as base64url. */
export function hmacSha256(secret: string, message: string): string {
  const key = wpBase64UrlDecode(secret);
  if (!key || key.length === 0) throw new Error('That secret is not base64url.');
  return wpBase64UrlEncode(createHmac('sha256', key).update(message, 'utf-8').digest());
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes)
    .digest('hex');
}

export function gzipBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(bytes));
}

/**
 * Gunzip that refuses to grow past `maxOutput` bytes, so a small reply cannot unpack into
 * gigabytes. Null when the input is not gzip or would be too large.
 */
export function gunzipBytes(bytes: Uint8Array, maxOutput: number): Uint8Array | null {
  try {
    return new Uint8Array(gunzipSync(bytes, { maxOutputLength: maxOutput }));
  } catch {
    return null;
  }
}

/** 16 random bytes, base64url: the request nonce. */
export function randomNonce(): string {
  return wpBase64UrlEncode(randomBytes(16));
}

/** 24 random bytes, base64url: a multipart boundary nothing in a gzip body will ever match. */
export function randomBoundary(): string {
  return `am${wpBase64UrlEncode(randomBytes(24))}`;
}
