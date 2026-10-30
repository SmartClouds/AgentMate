/**
 * A reference client for the website API's signed requests (scheme v1). See "Signed requests" in
 * docs/website/api-contract.md. It has no dependencies beyond node:crypto, so it runs on Node.js
 * 20 or later and on Bun.
 *
 *   const headers = signRequest({ keyId, secret, method: 'POST', url: '/api/v1/news', body });
 *   await fetch('https://runovahq.com/api/v1/news', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
 *
 * Send the body as exactly the bytes you signed. Run this file directly (`bun sign-request.ts`)
 * to check it against the contract's test vectors.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface SignInput {
  /** The key id, `rk_` and 16 hex characters. */
  keyId: string;
  /** The secret, `rnv_sk_` and 43 characters, as the API handed it out. */
  secret: string;
  method: string;
  /** The path with its query, as it will be sent: `/api/v1/news?page=2`. A full URL works too. */
  url: string;
  /** The exact body bytes, or a string sent as UTF-8. Leave it out when there is no body. */
  body?: Uint8Array | string;
  /** Unix seconds; the current time when left out. */
  timestamp?: number;
  /** Base64url without padding; 16 new random bytes when left out. */
  nonce?: string;
}

export type SignedHeaders = Record<
  'X-Runova-Key-Id' | 'X-Runova-Timestamp' | 'X-Runova-Nonce' | 'X-Runova-Content-SHA256' | 'X-Runova-Signature',
  string
>;

/** The signing key: the SHA-256 of the whole secret's UTF-8 bytes. */
export function signingKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Percent-encodes per RFC 3986: only A-Z a-z 0-9 - . _ ~ stay, with upper-case hex. */
function encode(value: string): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function decode(value: string): string {
  const spaced = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The query decoded, encoded again, and sorted by name and then value. */
export function canonicalQuery(rawQuery: string): string {
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (query === '') return '';
  return query
    .split('&')
    .map((part) => {
      const equals = part.indexOf('=');
      const name = equals < 0 ? part : part.slice(0, equals);
      const value = equals < 0 ? '' : part.slice(equals + 1);
      return [encode(decode(name)), encode(decode(value))] as const;
    })
    .sort((a, b) => compareOrdinal(a[0], b[0]) || compareOrdinal(a[1], b[1]))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

export function canonicalString(
  method: string,
  path: string,
  rawQuery: string,
  timestamp: string,
  nonce: string,
  contentSha256: string,
): string {
  return ['RUNOVA-HMAC-SHA256', method.toUpperCase(), path, canonicalQuery(rawQuery), timestamp, nonce, contentSha256].join('\n');
}

/** The five headers that sign one request. */
export function signRequest(input: SignInput): SignedHeaders {
  // Only the path and the raw query are signed, so a full URL is cut down to them.
  const withoutOrigin = input.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  const queryStart = withoutOrigin.indexOf('?');
  const path = queryStart < 0 ? withoutOrigin : withoutOrigin.slice(0, queryStart);
  const rawQuery = queryStart < 0 ? '' : withoutOrigin.slice(queryStart + 1);

  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomBytes(16).toString('base64url');
  const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : (input.body ?? new Uint8Array());
  const contentSha256 = createHash('sha256').update(body).digest('hex');

  const canonical = canonicalString(input.method, path, rawQuery, timestamp, nonce, contentSha256);
  const signature = createHmac('sha256', signingKey(input.secret)).update(canonical, 'utf8').digest('hex');
  return {
    'X-Runova-Key-Id': input.keyId,
    'X-Runova-Timestamp': timestamp,
    'X-Runova-Nonce': nonce,
    'X-Runova-Content-SHA256': contentSha256,
    'X-Runova-Signature': `v1=${signature}`,
  };
}

// The contract's test vectors. Running the file checks them and exits 1 on any difference.
if (import.meta.main ?? import.meta.url === `file://${process.argv[1]}`) {
  const secret = 'rnv_sk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
  const keyId = 'rk_00000000000000a1';
  const vectors = [
    {
      name: 'vector 1',
      input: {
        keyId,
        secret,
        method: 'POST',
        url: '/api/v1/news',
        body: '{"slug":"openssh-10-3-fixes-a-pre-auth-crash","title":"OpenSSH 10.3 fixes a pre-auth crash","category":"security","severity":"high"}',
        timestamp: 1793361600,
        nonce: 'AAECAwQFBgcICQoLDA0ODw',
      },
      signature: 'v1=ff628625fe8c31a13fda3a8c74b3e4864249c0a36c266b8698de7a89e43d4284',
    },
    {
      name: 'vector 2',
      input: {
        keyId,
        secret,
        method: 'GET',
        url: '/api/v1/news?technology=openssh&q=open+ssh&category=security&technology=nodejs&page=2',
        timestamp: 1793361600,
        nonce: 'EBESExQVFhcYGRobHB0eHw',
      },
      signature: 'v1=5e21809896d8ca8d6aa37226007ad4c786b61f5ac3756ed364e69fdee515e20e',
    },
  ];

  let failed = false;
  if (signingKey(secret).toString('hex') !== '78bc032006bcf9367830b2d91c2abf86ea4d334972e2ad6a9fd8c0e646f583bb') {
    console.error('signing key: wrong');
    failed = true;
  }
  for (const vector of vectors) {
    const actual = signRequest(vector.input)['X-Runova-Signature'];
    const ok = actual === vector.signature;
    console.log(`${vector.name}: ${ok ? 'ok' : `expected ${vector.signature}, got ${actual}`}`);
    failed ||= !ok;
  }
  process.exit(failed ? 1 : 0);
}
