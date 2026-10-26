import { type FilesErrorCode, filesErrorCode, filesErrorMessage } from '@shared/deployFilesErrors';
import type { FileSite, FileSiteProtocol, FilesRunState } from '@shared/deployFilesTypes';

/**
 * Words for FTP and SFTP sites in Deploy (E23): what each failure means and what to do about it,
 * and the labels the rail, the site view and the add dialog share.
 */

const PROBLEMS: Record<FilesErrorCode, string> = {
  auth: "The server didn't accept the username, password or key. Check them, then try again.",
  unreachable:
    "Couldn't reach the server. Check the host name and port, and that this computer can reach it.",
  timeout: 'The server took too long to answer. Try again in a moment.',
  hostKeyUnknown:
    "This server's host key hasn't been trusted yet. Run Test connection and compare the key with the one your host shows.",
  hostKeyChanged:
    "The server's host key is not the one you trusted. If the server was rebuilt, trust the new key; if not, don't connect.",
  tlsUntrusted:
    "This computer doesn't trust the server's certificate (self-signed, expired, or from an unknown issuer). Run Test connection to look at it and trust it for this site.",
  tlsNameMismatch:
    'The certificate is made out to another name, as on many shared hosts. Use the name it was issued for, which Test connection shows.',
  tlsUnavailable:
    "The server doesn't offer encryption (FTPS). Ask your host to turn on FTP over TLS, or use SFTP.",
  vaultLocked:
    "Your saved servers are locked with a passkey, and this site's login with them. Unlock them, then try again.",
  folderMissing:
    'The deploy folder on this computer is gone. It may have been moved or renamed, or its drive is not connected. Pick it again in Settings.',
  remoteFolderMissing:
    "The folder on the server doesn't exist. Pick another one, or create it on the server first.",
  permissionDenied:
    "The server didn't allow writing there. Check that this login can write to the folder.",
  diskFull: 'The server is out of space, or over its quota.',
  conflict: 'Files on the server changed since the review was made. Review the changes again.',
  localChanged:
    'Files changed on this computer after the review was made. Review the changes again.',
  tooManyFiles:
    'The deploy folder has too many files to track. Leave build caches and dependencies out with an ignore line.',
  planExpired: 'The review expired after 10 minutes. Review the changes again.',
  cancelled: 'Cancelled.',
  busy: 'Another deploy or test of this site is still running. Wait for it to finish.',
  siteUnknown: "Runova doesn't know this site anymore. It may have been removed.",
  projectUnknown: 'One of the attached projects no longer exists.',
  invalidInput: 'Some of the details are not valid. Check the highlighted fields.',
  exists: 'Something with that name is already there. Pick another name.',
  changedOnServer:
    'The file changed on the server since it was opened. Reload it, or overwrite the newer copy.',
  tooLarge: 'The file is too large for this.',
  notText: "The file isn't plain text, so it can't be edited here.",
  server: 'The server refused the request.',
};

/** Codes whose message from main is more specific than the fixed words: the server's own reply. */
const SPECIFIC_FROM_MAIN: ReadonlySet<FilesErrorCode> = new Set([
  'server',
  'invalidInput',
  'tlsNameMismatch',
  'permissionDenied',
]);

/** The human version of a failure from an FTP or SFTP site call; unknown ones keep their words. */
export function filesProblem(error: unknown): string {
  const code = filesErrorCode(error);
  const own = filesErrorMessage(error).trim();
  if (code && SPECIFIC_FROM_MAIN.has(code) && own.length > 0) return own;
  if (code) return PROBLEMS[code];
  return own || 'Something went wrong.';
}

/** The fixed words for a code, for a failure that arrives as a code (a run's failed files). */
export function filesProblemText(code: FilesErrorCode, message?: string | null): string {
  if (SPECIFIC_FROM_MAIN.has(code) && message?.trim()) return message.trim();
  return PROBLEMS[code];
}

export const PROTOCOL_LABEL: Record<FileSiteProtocol, string> = {
  sftp: 'SFTP',
  ftps: 'FTPS',
  ftp: 'FTP',
};

export const PROTOCOL_DESCRIPTION: Record<FileSiteProtocol, string> = {
  sftp: 'Files over SSH. Encrypted, and the usual choice when the host gives you SSH.',
  ftps: 'FTP over TLS. Encrypted, for hosts that offer FTP but not SSH.',
  ftp: 'Plain FTP. Not encrypted: your password and every file cross the network as readable text.',
};

export const DEFAULT_PORT: Record<FileSiteProtocol, number> = { sftp: 22, ftps: 21, ftp: 21 };

export const RUN_STATE_LABEL: Record<FilesRunState, string> = {
  done: 'Deployed',
  partial: 'Partly deployed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * `user@host:/root` for a login of the site's own; for a saved server, the server's nickname
 * when it is known.
 */
export function siteAddress(site: FileSite, savedServerName?: string | null): string {
  if (site.connection.kind === 'saved') {
    return `${savedServerName ?? 'Saved server'}:${site.remoteRoot}`;
  }
  const { username, host, port } = site.connection;
  const portPart = port === DEFAULT_PORT[site.protocol] ? '' : `:${port}`;
  return `${username}@${host}${portPart}:${site.remoteRoot}`;
}
