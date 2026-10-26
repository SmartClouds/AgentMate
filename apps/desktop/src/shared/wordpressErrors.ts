import type { WpErrorCode } from '@runova/core';
import { sshErrorMessage } from './sshErrors';

/**
 * Why a call to a WordPress site failed: the plugin's own codes (WpErrorCode), plus what the app
 * itself can tell, such as a reply that was not from the plugin at all (a Cloudflare challenge, a
 * host's error page) or a locked Servers vault. Electron only carries an error's message across
 * IPC, so the code rides inside it as `[wp:code]`, the way core and SSH errors do.
 */
export type WordPressErrorCode =
  | WpErrorCode
  /** The Servers vault is locked, so the site's key cannot be unsealed. */
  | 'vaultLocked'
  /** Something other than the plugin answered: a firewall, a CDN challenge, an error page. */
  | 'foreignResponse'
  /** A reply claimed to be from the plugin but its signature did not check out. */
  | 'badResponseSignature'
  /** The site's key is not the one in the connection key, or not the one saved at pairing. */
  | 'siteKeyMismatch'
  /** The site answered with a redirect, which signed calls never follow. */
  | 'redirected'
  /** The site uses plain HTTP and the user has not allowed that for it. */
  | 'plainHttpRefused'
  /** The HTTPS certificate is not trusted by this computer (self-signed, expired, wrong name). */
  | 'tlsUntrusted'
  /** The site asks for an HTTP sign-in (staging sites behind Basic auth). */
  | 'httpAuthRequired'
  | 'unreachable'
  | 'timeout'
  | 'cancelled'
  /** The connection key is not one Runova can read. */
  | 'keyInvalid'
  | 'keyExpired'
  /** The site's connector speaks an older protocol than this app needs. */
  | 'connectorOutdated'
  /** The request was too large even at the smallest batch size (often nginx client_max_body_size). */
  | 'bodyTooLarge'
  /** Files changed on this computer after the plan was made; plan again. */
  | 'localChanged'
  | 'planExpired'
  /** Another pull or deploy for the same site is still running. */
  | 'operationBusy'
  /** The project's item folders already hold files. */
  | 'folderNotEmpty'
  | 'siteUnknown'
  | 'projectNotLinked';

const CODES: ReadonlySet<string> = new Set<WordPressErrorCode>([
  'badRequest',
  'unauthorized',
  'badSignature',
  'staleTimestamp',
  'replayed',
  'unknownConnection',
  'revoked',
  'readOnly',
  'fileModsDisabled',
  'notDirect',
  'disabled',
  'pathRejected',
  'itemUnknown',
  'itemProtected',
  'deployUnknown',
  'conflict',
  'syntaxError',
  'busy',
  'invalidState',
  'tooLarge',
  'rateLimited',
  'pairingInvalid',
  'pairingExpired',
  'protocolMismatch',
  'updateRefused',
  'internal',
  'vaultLocked',
  'foreignResponse',
  'badResponseSignature',
  'siteKeyMismatch',
  'redirected',
  'plainHttpRefused',
  'tlsUntrusted',
  'httpAuthRequired',
  'unreachable',
  'timeout',
  'cancelled',
  'keyInvalid',
  'keyExpired',
  'connectorOutdated',
  'bodyTooLarge',
  'localChanged',
  'planExpired',
  'operationBusy',
  'folderNotEmpty',
  'siteUnknown',
  'projectNotLinked',
]);
const CODE = /\[wp:([A-Za-z]+)\]\s*/;

export function isWordPressErrorCode(value: unknown): value is WordPressErrorCode {
  return typeof value === 'string' && CODES.has(value);
}

export function encodeWordPressError(code: WordPressErrorCode, message: string): string {
  return `[wp:${code}] ${message}`;
}

/** An Error whose message carries the code, ready to throw across IPC. */
export function wordPressError(code: WordPressErrorCode, message: string): Error {
  return new Error(encodeWordPressError(code, message));
}

export function wordPressErrorCode(error: unknown): WordPressErrorCode | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(CODE)?.[1];
  return code && CODES.has(code) ? (code as WordPressErrorCode) : null;
}

/** The human part of the message, without Electron's wrapper or a code tag. */
export function wordPressErrorMessage(error: unknown): string {
  return sshErrorMessage(error).replace(CODE, '');
}
