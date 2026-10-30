import { WP_PROTOCOL_PREFIX, type WpRoute } from './protocol.js';

/**
 * The exact text each side signs or proves (E19). Lines are joined with `\n` and there is no
 * trailing newline. Every field that decides what a signature is good for is in it, so a
 * signature for one route, request, connection or body is useless for any other.
 *
 * The bundle is signed by its hash, not its bytes, so checking a signature costs the same for a
 * 10 MB upload as for an empty call (the plugin may be verifying in pure PHP).
 */

const HEX_SHA256 = /^[0-9a-f]{64}$/;
/** 16 random bytes, base64url without padding. */
const NONCE = /^[A-Za-z0-9_-]{22}$/;
/** An Ed25519 signature: 64 bytes, base64url without padding. */
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
/** Starts with a letter or digit, so it can never be the `-` that means "no connection". */
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const TIMESTAMP = /^[0-9]{1,12}$/;

export function isWpNonce(value: string): boolean {
  return NONCE.test(value);
}

export function isWpConnectionId(value: string): boolean {
  return CONNECTION_ID.test(value);
}

function checkTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999_999_999_999) {
    throw new Error('A timestamp must be whole Unix seconds.');
  }
  return String(value);
}

function checkLine(name: string, value: string): string {
  if (value.length === 0 || /[\n\r]/.test(value)) {
    throw new Error(`${name} cannot be empty or hold a line break.`);
  }
  return value;
}

function checkHash(value: string): string {
  if (!HEX_SHA256.test(value)) throw new Error('A body hash must be lowercase hex SHA-256.');
  return value;
}

/** What the desktop signs with its key, and the plugin verifies, for every request. */
export function wpCanonicalRequest(parts: {
  route: WpRoute;
  timestamp: number;
  nonce: string;
  connectionId: string | null;
  /** SHA-256 of the gzip bundle exactly as sent, lowercase hex. */
  bodySha256: string;
}): string {
  return [
    WP_PROTOCOL_PREFIX,
    checkLine('The route', parts.route),
    checkTimestamp(parts.timestamp),
    checkLine('The nonce', parts.nonce),
    parts.connectionId === null ? '-' : checkLine('The connection id', parts.connectionId),
    checkHash(parts.bodySha256),
  ].join('\n');
}

/**
 * What the plugin signs with the site key for every reply, errors included. `connectionId` is the
 * one the REQUEST's am_auth carried (null for `-`), so `/hello` and `/pair` replies are signed with
 * `-` even though `/pair` creates a connection, and an error for an unknown or revoked connection
 * is signed with the id the request named.
 */
export function wpCanonicalResponse(parts: {
  route: WpRoute;
  /** The nonce of the request this answers, so an old reply cannot be replayed as a new one. */
  requestNonce: string;
  connectionId: string | null;
  timestamp: number;
  httpStatus: number;
  /** SHA-256 of the gzip payload exactly as sent, lowercase hex. */
  bodySha256: string;
}): string {
  if (!Number.isInteger(parts.httpStatus) || parts.httpStatus < 100 || parts.httpStatus > 599) {
    throw new Error('An HTTP status runs from 100 to 599.');
  }
  return [
    `${WP_PROTOCOL_PREFIX}/response`,
    checkLine('The route', parts.route),
    checkLine('The nonce', parts.requestNonce),
    parts.connectionId === null ? '-' : checkLine('The connection id', parts.connectionId),
    checkTimestamp(parts.timestamp),
    String(parts.httpStatus),
    checkHash(parts.bodySha256),
  ].join('\n');
}

/**
 * What the pair proof is an HMAC of, keyed with the pairing secret. The timestamp and nonce are
 * the ones in the request's `am_auth`, so a proof cannot be lifted into another request.
 */
export function wpCanonicalPair(parts: {
  pairingId: string;
  desktopPublicKey: string;
  deviceName: string;
  timestamp: number;
  nonce: string;
}): string {
  return [
    `${WP_PROTOCOL_PREFIX}/pair`,
    checkLine('The pairing id', parts.pairingId),
    checkLine('The public key', parts.desktopPublicKey),
    checkLine('The device name', parts.deviceName),
    checkTimestamp(parts.timestamp),
    checkLine('The nonce', parts.nonce),
  ].join('\n');
}

/** A device name the plugin accepts: 1 to 64 characters, no control characters. */
export function isValidWpDeviceName(value: string): boolean {
  const length = [...value].length;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  return length >= 1 && length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * The `am_auth` field: `v1.<connectionId>.<timestamp>.<nonce>.<signature>`, with `-` for a
 * missing connection (`/hello`, `/pair`) or signature (`/hello`). Dots separate the fields
 * because none of them can hold one, and the value has no quotes for magic quotes to slash.
 */
export interface WpRequestAuth {
  connectionId: string | null;
  timestamp: number;
  nonce: string;
  signature: string | null;
}

export function formatWpAuthField(auth: WpRequestAuth): string {
  if (auth.connectionId !== null && !CONNECTION_ID.test(auth.connectionId)) {
    throw new Error('That connection id cannot go in am_auth.');
  }
  if (!NONCE.test(auth.nonce)) throw new Error('A nonce is 16 bytes, base64url.');
  if (auth.signature !== null && !SIGNATURE.test(auth.signature)) {
    throw new Error('A signature is 64 bytes, base64url.');
  }
  return [
    'v1',
    auth.connectionId ?? '-',
    checkTimestamp(auth.timestamp),
    auth.nonce,
    auth.signature ?? '-',
  ].join('.');
}

/** Null for anything that is not exactly the format above. */
export function parseWpAuthField(value: string): WpRequestAuth | null {
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, connection, timestamp, nonce, signature] = parts;
  if (connection !== '-' && !CONNECTION_ID.test(connection)) return null;
  if (!TIMESTAMP.test(timestamp)) return null;
  if (!NONCE.test(nonce)) return null;
  if (signature !== '-' && !SIGNATURE.test(signature)) return null;
  return {
    connectionId: connection === '-' ? null : connection,
    timestamp: Number(timestamp),
    nonce,
    signature: signature === '-' ? null : signature,
  };
}
