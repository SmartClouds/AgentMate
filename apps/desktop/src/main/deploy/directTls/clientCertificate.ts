import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';

/**
 * The client certificate a device presents over direct TLS (E16): X.509 v3, self-signed with the
 * device's own P-256 key. The core trusts nothing in it but the public key, which has to be the
 * one it enrolled; the TLS handshake proves this computer holds the private half. So there is no
 * CA, nothing for the core to issue, and nothing to renew: a fresh certificate is made for every
 * connection. Node has no X.509 writer, so the few DER structures needed are written here.
 */

const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  clientAuth: '1.3.6.1.5.5.7.3.2',
} as const;

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const octetString = (value: Buffer) => tlv(0x04, value);
const bitString = (value: Buffer) => tlv(0x03, Buffer.from([0]), value);
const explicit = (number: number, inner: Buffer) => tlv(0xa0 | number, inner);

export function integer(value: Buffer): Buffer {
  // DER wants the shortest form: OpenSSL refuses leading zero bytes as illegal padding, so they
  // go, keeping one byte at least.
  let start = 0;
  while (start < value.length - 1 && value.readUInt8(start) === 0) start++;
  const minimal = value.subarray(start);
  // Unsigned: a leading zero keeps the top bit from reading as a sign.
  return tlv(
    0x02,
    minimal.readUInt8(0) & 0x80 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal,
  );
}

export function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk: number[] = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      chunk.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(at: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, '0');
  const year = at.getUTCFullYear();
  const text = `${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
  // RFC 5280: UTCTime up to 2049, GeneralizedTime from 2050.
  return year < 2050
    ? tlv(0x17, Buffer.from(`${pad(year % 100)}${text}`, 'ascii'))
    : tlv(0x18, Buffer.from(`${year}${text}`, 'ascii'));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    objectIdentifier(oid),
    ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []),
    octetString(value),
  );
}

export interface ClientCertificate {
  /** PEM, for `tls.connect({ cert })`. */
  certificate: string;
  /** The device's private key, PEM, for `tls.connect({ key })`. */
  key: string;
}

/** A certificate for the device key, valid from an hour ago (clock skew) for a day. */
export function clientCertificate(
  privateKeyPem: string,
  now = new Date(),
  serialBytes: Buffer = randomBytes(16),
): ClientCertificate {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('A device key has to be an ECDSA P-256 key.');
  }
  const publicKeyInfo = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const algorithm = sequence(objectIdentifier(OID.ecdsaWithSha256));
  const name = sequence(
    set(sequence(objectIdentifier(OID.commonName), tlv(0x0c, Buffer.from('runova-device')))),
  );
  const serial = Buffer.from(serialBytes);
  serial.writeUInt8(serial.readUInt8(0) & 0x7f, 0);
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(
      time(new Date(now.getTime() - 60 * 60_000)),
      time(new Date(now.getTime() + 24 * 60 * 60_000)),
    ),
    name,
    publicKeyInfo,
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence()),
        // digitalSignature only: 7 unused bits, then 1000 0000.
        extension(OID.keyUsage, true, tlv(0x03, Buffer.from([0x07, 0x80]))),
        extension(OID.extKeyUsage, false, sequence(objectIdentifier(OID.clientAuth))),
      ),
    ),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, algorithm, bitString(signature));
  const base64 = der.toString('base64');
  const lines: string[] = [];
  for (let at = 0; at < base64.length; at += 64) lines.push(base64.slice(at, at + 64));
  return {
    certificate: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKeyPem,
  };
}
