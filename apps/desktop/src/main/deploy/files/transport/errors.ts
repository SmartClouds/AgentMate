import {
  encodeFilesError,
  type FilesErrorCode,
  filesErrorCode,
  filesErrorMessage,
} from '../../../../shared/deployFilesErrors';
import type { FilesCertificateInfo } from '../../../../shared/deployFilesTypes';
import { HostKeyChangedError } from '../../../ssh/connectConfig';
import { VaultLockedError } from '../../../ssh/vaultErrors';

/**
 * How the transports report a failure (E23): an error coded with `[files:code]`, like every
 * other FTP and SFTP site error, that can also carry what the user needs to decide on trust, the
 * host key an SFTP server presented or the certificate an FTPS server sent.
 */

export interface FilesTransportDetails {
  hostKey?: { presented: string; stored: string | null } | null;
  certificate?: FilesCertificateInfo | null;
}

export class FilesTransportError extends Error {
  readonly code: FilesErrorCode;
  readonly hostKey: { presented: string; stored: string | null } | null;
  readonly certificate: FilesCertificateInfo | null;

  constructor(code: FilesErrorCode, message: string, details: FilesTransportDetails = {}) {
    super(encodeFilesError(code, message));
    this.name = 'FilesTransportError';
    this.code = code;
    this.hostKey = details.hostKey ?? null;
    this.certificate = details.certificate ?? null;
  }
}

/** SFTP status codes (draft-ietf-secsh-filexfer-02), which ssh2 puts on `error.code`. */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;
const SFTP_NO_CONNECTION = 6;
const SFTP_CONNECTION_LOST = 7;

const DISK_FULL = /quota|no space|disk full|space left/i;
const DROPPED = /connection .*(closed|lost)|is closed|no connection|ECONNRESET|EPIPE/i;
const TIMED_OUT = /did not answer within|stopped answering|timed out/i;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An SFTP failure on `path` as a coded error. A missing path reads as a missing folder, which is
 * what it means for the calls that do not answer null for it themselves (a put, a realpath).
 */
export function mapSftpError(error: unknown, path: string): Error {
  if (filesErrorCode(error)) return error as Error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = messageOf(error);
  const coded = (files: FilesErrorCode, text: string): Error =>
    new FilesTransportError(files, text);
  if (code === SFTP_PERMISSION_DENIED || /permission denied/i.test(message)) {
    return coded('permissionDenied', `The server refused access to ${path}.`);
  }
  if (DISK_FULL.test(message)) {
    return coded('diskFull', `The server has no room left for ${path}: ${message}`);
  }
  if (code === SFTP_NO_SUCH_FILE || /no such file/i.test(message)) {
    return coded('remoteFolderMissing', `${path} is not on the server.`);
  }
  if (code === SFTP_NO_CONNECTION || code === SFTP_CONNECTION_LOST || DROPPED.test(message)) {
    return coded('unreachable', `The connection dropped while working on ${path}.`);
  }
  if (TIMED_OUT.test(message)) return coded('timeout', `${message} (${path})`);
  return coded('server', `The server could not work on ${path}: ${message}`);
}

/** A failure to log in to an SFTP server, from `SshConnection.open` or the pool. */
export function mapSshConnectError(error: unknown): FilesTransportError {
  if (error instanceof FilesTransportError) return error;
  const existing = filesErrorCode(error);
  if (existing) return new FilesTransportError(existing, filesErrorMessage(error));
  if (error instanceof HostKeyChangedError) {
    return new FilesTransportError('hostKeyChanged', filesErrorMessage(error), {
      hostKey: { presented: error.presented, stored: error.stored },
    });
  }
  if (error instanceof VaultLockedError) {
    return new FilesTransportError('vaultLocked', error.message);
  }
  const message = messageOf(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (/authentication failed/i.test(message)) return new FilesTransportError('auth', message);
  if (code === 'ENOENT' || code === 'EACCES') {
    return new FilesTransportError('auth', `The private key could not be read: ${message}`);
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || /could not reach/i.test(message)) {
    return new FilesTransportError('unreachable', message);
  }
  if (code === 'ETIMEDOUT' || TIMED_OUT.test(message)) {
    return new FilesTransportError('timeout', message);
  }
  return new FilesTransportError('server', message);
}
