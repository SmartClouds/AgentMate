/**
 * A small Runova Connector client for the smoke test: pairs with a key and makes signed calls,
 * checking every reply's signature. Plain Node; it repeats the wire format on purpose, so the
 * smoke test needs no build of packages/core.
 */
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { request } from './http.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PREFIX = 'runova-wp/v1';

export function parseKey(text) {
  const compact = text.replace(/\s+/g, '');
  if (!compact.startsWith('amwp1.')) throw new Error('Not a connection key.');
  const raw = JSON.parse(Buffer.from(compact.slice(6), 'base64url').toString('utf8'));
  return {
    siteUrl: raw.u,
    restUrl: raw.r,
    ajaxUrl: raw.a,
    pairingId: raw.i,
    pairingSecret: raw.s,
    sitePublicKey: raw.k,
    scope: raw.c,
    expiresAt: raw.x,
  };
}

function encodeFrame(route, body, blobs) {
  const header = Buffer.from(
    JSON.stringify({ r: route, b: body, l: blobs.map((blob) => blob.length) }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([
    Buffer.from('AMWB1\n'),
    length,
    header,
    ...blobs.map((blob) => Buffer.from(blob)),
  ]);
}

function decodeFrame(bytes) {
  if (bytes.subarray(0, 6).toString() !== 'AMWB1\n') throw new Error('Not a frame.');
  const length = bytes.readUInt32BE(6);
  const header = JSON.parse(bytes.subarray(10, 10 + length).toString('utf8'));
  const blobs = [];
  let at = 10 + length;
  for (const size of header.l) {
    blobs.push(bytes.subarray(at, at + size));
    at += size;
  }
  if (at !== bytes.length) throw new Error('Bytes after the last blob.');
  return { route: header.r, body: header.b, blobs };
}

function multipart(auth, gzipped) {
  const boundary = b64(randomBytes(24));
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="am_auth"\r\n\r\n${auth}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.bin"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([Buffer.from(head), gzipped, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  };
}

export class SiteClient {
  constructor(keyText) {
    this.key = parseKey(keyText);
    this.sitePublic = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: this.key.sitePublicKey },
      format: 'jwk',
    });
    const pair = generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ format: 'jwk' }).x;
    this.connectionId = null;
    this.rescueUrl = null;
  }

  url(route, via) {
    if (via === 'ajax') {
      return `${this.key.ajaxUrl}?action=runova_connector&route=${encodeURIComponent(route)}`;
    }
    if (via === 'rescue') return `${this.rescueUrl}?route=${encodeURIComponent(route)}`;
    return this.key.restUrl + route;
  }

  /**
   * One signed call. Resolves to { status, verified, ok, data, error, blobs } for an envelope,
   * or { foreign: true, status, text } when something else answered (a PHP fatal page, say).
   */
  async call(route, body = {}, { via = 'rest', blobs = [], unsigned = false, extraProof } = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = b64(randomBytes(16));
    let payload = body;
    if (extraProof) payload = extraProof({ timestamp, nonce });
    const gzipped = gzipSync(encodeFrame(route, payload, blobs));
    const connection = this.connectionId;
    let signature = '-';
    if (!unsigned) {
      const text = [PREFIX, route, timestamp, nonce, connection ?? '-', sha(gzipped)].join('\n');
      signature = b64(sign(null, Buffer.from(text), this.privateKey));
    }
    const auth = ['v1', connection ?? '-', timestamp, nonce, signature].join('.');
    const form = multipart(auth, gzipped);
    const response = await request(this.url(route, via), {
      method: 'POST',
      body: form.body,
      headers: { 'content-type': form.contentType },
      redirect: 'manual',
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 6).toString() !== 'AMWR1\n') {
      return { foreign: true, status: response.status, text: bytes.toString('utf8').slice(0, 400) };
    }
    const metaLength = bytes.readUInt32BE(6);
    const meta = JSON.parse(bytes.subarray(10, 10 + metaLength).toString('utf8'));
    const gz = bytes.subarray(10 + metaLength);
    const canonical = [
      `${PREFIX}/response`,
      route,
      nonce,
      connection ?? '-',
      meta.ts,
      meta.status,
      sha(gz),
    ].join('\n');
    const verified =
      meta.sig !== '' &&
      verify(null, Buffer.from(canonical), this.sitePublic, Buffer.from(meta.sig, 'base64url'));
    const frame = decodeFrame(gunzipSync(gz));
    return {
      status: meta.status,
      verified,
      ok: frame.body.ok === true,
      data: frame.body.data,
      error: frame.body.error,
      blobs: frame.blobs,
    };
  }

  async pair(deviceName = 'Smoke test') {
    const reply = await this.call(
      '/pair',
      {},
      {
        extraProof: ({ timestamp, nonce }) => {
          const text = [
            `${PREFIX}/pair`,
            this.key.pairingId,
            this.publicKey,
            deviceName,
            timestamp,
            nonce,
          ].join('\n');
          const proof = b64(
            createHmac('sha256', Buffer.from(this.key.pairingSecret, 'base64url'))
              .update(text)
              .digest(),
          );
          return {
            pairingId: this.key.pairingId,
            desktopPublicKey: this.publicKey,
            deviceName,
            proof,
          };
        },
      },
    );
    if (!reply.ok || !reply.verified) throw new Error(`Pairing failed: ${JSON.stringify(reply)}`);
    this.connectionId = reply.data.connectionId;
    return reply.data;
  }
}

/** The deploy op for a new content of a file, as the desktop builds it. */
export function putOp(item, path, content, expected) {
  const bytes = Buffer.from(content);
  return {
    op: 'put',
    item,
    path,
    sha256: sha(bytes),
    size: bytes.length,
    expected,
    content: bytes,
  };
}

export { sha };
