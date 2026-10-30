import {
  isWpConnectionId,
  parseWpConnectionKey,
  WP_PROTOCOL_VERSION,
  WP_ROUTES,
  type WpConnectionKey,
  type WpHelloResponse,
  type WpPairResponse,
  wpCanonicalPair,
  wpKeyTransportSecurity,
} from '@runova/core';
import { wordPressError } from '../../../shared/wordpressErrors';
import { WpClient, type WpEndpointKind, type WpHttpAuth, WpRemoteError } from './client';
import { generateWpKeyPair, hmacSha256, privateKeyFromPem, type WpKeyPair } from './crypto';
import { cleanSiteText } from './siteText';
import type { WpTransport } from './transport';

/**
 * Pairing with a site from a connection key (E19). The key carries the site's whole public key,
 * so even the first reply, `/hello`, is checked against a key the admin handed over rather than
 * one the network offered. Then this computer makes a key pair for the site and sends `/pair`
 * signed with it, with an HMAC proof of the pairing secret: the secret itself never leaves this
 * computer, and the key is good once.
 *
 * Plain HTTP to another computer is refused unless the user allowed it for this site; plain HTTP
 * to this computer (localhost, 127.x) is fine for development.
 */

export type WpTransportSecurity = 'https' | 'local-http' | 'plain-http';

/** Reads a pasted key, or throws `[wp:keyInvalid]` / `[wp:keyExpired]` without repeating it. */
export function readConnectionKey(text: string, nowSeconds: number): WpConnectionKey {
  const parsed = parseWpConnectionKey(text, nowSeconds);
  if (parsed.ok) return parsed.key;
  switch (parsed.error) {
    case 'expired':
      throw wordPressError(
        'keyExpired',
        'That connection key has expired. A key works once, for 15 minutes; make a new one in wp-admin.',
      );
    case 'version':
      throw wordPressError(
        'keyInvalid',
        'That key is for another version of Runova Connector. Update Runova and the plugin so they match.',
      );
    default:
      throw wordPressError(
        'keyInvalid',
        'That connection key is incomplete or damaged. Copy it again from Runova Connector in wp-admin.',
      );
  }
}

/** Throws `[wp:plainHttpRefused]` for plain HTTP to another computer the user has not allowed. */
export function checkPlainHttp(security: WpTransportSecurity, allowPlainHttp: boolean): void {
  if (security === 'plain-http' && !allowPlainHttp) {
    throw wordPressError(
      'plainHttpRefused',
      'This site uses plain HTTP, so anyone on the network could read what Runova sends and receives. Switch the site to HTTPS, or allow plain HTTP for it.',
    );
  }
}

/** The name the site lists this computer under: the host name, made safe, 1 to 64 characters. */
export function wpDeviceName(hostname: string): string {
  const name = cleanSiteText(hostname, 64);
  return name === '' ? 'Runova' : name;
}

/**
 * The site's rescue.php, only when it sits on the same origin as one of the key's URLs: a reply
 * cannot send signed calls anywhere else.
 */
