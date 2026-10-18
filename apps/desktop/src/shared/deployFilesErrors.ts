import { sshErrorMessage } from './sshErrors';

/**
 * Why an FTP or SFTP site call failed (E23). Electron only carries an error's message across IPC,
 * so the code rides inside it as `[files:code]`, the way WordPress and SSH errors do.
 */
export type FilesErrorCode =
  /** The server refused the username, password or key. */
  | 'auth'
  | 'unreachable'
  | 'timeout'
  /** A login of the site's own reached an SFTP server whose host key was never trusted. */
  | 'hostKeyUnknown'
  /** The SFTP server presented a different host key from the trusted one. */
  | 'hostKeyChanged'
  /** The FTPS certificate is not trusted here (self-signed, expired, unknown issuer). */
  | 'tlsUntrusted'
  /** The FTPS certificate is valid but for another name (common on shared hosts). */
  | 'tlsNameMismatch'
  /** The FTPS server does not offer TLS at all. */
  | 'tlsUnavailable'
  /** The Servers vault is locked, so the site's secret cannot be unsealed. */
  | 'vaultLocked'
  /** The local deploy folder is gone (moved, renamed, a drive not mounted). */
  | 'folderMissing'
  | 'remoteFolderMissing'
  | 'permissionDenied'
  | 'diskFull'
  /** The server changed since the plan was made; plan again. */
  | 'conflict'
  /** A file changed on this computer after the plan was made. */
  | 'localChanged'
  | 'tooManyFiles'
  | 'planExpired'
  | 'cancelled'
  /** Another deploy or test of the same site is running. */
  | 'busy'
  | 'siteUnknown'
  | 'projectUnknown'
  | 'invalidInput'
  /** The server answered with an error that fits none of the above. */
  | 'server';

const CODES: ReadonlySet<string> = new Set<FilesErrorCode>([
  'auth',
  'unreachable',
  'timeout',
  'hostKeyUnknown',
  'hostKeyChanged',
  'tlsUntrusted',
  'tlsNameMismatch',
  'tlsUnavailable',
  'vaultLocked',
  'folderMissing',
  'remoteFolderMissing',
  'permissionDenied',
  'diskFull',
  'conflict',
  'localChanged',
  'tooManyFiles',
  'planExpired',
  'cancelled',
  'busy',
  'siteUnknown',
  'projectUnknown',
  'invalidInput',
  'server',
]);
const CODE = /\[files:([A-Za-z]+)\]\s*/;

export function isFilesErrorCode(value: unknown): value is FilesErrorCode {
  return typeof value === 'string' && CODES.has(value);
}

export function encodeFilesError(code: FilesErrorCode, message: string): string {
  return `[files:${code}] ${message}`;
}

/** An Error whose message carries the code, ready to throw across IPC. */
export function filesError(code: FilesErrorCode, message: string): Error {
  return new Error(encodeFilesError(code, message));
}

export function filesErrorCode(error: unknown): FilesErrorCode | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(CODE)?.[1];
  return code && CODES.has(code) ? (code as FilesErrorCode) : null;
}

/** The human part of the message, without Electron's wrapper or a code tag. */
export function filesErrorMessage(error: unknown): string {
  return sshErrorMessage(error).replace(CODE, '');
}
