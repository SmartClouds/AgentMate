import {
  type FilesErrorCode,
  filesError,
  filesErrorCode,
  filesErrorMessage,
} from '../../shared/deployFilesErrors';
import { encodeSshError, sshErrorCode } from '../../shared/sshErrors';
import { mapSftpError } from '../deploy/files/transport/errors';
import { VaultLockedError } from '../ssh/vaultErrors';

/**
 * Every failure the SFTP file manager (E25) sends to the renderer goes through `toCodedError`,
 * so it arrives with a `[files:code]` tag (or `[ssh:code]` for the vault and host key flows)
 * and words a person can act on.
 *
 * Node's file system errors carry a string `code` (`ENOENT`), ssh2's SFTP errors a number (the
 * SFTP status), so the two sides tell themselves apart: a string code is about this computer,
 * anything else is about the server and goes to Deploy's `mapSftpError`.
 */

/** What a local errno means, worded around the path (or "the file or folder"). */
const LOCAL: Record<string, [FilesErrorCode, (subject: string) => string]> = {
  EEXIST: ['exists', (subject) => `${subject} is already there.`],
  ENOENT: ['folderMissing', (subject) => `${subject} does not exist on this computer.`],
  ENOTDIR: ['invalidInput', (subject) => `${subject} is not a folder.`],
  ENAMETOOLONG: ['invalidInput', (subject) => `The name is too long for this computer: ${subject}`],
  EACCES: ['permissionDenied', (subject) => `This computer does not allow access to ${subject}.`],
  EBUSY: ['permissionDenied', (subject) => inUse(subject)],
  // Windows answers EPERM for a file another program holds open, as well as for a real refusal.
  EPERM: ['permissionDenied', (subject) => inUse(subject)],
  ENOSPC: ['diskFull', (subject) => `This computer has no room left for ${subject}.`],
  EDQUOT: ['diskFull', (subject) => `Your disk quota has no room left for ${subject}.`],
};

/** Socket errors, which only the connection to the server can raise. */
const NETWORK: Record<string, FilesErrorCode> = {
  ECONNRESET: 'unreachable',
  ECONNABORTED: 'unreachable',
  ECONNREFUSED: 'unreachable',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  EPIPE: 'unreachable',
  ETIMEDOUT: 'timeout',
};

const NO_PATH = 'the file or folder';

function inUse(subject: string): string {
  return `${subject} is in use by another program, or this computer does not allow the change.`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return error === undefined || error === null ? 'Unknown error.' : String(error);
}

/** Starts the human part with a capital, for the messages that begin with "the file or folder". */
function capitalized(code: FilesErrorCode, message: string): Error {
  return filesError(code, message.charAt(0).toUpperCase() + message.slice(1));
}

/**
 * `error` as an Error with a code tag, about `path` when given (a remote path for SFTP failures,
 * a local one for file system errors). Already tagged errors come back as the same object, so
 * a `HostKeyChangedError` or a `FilesTransportError` keeps its class and details. A
 * `VaultLockedError` becomes `[ssh:vault-locked]`, which the page answers with the unlock dialog.
 */
export function toCodedError(error: unknown, path?: string): Error {
  if (filesErrorCode(error) || sshErrorCode(error)) {
    return error instanceof Error ? error : new Error(messageOf(error));
  }
  if (error instanceof VaultLockedError) {
    return new Error(encodeSshError('vault-locked', error.message));
  }
  const subject = path ?? NO_PATH;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') {
    const local = LOCAL[code];
    if (local) return capitalized(local[0], local[1](subject));
    const network = NETWORK[code];
    if (network) {
      return capitalized(
        network,
        `The connection to the server failed while working on ${subject}.`,
      );
    }
    return capitalized('server', `Could not work on ${subject}: ${messageOf(error)}`);
  }
  if (!(error instanceof Error)) {
    return capitalized('server', `Could not work on ${subject}: ${messageOf(error)}`);
  }
  const mapped = mapSftpError(error, subject);
  if (path !== undefined) return mapped;
  const mappedCode = filesErrorCode(mapped) ?? 'server';
  return capitalized(mappedCode, filesErrorMessage(mapped));
}

/**
 * `toCodedError` for work on this computer (main/sftp/localFs.ts): a failure without an errno,
 * such as the Trash refusing an item, is still `server` but never worded as the server's.
 */
export function toLocalCodedError(error: unknown, path?: string): Error {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (error instanceof Error && typeof code !== 'string' && !filesErrorCode(error)) {
    if (!sshErrorCode(error) && !(error instanceof VaultLockedError)) {
      return capitalized('server', `Could not work on ${path ?? NO_PATH}: ${error.message}`);
    }
  }
  return toCodedError(error, path);
}