export function sameOriginRescueUrl(
  rescueUrl: unknown,
  key: Pick<WpConnectionKey, 'siteUrl' | 'restUrl' | 'ajaxUrl'>,
): string | null {
  if (typeof rescueUrl !== 'string' || rescueUrl.length > 2048) return null;
  try {
    const url = new URL(rescueUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    const origins = [key.siteUrl, key.restUrl, key.ajaxUrl].map((value) => new URL(value).origin);
    return origins.includes(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface WpPairInput {
  /** The pasted key; never logged, stored or put in an error. */
  connectionKey: string;
  allowPlainHttp: boolean;
  httpAuth: WpHttpAuth | null;
  transport: WpTransport;
  deviceName: string;
  /** Milliseconds. */
  now?: () => number;
  signal?: AbortSignal;
}

/** What pairing learned. Everything but `keyPair.privateKeyPem` may be stored as is. */
export interface WpPairResult {
  siteUrl: string;
  restUrl: string;
  ajaxUrl: string;
  rescueUrl: string | null;
  sitePublicKey: string;
  keyLabel: string | null;
  transport: WpTransportSecurity;
  hello: WpHelloResponse;
  pair: WpPairResponse;
  keyPair: WpKeyPair;
  endpoint: WpEndpointKind | null;
  clockOffset: number;
}

function siteKeyMismatch(): Error {
  return wordPressError(
    'siteKeyMismatch',
    'The site that answered is not the one this key was made on: its key does not match. Check the address, or make a new key on the site.',
  );
}

export async function pairWithSite(input: WpPairInput): Promise<WpPairResult> {
  const now = input.now ?? Date.now;
  const key = readConnectionKey(input.connectionKey, Math.floor(now() / 1000));
  const transport = wpKeyTransportSecurity(key);
  checkPlainHttp(transport, input.allowPlainHttp);
  const endpoints = { restUrl: key.restUrl, ajaxUrl: key.ajaxUrl, rescueUrl: null };

  const helloClient = new WpClient({
    transport: input.transport,
    endpoints,
    sitePublicKey: key.sitePublicKey,
    connectionId: null,
    privateKey: null,
    httpAuth: input.httpAuth,
    now,
  });
  let hello: WpHelloResponse;
  try {
    hello = (await helloClient.call(WP_ROUTES.hello, {}, { signal: input.signal })).data;
  } catch (error) {
    if (error instanceof WpRemoteError && error.code === 'badResponseSignature') {
      throw siteKeyMismatch();
    }
    throw error;
  }
  if (typeof hello !== 'object' || hello === null || hello.sitePublicKey !== key.sitePublicKey) {
    throw siteKeyMismatch();
  }
  if (hello.protocol !== WP_PROTOCOL_VERSION) {
    throw hello.protocol < WP_PROTOCOL_VERSION
      ? wordPressError(
          'connectorOutdated',
          'The site runs an older Runova Connector. Install the plugin that comes with this version of Runova.',
        )
      : wordPressError(
          'protocolMismatch',
          'The site runs a newer Runova Connector than this app understands. Update Runova.',
        );
  }
  const clockOffset = Number.isSafeInteger(hello.serverTime)
    ? hello.serverTime - Math.floor(now() / 1000)
    : 0;

  const keyPair = generateWpKeyPair();
  const deviceName = wpDeviceName(input.deviceName);
  const pairClient = new WpClient({
    transport: input.transport,
    endpoints,
    sitePublicKey: key.sitePublicKey,
    connectionId: null,
    privateKey: privateKeyFromPem(keyPair.privateKeyPem),
    httpAuth: input.httpAuth,
    endpoint: helloClient.endpoint,
    clockOffset,
    now,
  });
  const { data: pair } = await pairClient.call(
    WP_ROUTES.pair,
    ({ timestamp, nonce }) => ({
      pairingId: key.pairingId,
      desktopPublicKey: keyPair.publicKey,
      deviceName,
      proof: hmacSha256(
        key.pairingSecret,
        wpCanonicalPair({
          pairingId: key.pairingId,
          desktopPublicKey: keyPair.publicKey,
          deviceName,
          timestamp,
          nonce,
        }),
      ),
    }),
    { signal: input.signal },
  );
  if (
    typeof pair !== 'object' ||
    pair === null ||
    typeof pair.connectionId !== 'string' ||
    !isWpConnectionId(pair.connectionId) ||
    (pair.scope !== 'read' && pair.scope !== 'write')
  ) {
    throw wordPressError(
      'internal',
      'The site answered the pairing with something Runova could not use. Update the plugin and try a new key.',
    );
  }
  return {
    siteUrl: key.siteUrl,
    restUrl: key.restUrl,
    ajaxUrl: key.ajaxUrl,
    rescueUrl: sameOriginRescueUrl(hello.rescueUrl, key),
    sitePublicKey: key.sitePublicKey,
    keyLabel: key.label ?? null,
    transport,
    hello,
    pair,
    keyPair,
    endpoint: pairClient.endpoint,
    clockOffset: pairClient.clockOffset,
  };
}
